/**
 * Benches: who holds each bench of the diagram, who may work on it, and when
 * (SPEC "Lot teams")
 *
 * A member takes a free bench for their team: every member is then an
 * occupant. Someone outside the team asks to join and any member accepts or
 * refuses; an accepted guest stays an occupant until they leave or the bench
 * is released. A bench is released by hand, by an admin, or after
 * BENCH_IDLE_HOURS without activity. An admin may lock a bench with a reason:
 * nobody but admins works on it until they lift the lock. Teams book slots in
 * a per-bench calendar; at the start of its slot the team may take the bench,
 * and the occupants of the moment are warned ten minutes before
 *
 * The permission rule that the consoles and the jobs ask (canPilot,
 * canOperate) lives here and nowhere else.
 *
 * Documents (ARCHITECTURE §10), all small enough to keep in memory:
 *   benches/occupancy.json     { [bench]: { teamId, since, by, lastActivity, guests: [Person], requests: [Person + at] } }
 *   benches/locks.json         { [bench]: { reason, by: Person, at } }
 *   benches/reservations.json  { reservations: [{ id, bench, teamId, start, end, by, createdAt, warnedAt?, startedAt? }] }
 *
 * Time comes from an injectable clock and the periodic work is one public
 * method, tick(), so the tests drive both
 */
import crypto from 'node:crypto';
import { httpError } from '../../lib/httpError.js';
import { personOf } from './teams.js';

export const WARNING_MINUTES = 10;
const MAX_REQUESTS = 20;
const TOUCH_WRITE_MS = 60_000; // activity is written at most once a minute per bench
const SLOT_STEP_MINUTES = 15;
const HOUR = 3_600_000;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

const targetKey = (t) => (t ? `${t.host}:${t.port}` : null);
const iso = (ms) => new Date(ms).toISOString();
const isAdmin = (user) => user?.role === 'admin';

export class Benches {
  #occ;
  #locks;
  #resv;
  #teams;
  #services;
  #events;
  #audit;
  #log;
  #now;
  #idleMs;
  #limits;
  #releaseHandlers = new Set();
  #lastWrite = new Map(); // bench → ms of the last activity written
  #published = null;       // bench names of the last state published

  constructor({ store, teams, services, events, audit, logger, config, now = () => Date.now() }) {
    this.#occ = store.json('benches/occupancy.json', {});
    this.#locks = store.json('benches/locks.json', {});
    this.#resv = store.json('benches/reservations.json', { reservations: [] });
    this.#teams = teams;
    this.#services = services;
    this.#events = events;
    this.#audit = audit;
    this.#log = logger;
    this.#now = now;
    this.#idleMs = (config?.idleHours ?? 3) * HOUR;
    this.#limits = { maxFuture: 2, maxHours: 4, maxDaysAhead: 14, ...config?.reservations };
  }

  get idleHours() { return this.#idleMs / HOUR; }
  get limits() { return { ...this.#limits }; }
  get hasReleaseHandlers() { return this.#releaseHandlers.size > 0; }

  // ── The diagram, read lazily from the consoles module ─────────────────────

  #labs() {
    return this.#services.consoles?.registry?.model?.labs ?? [];
  }

  /** Bench names of the diagram, in its order */
  names() {
    return this.#labs().map((l) => l.name);
  }

  /** The bench, or a 404 */
  bench(name) {
    if (typeof name !== 'string' || !this.names().includes(name)) {
      throw httpError(404, 'benches.unknown', 'This bench does not exist', { bench: String(name ?? '') });
    }
    return name;
  }

  /**
   * The benches a device belongs to: its own page, plus every page that has
   * a device on the same console line (a device shared by several benches)
   */
  benchesOfDevice(device) {
    if (!device) return [];
    const known = device.key ? this.#services.consoles?.registry?.getDevice?.(device.key) : null;
    const own = device.labName ?? known?.labName;
    const target = targetKey(device.target ?? known?.target);
    const names = new Set();
    for (const lab of this.#labs()) {
      if (lab.name === own || (target && lab.devices?.some((d) => targetKey(d.target) === target))) names.add(lab.name);
    }
    return [...names];
  }

  // ── Questions other modules ask (services.benches) ────────────────────────

  #occupancy(name) {
    return this.#occ.get()[name] ?? null;
  }

  holder(name) {
    const o = this.#occupancy(name);
    return o ? { teamId: o.teamId, since: o.since } : null;
  }

  /** Team members and accepted guests, as user ids */
  occupants(name) {
    const o = this.#occupancy(name);
    if (!o) return [];
    const team = this.#teams.get(o.teamId);
    return [...new Set([...(team?.members ?? []), ...(o.guests ?? []).map((g) => g.id)])];
  }

  isOccupant(user, name) {
    return Boolean(user?.id) && this.occupants(name).includes(user.id);
  }

  isHolderMember(user, name) {
    const o = this.#occupancy(name);
    return Boolean(o && user && this.#teams.isMember(user, o.teamId));
  }

  lock(name) {
    return this.#locks.get()[name] ?? null;
  }

  /** Run jobs, take the keyboard for automation: occupants of an unlocked bench, and admins */
  canOperate(user, name) {
    if (!user) return false;
    if (isAdmin(user)) return this.names().includes(name);
    return !this.lock(name) && this.isOccupant(user, name);
  }

  /**
   * May this user open or pilot this device's console? (SPEC "Permissions")
   *   - admin switches: every signed-in user;
   *   - admins: always, locked benches included;
   *   - otherwise through any bench the device belongs to that is not locked
   *     and is either free or occupied by this user
   */
  canPilot(user, device) {
    if (!user?.id || !device) return false;
    if (String(device.key ?? '').startsWith('admin:')) return true;
    if (isAdmin(user)) return true;
    return this.benchesOfDevice(device).some((name) => !this.lock(name) && (!this.#occupancy(name) || this.isOccupant(user, name)));
  }

  /** Activity on a bench (console output, a job): postpones the automatic release */
  touch(name, { force = false } = {}) {
    const o = this.#occupancy(name);
    if (!o) return;
    const now = this.#now();
    if (!force && now - (this.#lastWrite.get(name) ?? Date.parse(o.lastActivity)) < TOUCH_WRITE_MS) return;
    this.#lastWrite.set(name, now);
    this.#occ.update((all) => {
      if (all[name]) all[name].lastActivity = iso(now);
      return all;
    }).then(() => this.publishState(), (err) => this.#log.warn(`activity on ${name} not recorded: ${err.message}`));
  }

  /** Hook for the jobs lot: fn({ labName, teamId, by }) is called after each release. Returns the function that unsubscribes */
  onRelease(fn) {
    if (typeof fn !== 'function') throw new TypeError('onRelease needs a function');
    this.#releaseHandlers.add(fn);
    this.publishState();
    return () => {
      this.#releaseHandlers.delete(fn);
      this.publishState();
    };
  }

  // ── What a browser sees ───────────────────────────────────────────────────

  /** One bench as everyone may see it: holder, occupants, lock, automatic release */
  summary(name) {
    const o = this.#occupancy(name);
    const team = o ? this.#teams.get(o.teamId) : null;
    const lastActivity = o ? Date.parse(o.lastActivity) : null;
    return {
      bench: name,
      holder: o ? { teamId: o.teamId, teamName: team?.name ?? null, since: o.since, by: o.by } : null,
      occupants: o ? [
        ...(team?.people ?? []).map((p) => ({ id: p.id, name: p.name, username: p.username, guest: false })),
        ...(o.guests ?? []).filter((g) => !team?.members.includes(g.id)).map((g) => ({ id: g.id, name: g.name, username: g.username, guest: true })),
      ] : [],
      lock: this.lock(name),
      lastActivity: o?.lastActivity ?? null,
      releaseAt: o ? iso(lastActivity + this.#idleMs) : null,
    };
  }

  /** The bench as this user sees it: the summary, the pending requests when they may answer them, and what they may do */
  detail(name, user) {
    const s = this.summary(name);
    const o = this.#occupancy(name);
    const team = this.#teams.teamOf(user);
    const occupant = this.isOccupant(user, name);
    const member = this.isHolderMember(user, name);
    const admin = isAdmin(user);
    const locked = Boolean(s.lock);
    const pending = Boolean(o?.requests?.some((r) => r.id === user.id));
    const current = this.#currentReservation(name);
    return {
      ...s,
      requests: occupant || admin ? (o?.requests ?? []) : [],
      backupOffer: this.hasReleaseHandlers,
      you: {
        team: team ? { id: team.id, name: team.name } : null,
        occupant,
        member,
        guest: occupant && !member,
        pending,
        canTake: Boolean(team) && !member && (admin || !locked)
          && (!o || current?.teamId === team.id) && (admin || !current || current.teamId === team.id),
        canRelease: Boolean(o) && (member || admin),
        canJoin: Boolean(o) && !occupant && !pending && !locked,
        canAnswer: Boolean(o) && (member || admin),
        canPilot: admin || (!locked && (!o || occupant)),
        admin,
      },
    };
  }

  /** The sticky 'benches:state' topic (everyone) and one requests topic per bench (its occupants only) */
  publishState(names = this.names()) {
    this.#published = this.names().join('\n');
    this.#events.publish('benches:state', { benches: this.names().map((n) => this.summary(n)), backupOffer: this.hasReleaseHandlers }, { sticky: true });
    for (const name of names) {
      const requests = this.#occupancy(name)?.requests ?? [];
      // The filter runs again for every stream that connects later: it reads the live occupancy
      this.#events.publish(`benches:requests:${name}`, { bench: name, requests }, { sticky: true, audience: (u) => this.isOccupant(u, name) });
    }
  }

  // ── Taking and giving back ────────────────────────────────────────────────

  #currentReservation(name, at = this.#now()) {
    return this.#reservations().find((r) => r.bench === name && Date.parse(r.start) <= at && at < Date.parse(r.end)) ?? null;
  }

  async take(user, name) {
    this.bench(name);
    const team = this.#teams.teamOf(user);
    if (!team) throw httpError(409, 'benches.no_team', 'Join or create a team before taking a bench');
    if (this.lock(name) && !isAdmin(user)) throw httpError(423, 'benches.locked', 'This bench is locked', { reason: this.lock(name).reason });
    const now = this.#now();
    const slot = this.#currentReservation(name, now);
    let replaced = null;
    let already = false;
    await this.#occ.update((all) => {
      const o = all[name];
      if (o?.teamId === team.id) { already = true; return all; }
      const elsewhere = Object.keys(all).find((b) => all[b].teamId === team.id);
      if (elsewhere) throw httpError(409, 'benches.team_has_bench', 'Your team already holds another bench', { bench: elsewhere });
      if (slot && slot.teamId !== team.id && !isAdmin(user)) {
        throw httpError(409, 'benches.reserved', 'Another team has booked this bench now', { team: this.#teams.get(slot.teamId)?.name ?? '', end: slot.end });
      }
      if (o && !(slot && slot.teamId === team.id)) {
        throw httpError(409, 'benches.taken', 'Another team holds this bench', { team: this.#teams.get(o.teamId)?.name ?? '' });
      }
      if (o) replaced = o; // our slot has started: the team of the moment gives way
      all[name] = { teamId: team.id, since: iso(now), by: personOf(user), lastActivity: iso(now), guests: [], requests: [] };
      return all;
    });
    if (already) return this.detail(name, user);
    if (replaced) await this.#afterRelease(name, replaced, 'system', 'reservation');
    this.#lastWrite.set(name, now);
    this.#audit.log(user, 'bench.take', { bench: name, team: team.name, teamId: team.id, ...(replaced ? { replaced: replaced.teamId } : {}) });
    this.publishState();
    return this.detail(name, user);
  }

  /** An admin gives a bench to a team, whoever held it */
  async assign(admin, name, teamId) {
    this.bench(name);
    const team = this.#teams.get(teamId);
    if (!team) throw httpError(404, 'teams.unknown', 'This team does not exist (any more)');
    const now = this.#now();
    let replaced = null;
    let moved = null;
    await this.#occ.update((all) => {
      if (all[name]?.teamId === team.id) return all;
      replaced = all[name] ?? null;
      moved = Object.keys(all).find((b) => b !== name && all[b].teamId === team.id) ?? null;
      if (moved) delete all[moved]; // one bench per team: the old one is given back
      all[name] = { teamId: team.id, since: iso(now), by: personOf(admin), lastActivity: iso(now), guests: [], requests: [] };
      return all;
    });
    if (replaced) await this.#afterRelease(name, replaced, admin, 'admin');
    if (moved) await this.#afterRelease(moved, { teamId: team.id }, admin, 'admin');
    this.#lastWrite.set(name, now);
    this.#audit.log(admin, 'bench.assign', { bench: name, team: team.name, teamId: team.id });
    this.publishState();
    return this.summary(name);
  }

  /** Release by a member of the holding team or an admin (reason 'hand' / 'admin'), or by the system */
  async release(actor, name, reason) {
    this.bench(name);
    let released = null;
    await this.#occ.update((all) => {
      released = all[name] ?? null;
      if (!released) throw httpError(409, 'benches.not_taken', 'Nobody holds this bench');
      delete all[name];
      return all;
    });
    const why = reason ?? (actor !== 'system' && isAdmin(actor) && !this.#teams.isMember(actor, released.teamId) ? 'admin' : 'hand');
    const offers = await this.#afterRelease(name, released, actor, why);
    this.publishState();
    return { offers };
  }

  /** Common end of every release: audit, hooks, the requests of the bench */
  async #afterRelease(name, released, actor, reason) {
    this.#lastWrite.delete(name);
    const team = this.#teams.get(released.teamId);
    const action = reason === 'idle' ? 'bench.release.idle' : 'bench.release';
    this.#audit.log(actor, action, { bench: name, team: team?.name ?? null, teamId: released.teamId, reason });
    for (const r of released.requests ?? []) this.#events.toUser(r.id, 'benches:request', { bench: name, state: 'released' });
    const by = actor === 'system' ? 'system' : personOf(actor);
    const offers = [];
    for (const fn of this.#releaseHandlers) {
      try {
        const offer = await fn({ labName: name, teamId: released.teamId, by, reason });
        if (offer && typeof offer === 'object') offers.push(offer);
      } catch (err) {
        this.#log.warn(`release hook failed for ${name}: ${err.message}`);
      }
    }
    return offers;
  }

  // ── Joining a bench held by another team ─────────────────────────────────

  async requestJoin(user, name) {
    this.bench(name);
    if (this.lock(name)) throw httpError(423, 'benches.locked', 'This bench is locked', { reason: this.lock(name).reason });
    if (!this.#occupancy(name)) throw httpError(409, 'benches.not_taken', 'Nobody holds this bench: take it instead');
    if (this.isOccupant(user, name)) throw httpError(409, 'benches.already_occupant', 'You already work on this bench');
    const at = iso(this.#now());
    let added = false;
    await this.#occ.update((all) => {
      const o = all[name];
      if (!o) throw httpError(409, 'benches.not_taken', 'Nobody holds this bench: take it instead');
      o.requests ??= [];
      if (o.requests.some((r) => r.id === user.id)) return all;
      if (o.requests.length >= MAX_REQUESTS) throw httpError(429, 'benches.too_many_requests', 'Too many requests are waiting on this bench');
      o.requests.push({ ...personOf(user), at });
      added = true;
      return all;
    });
    if (added) this.#audit.log(user, 'bench.join.request', { bench: name });
    this.publishState([name]);
    return { pending: true };
  }

  async cancelRequest(user, name) {
    this.bench(name);
    await this.#dropRequest(name, user.id);
    this.publishState([name]);
  }

  async #dropRequest(name, userId) {
    let found = null;
    await this.#occ.update((all) => {
      const o = all[name];
      const i = o?.requests?.findIndex((r) => r.id === userId) ?? -1;
      if (i < 0) throw httpError(404, 'benches.no_request', 'There is no such request');
      [found] = o.requests.splice(i, 1);
      return all;
    });
    return found;
  }

  /** A member of the holding team (or an admin) accepts or refuses a request */
  async answer(user, name, userId, accept) {
    this.bench(name);
    if (!this.isHolderMember(user, name) && !isAdmin(user)) {
      throw httpError(403, 'benches.not_member', 'Only the team that holds the bench answers its requests');
    }
    let request = null;
    await this.#occ.update((all) => {
      const o = all[name];
      const i = o?.requests?.findIndex((r) => r.id === userId) ?? -1;
      if (i < 0) throw httpError(404, 'benches.no_request', 'There is no such request');
      [request] = o.requests.splice(i, 1);
      if (accept) {
        o.guests ??= [];
        if (!o.guests.some((g) => g.id === request.id)) o.guests.push({ id: request.id, username: request.username, name: request.name });
      }
      return all;
    });
    this.#audit.log(user, accept ? 'bench.join.accept' : 'bench.join.refuse', { bench: name, guest: request.username, guestName: request.name, guestId: request.id });
    this.#events.toUser(request.id, 'benches:request', { bench: name, state: accept ? 'accepted' : 'refused', by: personOf(user).name });
    this.publishState();
    return this.detail(name, user);
  }

  /** A guest leaves (themselves), or an admin removes a guest */
  async removeGuest(actor, name, userId, { self = false } = {}) {
    this.bench(name);
    let guest = null;
    await this.#occ.update((all) => {
      const o = all[name];
      const i = o?.guests?.findIndex((g) => g.id === userId) ?? -1;
      if (i < 0) {
        if (o && this.#teams.get(o.teamId)?.members.includes(userId)) {
          throw httpError(409, 'benches.member_of_holder', 'This person belongs to the team that holds the bench: remove them from the team instead');
        }
        throw httpError(404, 'benches.not_guest', 'This person is not a guest on this bench');
      }
      [guest] = o.guests.splice(i, 1);
      return all;
    });
    this.#audit.log(actor, self ? 'bench.leave' : 'bench.guest.remove', { bench: name, guest: guest.username, guestName: guest.name, guestId: guest.id });
    if (!self) this.#events.toUser(guest.id, 'benches:request', { bench: name, state: 'removed' });
    this.publishState();
  }

  // ── Locks ─────────────────────────────────────────────────────────────────

  async setLock(admin, name, rawReason) {
    this.bench(name);
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (!reason || reason.length > 200 || CONTROL.test(reason)) {
      throw httpError(400, 'benches.bad_reason', 'Give a reason of at most 200 characters', { max: 200 });
    }
    const lock = { reason, by: personOf(admin), at: iso(this.#now()) };
    await this.#locks.update((all) => { all[name] = lock; return all; });
    this.#audit.log(admin, 'bench.lock', { bench: name, reason });
    this.publishState();
    return lock;
  }

  async unlock(admin, name) {
    this.bench(name);
    await this.#locks.update((all) => {
      if (!all[name]) throw httpError(409, 'benches.not_locked', 'This bench is not locked');
      delete all[name];
      return all;
    });
    this.#audit.log(admin, 'bench.unlock', { bench: name });
    this.publishState();
  }

  // ── Reservations ──────────────────────────────────────────────────────────

  #reservations() {
    const doc = this.#resv.get();
    return Array.isArray(doc?.reservations) ? doc.reservations : [];
  }

  #reservationView(r) {
    return { id: r.id, bench: r.bench, teamId: r.teamId, teamName: this.#teams.get(r.teamId)?.name ?? null, start: r.start, end: r.end, by: r.by, createdAt: r.createdAt };
  }

  /** Reservations overlapping [from, to), optionally for one bench, oldest first */
  listReservations({ bench, from, to } = {}) {
    const lo = from ?? -Infinity;
    const hi = to ?? Infinity;
    return this.#reservations()
      .filter((r) => (!bench || r.bench === bench) && Date.parse(r.end) > lo && Date.parse(r.start) < hi)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .map((r) => this.#reservationView(r));
  }

  async reserve(user, { bench, start, end, teamId }) {
    const name = this.bench(bench);
    const admin = isAdmin(user);
    let team;
    if (admin && teamId) {
      team = this.#teams.get(teamId);
      if (!team) throw httpError(404, 'teams.unknown', 'This team does not exist (any more)');
    } else {
      team = this.#teams.teamOf(user);
      if (!team) throw httpError(409, 'benches.no_team', 'Join or create a team before booking a bench');
    }
    const s = toMs(start);
    const e = toMs(end);
    const step = SLOT_STEP_MINUTES * 60_000;
    if (s === null || e === null || e <= s || s % step !== 0 || e % step !== 0) {
      throw httpError(400, 'benches.bad_slot', 'A slot starts and ends on a quarter of an hour, the end after the start', { minutes: SLOT_STEP_MINUTES });
    }
    const now = this.#now();
    if (e <= now) throw httpError(400, 'benches.slot_in_past', 'This slot is already over');
    const { maxFuture, maxHours, maxDaysAhead } = this.#limits;
    if (!admin) {
      if (e - s > maxHours * HOUR) throw httpError(400, 'benches.slot_too_long', `A slot lasts at most ${maxHours} h`, { hours: maxHours });
      if (s - now > maxDaysAhead * 24 * HOUR) throw httpError(400, 'benches.slot_too_far', `A slot is booked at most ${maxDaysAhead} days ahead`, { days: maxDaysAhead });
    }
    const created = {
      id: crypto.randomBytes(6).toString('hex'), bench: name, teamId: team.id, start: iso(s), end: iso(e), by: personOf(user), createdAt: iso(now),
    };
    await this.#resv.update((doc) => {
      doc.reservations = Array.isArray(doc.reservations) ? doc.reservations : [];
      const clash = doc.reservations.find((r) => r.bench === name && Date.parse(r.start) < e && s < Date.parse(r.end));
      if (clash) throw httpError(409, 'benches.slot_overlap', 'This slot overlaps another booking', { team: this.#teams.get(clash.teamId)?.name ?? '', start: clash.start, end: clash.end });
      const future = doc.reservations.filter((r) => r.teamId === team.id && Date.parse(r.end) > now).length;
      if (!admin && future >= maxFuture) throw httpError(409, 'benches.too_many_slots', `Your team already has ${maxFuture} slots booked`, { max: maxFuture });
      doc.reservations.push(created);
      return doc;
    });
    this.#audit.log(user, 'bench.reserve', { bench: name, team: team.name, teamId: team.id, start: created.start, end: created.end });
    this.#events.publish('benches:reservations', { bench: name });
    return this.#reservationView(created);
  }

  async cancelReservation(user, id) {
    const found = this.#reservations().find((r) => r.id === id);
    if (!found) throw httpError(404, 'benches.no_reservation', 'There is no such reservation');
    if (!isAdmin(user) && !this.#teams.isMember(user, found.teamId)) {
      throw httpError(403, 'benches.not_your_reservation', 'Only the team that booked this slot may cancel it');
    }
    await this.#resv.update((doc) => {
      doc.reservations = (doc.reservations ?? []).filter((r) => r.id !== id);
      return doc;
    });
    this.#audit.log(user, 'bench.reservation.cancel', { bench: found.bench, teamId: found.teamId, start: found.start, end: found.end });
    this.#events.publish('benches:reservations', { bench: found.bench });
  }

  // ── Following the teams ───────────────────────────────────────────────────

  /** A team changed: a dissolved one gives its bench and its slots back; occupants changed in any case */
  async teamChanged({ before, dissolved }) {
    if (dissolved && before) {
      const held = Object.entries(this.#occ.get()).find(([, o]) => o.teamId === before.id)?.[0];
      if (held) await this.release('system', held, 'dissolved').catch((err) => this.#log.warn(`release of ${held}: ${err.message}`));
      const slots = this.#reservations().filter((r) => r.teamId === before.id);
      if (slots.length) {
        await this.#resv.update((doc) => {
          doc.reservations = (doc.reservations ?? []).filter((r) => r.teamId !== before.id);
          return doc;
        });
        for (const b of new Set(slots.map((r) => r.bench))) this.#events.publish('benches:reservations', { bench: b });
      }
    }
    this.publishState();
  }

  // ── Periodic work ─────────────────────────────────────────────────────────

  /**
   * Release idle benches, warn the occupants of a bench booked by another
   * team ten minutes before the slot, tell a team its slot has started
   */
  async tick() {
    const now = this.#now();
    if (this.#published !== this.names().join('\n')) this.publishState(); // the diagram changed
    for (const [name, o] of Object.entries(this.#occ.get())) {
      const last = Date.parse(o.lastActivity);
      if (Number.isFinite(last) && now - last >= this.#idleMs) {
        await this.release('system', name, 'idle').catch((err) => this.#log.warn(`automatic release of ${name}: ${err.message}`));
      }
    }

    const marks = new Map(); // id → { warnedAt?, startedAt? }
    for (const r of this.#reservations()) {
      const start = Date.parse(r.start);
      const end = Date.parse(r.end);
      const team = this.#teams.get(r.teamId);
      if (!r.warnedAt && start > now && start - now <= WARNING_MINUTES * 60_000) {
        const held = this.#occupancy(r.bench);
        if (held && held.teamId !== r.teamId) {
          const data = { bench: r.bench, start: r.start, end: r.end, team: team?.name ?? null, minutes: Math.ceil((start - now) / 60_000) };
          this.#events.publish('benches:warning', data, { audience: (u) => this.isOccupant(u, r.bench) });
        }
        marks.set(r.id, { ...marks.get(r.id), warnedAt: iso(now) });
      }
      if (!r.startedAt && start <= now && now < end) {
        if (team) this.#events.publish('benches:slot', { bench: r.bench, start: r.start, end: r.end }, { audience: (u) => team.members.includes(u.id) });
        marks.set(r.id, { ...marks.get(r.id), startedAt: iso(now) });
      }
    }
    if (marks.size) {
      await this.#resv.update((doc) => {
        for (const r of doc.reservations ?? []) if (marks.has(r.id)) Object.assign(r, marks.get(r.id));
        return doc;
      });
    }
  }
}

function toMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
