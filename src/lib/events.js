/**
 * Server-Sent Events hub: one-way live updates to every open browser tab
 * (console busy/free indicators, diagram reloads, Proxmox jobs, presence…)
 *
 *   events.publish(topic, data, { sticky, audience })   audience: (user) => boolean
 *   events.toUser(userId, topic, data)
 *
 * Each stream belongs to the user who opened it (`req.user`, set by the auth
 * gate). An event with an `audience` only reaches the streams whose user
 * passes it - the filter runs here, on the server, so a tab never receives
 * something its user may not see. Sticky topics remember their last payload
 * AND its audience: the replay on connect goes through the same filter
 */
export class EventHub {
  #clients = new Set();   // { res, user, ping }
  #snapshots = new Map(); // topic → { data, audience }, replayed to new subscribers
  #log;

  constructor({ logger } = {}) {
    this.#log = logger ?? { warn() {} };
  }

  handler = (req, res) => {
    const client = { res, user: req.user ?? null, ping: null };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
    });
    res.write('retry: 3000\n\n');
    for (const [topic, { data, audience }] of this.#snapshots) {
      if (this.#allowed(audience, client.user, topic)) send(res, topic, data);
    }
    this.#clients.add(client);
    client.ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => this.#drop(client));
  };

  /**
   * Broadcast. `sticky` topics are remembered and replayed on connect.
   * `audience(user)` limits who receives it; without it, every signed-in tab does
   */
  publish(topic, data, { sticky = false, audience = null } = {}) {
    if (audience !== null && typeof audience !== 'function') throw new TypeError('audience must be a function (user) => boolean');
    if (sticky) this.#snapshots.set(topic, { data, audience });
    for (const client of this.#clients) {
      if (this.#allowed(audience, client.user, topic)) send(client.res, topic, data);
    }
  }

  /** Send to every tab of one user (a control request, a personal notification) */
  toUser(userId, topic, data) {
    this.publish(topic, data, { audience: (user) => user.id === userId });
  }

  /** Forget a sticky topic (its owner went away); nothing is sent */
  clear(topic) {
    this.#snapshots.delete(topic);
  }

  /**
   * End the streams whose user matches, e.g. after a session is revoked.
   * The browser reconnects by itself and meets the auth gate again
   */
  disconnect(match = () => true) {
    let ended = 0;
    for (const client of [...this.#clients]) {
      if (!match(client.user)) continue;
      this.#drop(client);
      client.res.end();
      ended += 1;
    }
    return ended;
  }

  /** Number of open streams, optionally for one user */
  count(userId) {
    if (userId === undefined) return this.#clients.size;
    let n = 0;
    for (const c of this.#clients) if (c.user?.id === userId) n += 1;
    return n;
  }

  /** Shutdown: end every stream so the HTTP server can close */
  close() {
    this.disconnect();
  }

  #drop(client) {
    clearInterval(client.ping);
    this.#clients.delete(client);
  }

  // An audience that throws must not break the publisher nor leak the event:
  // the answer is "no". A filtered event never reaches a stream without a user
  #allowed(audience, user, topic) {
    if (!audience) return true;
    if (!user) return false;
    try {
      return Boolean(audience(user));
    } catch (err) {
      this.#log.warn(`audience filter of ${topic} failed: ${err.message}`);
      return false;
    }
  }
}

function send(res, topic, data) {
  res.write(`event: ${topic}\ndata: ${JSON.stringify(data)}\n\n`);
}
