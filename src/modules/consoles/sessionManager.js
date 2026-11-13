/**
 * Bookkeeping for every live console session:
 *   - global and per-client limits,
 *   - one session per physical console line (a terminal-server port only
 *     accepts one telnet client - refusing early gives a clear message
 *     instead of a cryptic "Connection refused"),
 *   - idle timeout so forgotten tabs don't hold a lab device hostage,
 *   - a live "which consoles are busy" feed for the diagrams
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export class SessionManager extends EventEmitter {
  #sessions = new Map(); // id → { session, device, clientId, openedAt }
  #byTarget = new Map(); // "host:port" → id

  constructor({ limits, logger }) {
    super();
    this.limits = limits;
    this.log = logger;
    setInterval(() => this.#sweepIdle(), 30_000).unref();
  }

  /** @returns {{ok: true} | {ok: false, reason: string, code: string, params: object}} - `code`/`params` let the browser translate `reason` */
  canOpen(device, clientId) {
    if (this.#byTarget.has(targetKey(device.target))) {
      const holder = this.#sessions.get(this.#byTarget.get(targetKey(device.target)));
      const since = holder ? new Date(holder.openedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
      return {
        ok: false,
        reason: `${device.name}'s console is already in use by another session${since ? ` (since ${since})` : ''}`,
        code: since ? 'consoles.line_busy_since' : 'consoles.line_busy',
        params: { name: device.name, since },
      };
    }
    if (this.#sessions.size >= this.limits.maxSessions) {
      return { ok: false, reason: 'The platform has reached its maximum number of open consoles. Try again shortly.', code: 'consoles.platform_full', params: {} };
    }
    const mine = [...this.#sessions.values()].filter((s) => s.clientId === clientId).length;
    if (mine >= this.limits.maxSessionsPerClient) {
      return {
        ok: false,
        reason: `You can keep at most ${this.limits.maxSessionsPerClient} consoles open. Close one first.`,
        code: 'consoles.client_full',
        params: { max: this.limits.maxSessionsPerClient },
      };
    }
    return { ok: true };
  }

  register(session, device, clientId) {
    const id = crypto.randomUUID();
    this.#sessions.set(id, { session, device, clientId, openedAt: Date.now() });
    this.#byTarget.set(targetKey(device.target), id);
    session.once('close', ({ reason }) => {
      this.#sessions.delete(id);
      this.#byTarget.delete(targetKey(device.target));
      this.log.info(`closed ${device.labName}/${device.name} (${reason}) - ${this.#sessions.size} open`);
      this.#publish();
    });
    this.log.info(`opened ${device.labName}/${device.name} ${targetKey(device.target)} for ${clientId} - ${this.#sessions.size} open`);
    this.#publish();
    return id;
  }

  busyTargets() {
    return [...this.#byTarget.keys()];
  }

  closeAll(reason, info) {
    for (const { session } of this.#sessions.values()) session.close(reason, null, info);
  }

  #sweepIdle() {
    const now = Date.now();
    for (const { session, device } of this.#sessions.values()) {
      if (now - session.lastActivity > this.limits.idleTimeoutMs) {
        const minutes = Math.round(this.limits.idleTimeoutMs / 60_000);
        session.close(`Closed after ${minutes} minutes without input - ${device.name}'s console is free again`, null,
          { code: 'consoles.idle_timeout', params: { minutes, name: device.name } });
      }
    }
  }

  #publish() {
    this.emit('busy', this.busyTargets());
  }
}

export const targetKey = (t) => `${t.host}:${t.port}`;
