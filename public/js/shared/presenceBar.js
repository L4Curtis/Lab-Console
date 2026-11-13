/**
 * The strip of a console tile that says who is on the line and who holds the
 * keyboard, with the controls that go with it: ask for the keyboard, give it
 * (or refuse it) when someone asks, let go, share it, take it over (admins),
 * free the line (not under someone else's task). It speaks the room frames of /ws/console:
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
import { serverText } from './serverText.js';

// Control events that tell the person who receives the keyboard, and the one who loses it
const RECEIVED = new Set(['granted', 'timeout', 'idle', 'takeover', 'released', 'left']);

export class PresenceBar {
  #p = null;
  #countdown = null;

  /**
   * @param send     (msg) => void: a frame to the server
   * @param device   the device's name, for the questions
   */
  constructor({ send, device }) {
    this.send = send;
    this.device = device;
    this.people = h('span.presence-people');
    this.status = h('span.presence-status');
    this.buttons = h('span.presence-actions');
    this.prompt = h('div.presence-prompt', { hidden: true, role: 'alert' });
    this.el = h('div.pane-presence', { hidden: true },
      h('div.presence-row', this.people, this.status, this.buttons),
      this.prompt);
  }

  get presence() { return this.#p; }
  get mayType() { return Boolean(this.#p?.mayType); }
  get canPilot() { return Boolean(this.#p?.canPilot); }
  get isPilot() { return Boolean(this.#p && this.#p.pilot === this.#p.you); }

  update(presence) {
    this.#p = presence;
    this.el.hidden = false;
    this.#render();
  }

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
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  #render() {
    const p = this.#p;
    const pilot = p.users.find((u) => u.id === p.pilot);
    this.people.replaceChildren(...p.users.map((u) => avatar(u, u.id === p.pilot, u.id === p.you)));

    let text;
    if (p.task?.state === 'running') text = t('terminal.presence.task', { task: p.task.label, name: p.task.by.name });
    else if (p.pilot === p.you) text = t(p.shared ? 'terminal.presence.youShared' : 'terminal.presence.you');
    else if (pilot) text = t(p.shared ? 'terminal.presence.pilotShared' : 'terminal.presence.pilot', { name: pilot.name });
    else text = t('terminal.presence.nobody');
    if (!p.canPilot) text = `${text} ${t('terminal.presence.watchOnly')}`;
    this.status.textContent = text;

    const mine = p.pilot === p.you;
    const asked = p.pending && p.pending.from.id === p.you;
    const btn = (action, key, opts = {}) => h(`button.btn.small${opts.primary ? '.primary' : ''}`, { type: 'button', dataset: { action }, onclick: opts.onclick ?? (() => this.send({ type: 'control', action })) }, opts.icon ? icon(opts.icon) : null, tNode(key));
    const buttons = [];
    if (asked) buttons.push(h('span.presence-wait', t('terminal.presence.waiting')));
    else if (!mine && p.canPilot && !p.task) buttons.push(btn('request', 'terminal.presence.request', { primary: true, icon: 'keyboard' }));
    if (mine) buttons.push(btn(p.shared ? 'unshare' : 'share', p.shared ? 'terminal.presence.unshare' : 'terminal.presence.share'));
    if (mine) buttons.push(btn('release', 'terminal.presence.release'));
    if (!mine && session.isAdmin && pilot) buttons.push(btn('take', 'terminal.presence.take'));
    // Free the line: under a task, only the people who may stop it (its actor, the pilot, an admin)
    const mayFree = mine || session.isAdmin || (p.task ? p.task.by?.id === p.you : !pilot && p.canPilot);
    if (mayFree) buttons.push(btn('hangup', 'terminal.presence.hangup', { onclick: () => this.#hangUp() }));
    this.buttons.replaceChildren(...buttons);
    this.#renderPrompt();
  }

  /** The pilot is asked: give or refuse, with the time left before it passes anyway */
  #renderPrompt() {
    const p = this.#p;
    clearInterval(this.#countdown);
    if (!p.pending || p.pilot !== p.you) {
      this.prompt.hidden = true;
      this.prompt.replaceChildren();
      return;
    }
    const left = h('span.presence-left');
    const tick = () => {
      const seconds = Math.max(0, Math.round((Date.parse(p.pending.until) - Date.now()) / 1000));
      left.textContent = t('terminal.presence.autoIn', { count: seconds });
    };
    tick();
    this.#countdown = setInterval(tick, 1000);
    const question = p.pending.kind === 'task'
      ? t('terminal.presence.askTask', { name: p.pending.from.name, task: p.pending.label ?? '' })
      : t('terminal.presence.ask', { name: p.pending.from.name });
    this.prompt.replaceChildren(
      h('span.presence-question', icon('keyboard'), h('strong', question), left),
      h('span.presence-answer',
        h('button.btn.small.primary', { type: 'button', dataset: { action: 'grant' }, onclick: () => this.send({ type: 'control', action: 'grant', to: p.pending.from.id }) }, tNode('terminal.presence.grant')),
        h('button.btn.small', { type: 'button', dataset: { action: 'deny' }, onclick: () => this.send({ type: 'control', action: 'deny', to: p.pending.from.id }) }, tNode('terminal.presence.deny'))));
    this.prompt.hidden = false;
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

/** A round badge with the initials; the pilot's carries a keyboard */
export function avatar(u, pilot = false, you = false) {
  const title = pilot ? t('terminal.presence.avatarPilot', { name: u.name }) : u.name;
  return h(`span.avatar${pilot ? '.pilot' : ''}${you ? '.you' : ''}`, { title, 'aria-label': title, style: u.color ? `--avatar:${u.color}` : null },
    u.initials || (u.name || '?').slice(0, 2).toUpperCase(),
    pilot ? icon('keyboard', 'avatar-key') : null);
}
