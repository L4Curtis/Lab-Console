/**
 * The script library: who may see and change which script (SPEC "Lot terminal").
 *
 *   personal    the person's own; nobody else sees it, administrators included
 *               (a script may hold a password the person typed once)
 *   team        the team's; every member reads and changes it. An administrator
 *               also sees and changes team scripts (a dissolved team's too), to
 *               tidy up
 *   published   an administrator's, for everybody signed in; only administrators change it
 *
 * Reading a script that is not visible to the caller answers "unknown", like a
 * script that does not exist: the library does not tell who keeps what. Changing
 * a visible script one may not change is a refusal ("forbidden"). Every
 * failure is a LibraryError { status, code, params } that the router turns
 * into the API's error shape
 */
import { newId } from '../../lib/db/values.js';

export const LIMITS = Object.freeze({
  title: 80,
  description: 300,
  bodyBytes: 64 * 1024,
  perShelf: { personal: 100, team: 100, published: 300 },
});
export const SCOPES = Object.freeze(['personal', 'team', 'published']);

export class LibraryError extends Error {
  constructor(status, code, message, params = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/** A control character other than tab and line feed (`allowLineFeed`: a text of several lines) */
function hasControl(text, { allowLineFeed = false } = {}) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code < 32 && code !== 9 && !(allowLineFeed && code === 10)) || code === 127) return true;
  }
  return false;
}

/** Line breaks as \n, no trailing spaces, as the injection reads them; the number of lines is what parseScript would send */
function cleanBody(raw) {
  if (typeof raw !== 'string') throw new LibraryError(400, 'scripts.bad_body', 'The script text is missing');
  const body = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  if (!body.trim()) throw new LibraryError(400, 'scripts.bad_body', 'The script is empty');
  if (hasControl(body, { allowLineFeed: true })) throw new LibraryError(400, 'scripts.bad_body', 'The script holds control characters');
  if (Buffer.byteLength(body) > LIMITS.bodyBytes) throw new LibraryError(413, 'scripts.body_too_large', `The script is larger than ${LIMITS.bodyBytes / 1024} KB`, { max: LIMITS.bodyBytes / 1024 });
  const lines = body.endsWith('\n') ? body.split('\n').length - 1 : body.split('\n').length;
  return { body, lines };
}

function cleanTitle(raw) {
  const title = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!title || hasControl(title)) throw new LibraryError(400, 'scripts.bad_title', 'A script needs a title', { max: LIMITS.title });
  if (title.length > LIMITS.title) throw new LibraryError(400, 'scripts.bad_title', `The title is longer than ${LIMITS.title} characters`, { max: LIMITS.title });
  return title;
}

function cleanDescription(raw) {
  if (raw === undefined || raw === null) return '';
  const description = typeof raw === 'string' ? raw.trim() : null;
  if (description === null || hasControl(description, { allowLineFeed: true })) throw new LibraryError(400, 'scripts.bad_description', 'The description is not text', { max: LIMITS.description });
  if (description.length > LIMITS.description) throw new LibraryError(400, 'scripts.bad_description', `The description is longer than ${LIMITS.description} characters`, { max: LIMITS.description });
  return description;
}

export class ScriptLibrary {
  /**
   * @param repos    the repositories (repos.scripts)
   * @param teamOf   (user) → { id, name } | null: the team the user is in
   * @param teamName (teamId) → name | null (a dissolved team has none)
   */
  constructor({ repos, teamOf = () => null, teamName = () => null }) {
    this.repo = repos.scripts;
    this.teamOf = (user) => {
      try { return teamOf(user) ?? null; } catch { return null; }
    };
    this.teamName = (id) => {
      try { return teamName(id) ?? null; } catch { return null; }
    };
  }

  #isAdmin = (user) => user?.role === 'admin';

  /** May `user` read this script? */
  canSee(user, s) {
    if (s.scope === 'published') return true;
    if (s.scope === 'personal') return s.ownerId === user.id;
    return this.#isAdmin(user) || this.teamOf(user)?.id === s.teamId;
  }

  /** May `user` change or delete it? */
  canEdit(user, s) {
    if (s.scope === 'published') return this.#isAdmin(user);
    return this.canSee(user, s);
  }

  #present(user, s) {
    return {
      id: s.id, scope: s.scope, title: s.title, description: s.description, lines: s.lines,
      author: { id: s.ownerId, name: s.ownerName },
      team: s.scope === 'team' ? { id: s.teamId, name: this.teamName(s.teamId) } : null,
      createdAt: s.createdAt, updatedAt: s.updatedAt, updatedBy: s.updatedBy,
      mine: s.ownerId === user.id,
      canEdit: this.canEdit(user, s),
      ...(s.body === undefined ? {} : { body: s.body }),
    };
  }

  #shelfOf(user, scope) {
    if (scope === 'published') return { shelf: 'pub', teamId: null };
    if (scope === 'personal') return { shelf: `p:${user.id}`, teamId: null };
    const team = this.teamOf(user);
    return { shelf: `t:${team.id}`, teamId: team.id };
  }

  /** What the person may see, without the texts: { scripts, team, canPublish, limits } */
  async list(user) {
    const team = this.teamOf(user);
    const rows = await this.repo.visibleTo({ userId: user.id, teamId: team?.id ?? null, allTeams: this.#isAdmin(user) });
    return {
      scripts: rows.map((s) => this.#present(user, s)),
      team: team ? { id: team.id, name: team.name } : null,
      canPublish: this.#isAdmin(user),
      limits: { title: LIMITS.title, description: LIMITS.description, bodyKb: LIMITS.bodyBytes / 1024 },
    };
  }

  async #visible(user, id) {
    const s = await this.repo.get(id);
    if (!s || !this.canSee(user, s)) throw new LibraryError(404, 'scripts.unknown', 'This script does not exist (any more)');
    return s;
  }

  async get(user, id) {
    return this.#present(user, await this.#visible(user, id));
  }

  /** input: { scope, title, description?, body } */
  async create(user, input = {}) {
    const scope = input.scope ?? 'personal';
    if (!SCOPES.includes(scope)) throw new LibraryError(400, 'scripts.bad_scope', 'Unknown shelf');
    if (scope === 'published' && !this.#isAdmin(user)) throw new LibraryError(403, 'scripts.admin_only', 'Only administrators publish scripts');
    if (scope === 'team' && !this.teamOf(user)) throw new LibraryError(409, 'scripts.no_team', 'You are not in a team');
    const title = cleanTitle(input.title);
    const description = cleanDescription(input.description);
    const { body, lines } = cleanBody(input.body);
    const { shelf, teamId } = this.#shelfOf(user, scope);
    if (await this.repo.countOn(shelf) >= LIMITS.perShelf[scope]) {
      throw new LibraryError(409, 'scripts.shelf_full', `This shelf already holds ${LIMITS.perShelf[scope]} scripts`, { max: LIMITS.perShelf[scope] });
    }
    const name = user.name || user.username || user.id;
    const script = { id: newId(), scope, shelf, teamId, ownerId: user.id, ownerName: name, title, description, body, lines, updatedBy: name };
    await this.#store(() => this.repo.insert(script), title);
    return this.#present(user, await this.repo.get(script.id));
  }

  /** patch: { title?, description?, body?, updatedAt? } - `updatedAt` is the version the editor started from */
  async update(user, id, patch = {}) {
    const before = await this.#visible(user, id);
    if (!this.canEdit(user, before)) throw new LibraryError(403, 'scripts.forbidden', 'You may read this script, not change it');
    if (patch.updatedAt !== undefined && patch.updatedAt !== before.updatedAt) {
      throw new LibraryError(409, 'scripts.conflict', 'Somebody changed this script meanwhile: reload it', { by: before.updatedBy });
    }
    const title = patch.title === undefined ? before.title : cleanTitle(patch.title);
    const description = patch.description === undefined ? before.description : cleanDescription(patch.description);
    const { body, lines } = patch.body === undefined ? { body: before.body, lines: before.lines } : cleanBody(patch.body);
    await this.#store(() => this.repo.update(id, { title, description, body, lines, updatedBy: user.name || user.username || user.id }), title);
    return this.#present(user, await this.repo.get(id));
  }

  /** → the script that was deleted (for the audit trail) */
  async remove(user, id) {
    const s = await this.#visible(user, id);
    if (!this.canEdit(user, s)) throw new LibraryError(403, 'scripts.forbidden', 'You may read this script, not delete it');
    await this.repo.remove(id);
    return s;
  }

  async #store(write, title) {
    try {
      return await write();
    } catch (err) {
      if (err.code === 'db.unique') throw new LibraryError(409, 'scripts.duplicate_title', `A script called "${title}" is already on this shelf`, { title });
      throw err;
    }
  }
}
