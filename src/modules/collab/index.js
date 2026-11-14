/**
 * Group work: the shared note of a device, the chat of a bench, and (in the
 * browser only) notifications - SPEC "Lot collab"
 *
 *   /api/collab/notes, /api/collab/chat/:bench     see notes.js, chat.js
 *
 * The notifications are not server work: the browser turns events it already
 * receives into system notifications (public/js/modules/collab/notifications.js,
 * ARCHITECTURE §9, "Notifications"). This module only keeps the notes and the
 * chats, announces them over SSE with the audience each one is for, and
 * writes the changes to the audit trail
 *
 * `options` is a seam for the tests: now (a clock), limits (see rules.js),
 * sweepMs (the interval of the cleaning of dissolved teams' chats; 0: none)
 */
import express from 'express';
import { mountNotes } from './notes.js';
import { mountChat } from './chat.js';
import { LIMITS } from './rules.js';

const DAY_MS = 24 * 3_600_000;

export function createCollabModule({ logger, events, repos, audit, auth, services }, options = {}) {
  const log = logger.child('collab');
  const now = options.now ?? (() => Date.now());
  const limits = { ...LIMITS, ...options.limits };
  const router = express.Router();
  const json = express.json({ limit: '16kb' });
  const ctx = { repos, events, audit, auth, services, json, limits, now };

  const notes = mountNotes(router, ctx);
  const chat = mountChat(router, ctx);

  // What other modules may ask (ARCHITECTURE §7); read lazily, inside handlers
  services.collab = { notes: notes.list, noteOf: notes.noteOf };

  const sweep = () => chat.sweep().catch((err) => log.warn(`chat sweep: ${err.message}`));
  let timer = null;

  return {
    id: 'collab',
    title: 'Group work',
    enabled: true,
    router,
    chat,
    async start() {
      await sweep();
      const every = options.sweepMs ?? DAY_MS;
      if (every > 0) {
        timer = setInterval(sweep, every);
        timer.unref();
      }
    },
    shutdown() {
      clearInterval(timer);
    },
  };
}
