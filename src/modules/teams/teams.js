/**
 * Teams: a few students who work together and share a bench, its backups and
 * its reservations (SPEC "Lot teams")
 *
 * Any student creates a team and invites classmates by user name; an
 * invitation is accepted by the person it names. A student belongs to at most
 * one team; the last member to leave dissolves it. Admins need no team: they
 * see, rename, edit and dissolve every team
 *
 * The state is one document, data/teams/teams.json:
 *   { teams: [{ id, name, createdAt, createdBy, members: [Person + since], invitations: [{ username, by, at }] }] }
 * where Person = { id, username, name }. User names are compared without case
 *
 * Every change is emitted as 'change' ({ team, before, after, dissolved }) so
 * the benches can follow (a dissolved team gives its bench back)
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { httpError } from '../../lib/httpError.js';

export const MAX_MEMBERS = 8;

/** A user, reduced to what other people may see of them */
export const personOf = (user) => ({ id: String(user.id), username: String(user.username ?? ''), name: String(user.name || user.username || user.id) });

const fold = (name) => String(name ?? '').trim().toLowerCase();
export const sameUsername = (user, username) => Boolean(user?.username) && fold(user.username) === fold(username);

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A team name: 2 to 40 characters once trimmed, inner spaces collapsed, no control characters */
export function normalizeTeamName(raw) {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 40 || CONTROL.test(name)) {
    throw httpError(400, 'teams.bad_name', 'A team name has 2 to 40 characters', { min: 2, max: 40 });
  }
  return name;
}

/** A user name as typed by a classmate: 1 to 64 characters, no spaces or control characters */
export function normalizeUsername(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > 64 || /\s/.test(name) || CONTROL.test(name)) {
    throw httpError(400, 'teams.bad_username', 'This is not a user name');
  }
  return name;
}

const view = (team) => team && ({
  id: team.id,
  name: team.name,
  createdAt: team.createdAt,
  members: team.members.map((m) => m.id),
  people: team.members.map(({ id, username, name, since }) => ({ id, username, name, since })),
  invitations: team.invitations.map(({ username, by, at }) => ({ username, by, at })),
});

export class Teams extends EventEmitter {
  #doc;
  #now;

  constructor({ store, now = () => Date.now() }) {
    super();
    this.#doc = store.json('teams/teams.json', { teams: [] });
    this.#now = now;
  }

  #all() {
    const doc = this.#doc.get();
    return Array.isArray(doc?.teams) ? doc.teams : [];
  }

  /** Every team, as other modules see it: { id, name, members: userId[], people, invitations } */
  list() {
    return this.#all().map(view).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(teamId) {
    return view(this.#all().find((t) => t.id === teamId)) ?? null;
  }

  /** The team of a user (a User or an id), or null */
  teamOf(userOrId) {
    const id = typeof userOrId === 'object' && userOrId !== null ? userOrId.id : userOrId;
    if (id === undefined || id === null) return null;
    return view(this.#all().find((t) => t.members.some((m) => m.id === String(id)))) ?? null;
  }

  isMember(user, teamId) {
    return Boolean(user) && this.#all().some((t) => t.id === teamId && t.members.some((m) => m.id === user.id));
  }

  /** Invitations waiting for this user: [{ team: { id, name }, by, at }] */
  invitationsFor(user) {
    const out = [];
    for (const t of this.#all()) {
      for (const inv of t.invitations) {
        if (sameUsername(user, inv.username)) out.push({ team: { id: t.id, name: t.name }, by: inv.by, at: inv.at });
      }
    }
    return out;
  }

  /** Apply `fn(team, teams)` to one team inside a serialized update; emits 'change' */
  async #change(teamId, fn) {
    let before = null;
    let after = null;
    let result;
    await this.#doc.update((doc) => {
      doc.teams = Array.isArray(doc.teams) ? doc.teams : [];
      const team = doc.teams.find((t) => t.id === teamId);
      if (!team) throw httpError(404, 'teams.unknown', 'This team does not exist (any more)');
      before = structuredClone(team);
      result = fn(team, doc);
      after = doc.teams.includes(team) ? structuredClone(team) : null;
      return doc;
    });
    this.emit('change', { team: view(after ?? before), before: view(before), after: view(after), dissolved: !after });
    return { result, team: view(after), before: view(before) };
  }

  #ensureFree(doc, user) {
    const current = doc.teams.find((t) => t.members.some((m) => m.id === user.id));
    if (current) throw httpError(409, 'teams.already_member', 'You already belong to a team: leave it first', { team: current.name });
  }

  #ensureUniqueName(doc, name, exceptId) {
    if (doc.teams.some((t) => t.id !== exceptId && fold(t.name) === fold(name))) {
      throw httpError(409, 'teams.name_taken', 'Another team already has this name', { name });
    }
  }

  async create(user, rawName) {
    const name = normalizeTeamName(rawName);
    const at = new Date(this.#now()).toISOString();
    const team = { id: crypto.randomBytes(6).toString('hex'), name, createdAt: at, createdBy: personOf(user), members: [{ ...personOf(user), since: at }], invitations: [] };
    await this.#doc.update((doc) => {
      doc.teams = Array.isArray(doc.teams) ? doc.teams : [];
      this.#ensureFree(doc, user);
      this.#ensureUniqueName(doc, name);
      doc.teams.push(team);
      return doc;
    });
    this.emit('change', { team: view(team), before: null, after: view(team), dissolved: false });
    return view(team);
  }

  async rename(teamId, rawName) {
    const name = normalizeTeamName(rawName);
    return (await this.#change(teamId, (team, doc) => {
      this.#ensureUniqueName(doc, name, team.id);
      team.name = name;
    })).team;
  }

  async invite(teamId, rawUsername, by) {
    const username = normalizeUsername(rawUsername);
    const { result, team } = await this.#change(teamId, (t) => {
      if (t.members.some((m) => fold(m.username) === fold(username))) {
        throw httpError(409, 'teams.already_in_team', 'This person is already in the team', { username });
      }
      if (t.invitations.some((i) => fold(i.username) === fold(username))) return false; // already invited: nothing new
      // An invitation holds a seat until it is answered, so a team never has more invitations than free seats
      if (t.members.length + t.invitations.length >= MAX_MEMBERS) throw httpError(409, 'teams.full', `A team has at most ${MAX_MEMBERS} members`, { max: MAX_MEMBERS });
      t.invitations.push({ username, by: personOf(by), at: new Date(this.#now()).toISOString() });
      return true;
    });
    return { team, invited: result, username };
  }

  /** Withdraw an invitation (a member, an admin) or decline it (the invitee) */
  async dropInvitation(teamId, rawUsername) {
    const username = normalizeUsername(rawUsername);
    return (await this.#change(teamId, (t) => {
      const i = t.invitations.findIndex((inv) => fold(inv.username) === fold(username));
      if (i < 0) throw httpError(404, 'teams.no_invitation', 'There is no such invitation');
      t.invitations.splice(i, 1);
    })).team;
  }

  hasInvitation(teamId, user) {
    return this.#all().some((t) => t.id === teamId && t.invitations.some((inv) => sameUsername(user, inv.username)));
  }

  async accept(teamId, user) {
    return (await this.#change(teamId, (t, doc) => {
      const i = t.invitations.findIndex((inv) => sameUsername(user, inv.username));
      if (i < 0) throw httpError(404, 'teams.no_invitation', 'There is no such invitation');
      this.#ensureFree(doc, user);
      // Safety net: an invitation holds a seat, so this only triggers for a document written by hand or a lowered limit
      if (t.members.length >= MAX_MEMBERS) throw httpError(409, 'teams.full', `A team has at most ${MAX_MEMBERS} members`, { max: MAX_MEMBERS });
      t.invitations.splice(i, 1);
      t.members.push({ ...personOf(user), since: new Date(this.#now()).toISOString() });
    })).team;
  }

  /** A member leaves (or an admin removes them); the last one out dissolves the team */
  async removeMember(teamId, userId) {
    const { result, team, before } = await this.#change(teamId, (t, doc) => {
      const i = t.members.findIndex((m) => m.id === String(userId));
      if (i < 0) throw httpError(404, 'teams.not_member', 'This person is not in the team');
      t.members.splice(i, 1);
      if (t.members.length === 0) {
        doc.teams = doc.teams.filter((x) => x !== t);
        return true;
      }
      return false;
    });
    return { dissolved: result, team: team ?? before };
  }

  async dissolve(teamId) {
    const { before } = await this.#change(teamId, (t, doc) => {
      doc.teams = doc.teams.filter((x) => x !== t);
    });
    return before;
  }
}
