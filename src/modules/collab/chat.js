/**
 * The chat of a bench (SPEC "Lot collab")
 *
 * A small text chat for the people working on a bench. It belongs to the team
 * that holds the bench (SPEC "Lot teams": chat is kept with the team): the
 * thread is the one of (holder team, bench), shared by the team's members and
 * the bench's guests. When the bench is released and taken again by the same
 * team, the conversation is still there; another team starts a fresh one. A
 * thread keeps its last 200 messages; a team that is dissolved loses its
 * threads (sweep())
 *
 *   GET    /api/collab/chat/:bench        the thread (occupants; admins read it)
 *   POST   /api/collab/chat/:bench        { text } - occupants only, 10 messages per 20 s per person
 *   DELETE /api/collab/chat/:bench/:id    admins: take a message down (whoever holds the bench, or nobody)
 *
 * Plain text, 500 characters and 6 lines at most: no markup, no files.
 * SSE `collab:chat` reaches the bench's occupants and the admins, nobody
 * else: { bench, message } or { bench, removed: id }. The audience is the
 * occupancy at the moment of the post
 */
import { httpError } from '../../lib/httpError.js';
import { initialsOf, colorOf } from '../auth/user.js';
import { cleanText, createUserLimiter, rateLimited } from './rules.js';

const isAdmin = (user) => user?.role === 'admin';

export function mountChat(router, { repos, events, audit, auth, services, json, limits, now }) {
  const limiter = createUserLimiter({ limit: limits.chatPerWindow, windowMs: limits.chatWindowMs, now });
  const isOccupant = (user, bench) => Boolean(services.benches?.isOccupant?.(user, bench));
  const holderTeam = (bench) => services.benches?.holder?.(bench)?.teamId ?? null;

  function benchOf(req) {
    const bench = String(req.params.bench ?? '');
    if (!services.consoles?.registry?.model.labs.some((l) => l.name === bench)) {
      throw httpError(404, 'collab.unknown_bench', 'This bench does not exist', { bench });
    }
    return bench;
  }

  /** A stored message as the browser sees it: the author with the badge colours every other screen uses */
  const view = (m) => ({ ...m, author: { ...m.author, initials: initialsOf(m.author.name), color: colorOf(m.author.id) } });

  router.get('/chat/:bench', async (req, res) => {
    const bench = benchOf(req);
    const occupant = isOccupant(req.user, bench);
    if (!occupant && !isAdmin(req.user)) throw httpError(403, 'collab.chat_forbidden', 'Only the occupants of this bench read its chat', { bench });
    const teamId = holderTeam(bench);
    const messages = teamId ? await repos.collab.messages(teamId, bench, limits.chatHistory) : [];
    res.set('Cache-Control', 'no-store').json({
      bench,
      messages: messages.map(view),
      canPost: occupant,
      limits: { maxChars: limits.chatChars, maxLines: limits.chatLines, history: limits.chatHistory },
    });
  });

  router.post('/chat/:bench', json, async (req, res) => {
    const bench = benchOf(req);
    const teamId = holderTeam(bench);
    if (!teamId || !isOccupant(req.user, bench)) throw httpError(403, 'collab.chat_forbidden', 'Only the occupants of this bench write in its chat', { bench });
    const text = cleanText(req.body?.text, { max: limits.chatChars, maxLines: limits.chatLines });
    if (!text) throw httpError(400, 'collab.empty_message', 'The message is empty');
    const wait = limiter.hit(req.user.id);
    if (wait) throw rateLimited(wait);

    const message = view(await repos.collab.addMessage({
      teamId, bench, text, at: now(), author: { id: req.user.id, name: req.user.name || req.user.username || req.user.id },
    }, limits.chatHistory));
    events.publish('collab:chat', { bench, message }, { audience: (u) => isAdmin(u) || isOccupant(u, bench) });
    res.status(201).json({ message });
  });

  router.delete('/chat/:bench/:id', auth.requireRole('admin'), async (req, res) => {
    const bench = benchOf(req);
    const id = String(req.params.id);
    if (!(await repos.collab.removeMessage(bench, id))) throw httpError(404, 'collab.unknown_message', 'This message does not exist (any more)');
    audit.log(req, 'collab.chat.delete', { bench, messageId: id });
    events.publish('collab:chat', { bench, removed: id }, { audience: (u) => isAdmin(u) || isOccupant(u, bench) });
    res.json({ ok: true });
  });

  return {
    /** Forget the threads of teams that no longer exist (judged on the teams table: independent of module order); → the number of teams cleaned */
    sweep: () => repos.collab.removeOrphanThreads(),
  };
}
