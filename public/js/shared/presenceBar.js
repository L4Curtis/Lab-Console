/**
 * Who is on a console line and who holds the keyboard (UX.md §8.2), in three
 * places of a console tile:
 *   avatars       the people on the line, in the tile's head (3 at most, then
 *                 "+n"; the pilot's has a ring and a key)
 *   el            the presence row under the head, shown only when it says
 *                 something: someone else is here, you are watching, a request
 *                 waits for your answer, a task holds the keyboard. One sentence
 *                 and at most two buttons: ask for the keyboard, give it or
 *                 refuse it, take it over (admins)
 *   menuItems()   the rest, for the tile's ⋯ menu: share the keyboard or take
 *                 it back, let it go, free the line (not under someone else's task)
 *
 * It speaks the room frames of /ws/console:
 *   update(presence)   {type:'presence', users, pilot, you, canPilot, mayType, shared, task, pending}
 *   control(frame)     {type:'control', event, by, to}   → a short notice when it concerns this user
 *   refused(frame)     {type:'control-refused', code, params}
 *
 * The buttons only express a wish: the server decides, and its answer comes
 * back as the next presence frame
 */
import { h, icon, toast } from '../core/dom.js';
import { t, tNode } from '../core/i18n.js';
import { session } from '../core/session.js';
import { confirmDialog } from './dialog.js';
import { serverText, taskName } from './serverText.js';

// Control events that tell the person who receives the keyboard, and the one who loses it
const RECEIVED = new Set(['granted', 'timeout', 'idle', 'takeover', 'released', 'left']);
const AVATARS_SHOWN = 3;

export class PresenceBar {
  #p = null;
  #countdown = null;
  #listeners = new Set();

  /**
   * @param send     (msg) => void: a frame to the server
   * @param device   the device's name, for the questions
   */
  constructor({ send, device }) {
    this.send = send;
    this.device = device;
    this.avatars = h('span.avatar-stack.pane-people');
    this.status = h('span.presence-status');
    this.left = h('span.presence-left', { hidden: true });
    this.buttons = h('span.presence-actions');
    this.el = h('div.pane-presence', { hidden: true },
      h('div.presence-row', this.status, this.left, this.buttons));
  }

  get presence() { return this.#p; }
  get mayType() { return Boolean(this.#p?.mayType); }
  get canPilot() { return Boolean(this.#p?.canPilot); }
  get isPilot() { return Boolean(this.#p && this.#p.pilot === this.#p.you); }
  /** I asked for the keyboard and wait for the answer */
  get asked() { return Boolean(this.#p?.pending && this.#p.pending.from.id === this.#p.you); }

  /** Called after every presence frame (the tile's key toolbar follows it) → stop */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  update(presence) {
    this.#p = presence;
    this.#render();
    for (const fn of this.#listeners) fn(presence);
  }

  /** Ask for the keyboard (the button of the row, the key toolbar's) */
  request() { this.send({ type: 'control', action: 'request' }); }

  /** A control event: a word for the people it concerns */
  control(frame) {
    const me = this.#p?.you;
    if (!me) return;
    const by = frame.by?.name ?? '';
    if (frame.event === 'denied' && frame.to?.id === me) toast(t('terminal.presence.notice.denied', { name: by }), 'warn');
    else if (frame.event === 'superseded' && frame.to?.id === me) toast(t('terminal.presence.notice.superseded'), 'warn');
    else if (RECEIVED.has(frame.event) && frame.to?.id === me && frame.by?.id !== me) toast(t(`terminal.presence.notice.${frame.event}`, { name: by }));
    else if (frame.event === 'takeover' && frame.to?.id !== me && this.#p.pilot === me) toast(t('terminal.presence.notice.takenOver', { name: frame.to?.name ?? '' }), 'warn');
  }

  refused(frame) {
    toast(serverText({ code: frame.code, params: frame.params, message: frame.code }), 'warn');
  }

  retranslate() {
    if (this.#p) this.#render();
  }

  dispose() {
    clearInterval(this.#countdown);
    this.#listeners.clear();
  }

  /** The sentence of the row: who has the keyboard, and what that means for me */
  sentence() {
    const p = this.#p;
    if (!p) return '';
    const pilot = p.users.find((u) => u.id === p.pilot);
    let text;
    if (p.task?.state === 'running') text = t('terminal.presence.task', { task: taskName(p.task.label), name: p.task.by.name });
    else if (p.pilot === p.you) text = t(p.shared ? 'terminal.presence.youShared' : 'terminal.presence.you');
    else if (pilot) text = t(p.shared ? 'terminal.presence.pilotShared' : 'terminal.presence.pilot', { name: pilot.name });
    else text = t('terminal.presence.nobody');
    if (!p.canPilot) text = `${text} ${t('terminal.presence.watchOnly')}`;
    return text;
  }

  /** The ⋯ menu's share of presence: keyboard sharing, letting go, freeing the line */
  menuItems() {
    const p = this.#p;
    if (!p) return [];
    const mine = p.pilot === p.you;
    const pilot = p.users.find((u) => u.id === p.pilot);
    const items = [];
    if (mine) {
      items.push({ id: p.shared ? 'unshare' : 'share', label: p.shared ? 'terminal.presence.unshare' : 'terminal.presence.share', icon: 'team', run: () => this.send({ type: 'control', action: p.shared ? 'unshare' : 'share' }) });
      items.push({ id: 'release', label: 'terminal.presence.release', icon: 'keyboard', run: () => this.send({ type: 'control', action: 'release' }) });
    }
    // Free the line: under a task, only the people who may stop it (its actor, the pilot, an admin)
    const mayFree = mine || session.isAdmin || (p.task ? p.task.by?.id === p.you : !pilot && p.canPilot);
    if (mayFree) items.push({ id: 'hangup', label: 'terminal.presence.hangup', icon: 'power', danger: true, run: () => this.#hangUp() });
    return items;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  #render() {
    const p = this.#p;
    const shown = p.users.slice(0, AVATARS_SHOWN);
    // The pilot first, so that the ring is the first thing seen
    shown.sort((a, b) => (b.id === p.pilot) - (a.id === p.pilot));
    const more = p.users.length > AVATARS_SHOWN ? [h('span.avatar-more', { title: p.users.slice(AVATARS_SHOWN).map((u) => u.name).join(', ') }, `+${p.users.length - AVATARS_SHOWN}`)] : [];
    this.avatars.replaceChildren(...shown.map((u) => avatar(u, u.id === p.pilot, u.id === p.you)), ...more);
    this.status.textContent = this.sentence();

    const mine = p.pilot === p.you;
    const pilot = p.users.find((u) => u.id === p.pilot);
    const answering = Boolean(p.pending) && mine;
    const btn = (action, key, opts = {}) => h(`button.btn.sm${opts.primary ? '.primary' : ''}`, { type: 'button', dataset: { action }, onclick: opts.onclick ?? (() => this.send({ type: 'control', action, ...(opts.to ? { to: opts.to } : {}) })) }, opts.icon ? icon(opts.icon) : null, tNode(key));
    const buttons = [];
    clearInterval(this.#countdown);
    this.left.hidden = true;
    if (answering) {
      // The pilot is asked: give or refuse, with the time left before it passes anyway
      this.status.textContent = p.pending.kind === 'task'
        ? t('terminal.presence.askTask', { name: p.pending.from.name, task: taskName(p.pending.label ?? '') })
        : t('terminal.presence.ask', { name: p.pending.from.name });
      const tick = () => {
        const seconds = Math.max(0, Math.round((Date.parse(p.pending.until) - Date.now()) / 1000));
        this.left.textContent = t('terminal.presence.autoIn', { count: seconds, name: p.pending.from.name });
      };
      tick();
      this.#countdown = setInterval(tick, 1000);
      this.left.hidden = false;
      buttons.push(btn('grant', 'terminal.presence.grant', { primary: true, to: p.pending.from.id }), btn('deny', 'terminal.presence.deny', { to: p.pending.from.id }));
    } else if (this.asked) {
      buttons.push(h('span.presence-wait', t('terminal.presence.waiting')));
    } else if (!mine && p.canPilot && !p.task) {
      buttons.push(btn('request', 'terminal.presence.request', { primary: true, icon: 'keyboard' }));
    }
    if (!mine && !answering && session.isAdmin && pilot) buttons.push(btn('take', 'terminal.presence.take'));
    this.buttons.replaceChildren(...buttons.slice(0, 2));

    // Alone with the keyboard: nothing to say (the key on my avatar says it)
    const others = p.users.some((u) => u.id !== p.you);
    const relevant = others || !p.mayType || answering || p.task?.state === 'running' || this.asked;
    this.el.hidden = !relevant;
    this.el.classList.toggle('presence-prompt', answering);
    this.el.setAttribute('role', answering ? 'alert' : 'status');
  }

  async #hangUp() {
    const others = this.#p.users.filter((u) => u.id !== this.#p.you).length;
    const ok = await confirmDialog({
      title: t('terminal.presence.hangupTitle', { name: this.device }),
      body: others ? t('terminal.presence.hangupBody', { count: others }) : t('terminal.presence.hangupAlone'),
      confirmLabel: t('terminal.presence.hangup'),
      danger: others > 0,
    });
    if (ok) this.send({ type: 'control', action: 'hangup' });
  }
}

/** A round badge with the initials; the pilot's carries a ring and a key */
export function avatar(u, pilot = false, you = false) {
  const title = pilot ? t('terminal.presence.avatarPilot', { name: u.name }) : u.name;
  return h(`span.avatar${pilot ? '.pilot' : ''}${you ? '.you' : ''}`, { title, 'aria-label': title, role: 'img', style: u.color ? `--avatar:${u.color}` : null },
    u.initials || (u.name || '?').slice(0, 2).toUpperCase(),
    pilot ? icon('keyboard', 'avatar-key') : null);
}
