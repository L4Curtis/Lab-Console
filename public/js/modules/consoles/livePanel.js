/**
 * The live panel of the consoles section: every console open on the
 * platform right now (bench, device, the people on it, who holds the
 * keyboard, the last command, a task), and a feed of what happened on them.
 * Fed by the SSE topics consoles:rooms (sticky) and consoles:activity; a
 * click on a console opens it (or joins it) in the workspace. It is a side
 * panel (shared/sidePanel.js): a column beside the consoles from 1200 px, a
 * drawer below, a full-height sheet on a phone
 */
import { h } from '../../core/dom.js';
import { getJson, live } from '../../core/api.js';
import { t, tNode, onLocaleChange } from '../../core/i18n.js';
import { sidePanel } from '../../shared/sidePanel.js';
import { fmtTime } from '../../core/format.js';
import { avatar } from '../../shared/presenceBar.js';
import { taskName } from '../../shared/serverText.js';

const FEED_SIZE = 50;
const CONTROL_EVENTS = new Set(['granted', 'timeout', 'idle', 'takeover', 'released', 'left', 'request', 'shared', 'unshared', 'free', 'task', 'denied', 'returned']);

export class LivePanel {
  #rooms = [];
  #feed = [];

  /**
   * @param host     the side host of the section (shared/sidePanel.js sideHost())
   * @param onOpen   (summary) => void: open or join that console
   */
  constructor({ host, onOpen }) {
    this.onOpen = onOpen;
    this.list = h('ul.live-rooms');
    this.feedEl = h('ol.live-feed');
    this.count = h('p.live-count');
    this.panel = sidePanel(host, { title: 'consoles.live.title' });
    this.panel.el.classList.add('live-panel');
    this.el = this.panel.el;
    this.panel.body.append(this.count,
      h('section.live-section', h('h3', tNode('consoles.live.open')), this.list),
      h('section.live-section', h('h3', tNode('consoles.live.activity')), this.feedEl));
    live.on('consoles:rooms', (rooms) => { this.#rooms = rooms; this.#renderRooms(); });
    live.on('consoles:activity', (entry) => {
      if (entry.kind === 'command') return;
      this.#feed.unshift(entry);
      this.#feed.length = Math.min(this.#feed.length, FEED_SIZE);
      this.#renderFeed();
    });
    onLocaleChange(() => { this.#renderRooms(); this.#renderFeed(); });
    this.#loadFeed();
  }

  get open() { return this.panel.isOpen; }

  toggle(on = !this.panel.isOpen) {
    this.panel.toggle(on);
  }

  /** fn(open) when the panel opens or closes → stop */
  onToggle(fn) { return this.panel.onToggle(fn); }

  async #loadFeed() {
    try {
      const { activity } = await getJson('/api/consoles/activity');
      const seen = new Set(this.#feed.map((e) => `${e.ts}${e.kind}${e.target}`));
      this.#feed.push(...activity.filter((e) => !seen.has(`${e.ts}${e.kind}${e.target}`)));
      this.#feed.length = Math.min(this.#feed.length, FEED_SIZE);
      this.#renderFeed();
    } catch { /* the live events still come */ }
  }

  #renderRooms() {
    this.count.textContent = t('consoles.live.count', { count: this.#rooms.length });
    if (!this.#rooms.length) {
      this.list.replaceChildren(h('li.live-empty', tNode('consoles.live.none')));
      return;
    }
    const sorted = [...this.#rooms].sort((a, b) => a.bench.localeCompare(b.bench) || a.device.localeCompare(b.device));
    this.list.replaceChildren(...sorted.map((r) => h('li.live-room', { dataset: { target: r.target } },
      h('button.live-open', { type: 'button', onclick: () => this.onOpen(r), title: t('consoles.live.join', { name: r.device }) },
        h('span.live-name', h('strong', r.device), h('span.muted', r.bench)),
        h('span.avatar-stack.live-people', ...r.users.slice(0, 3).map((u) => avatar(u, u.pilot)), r.users.length > 3 ? h('span.avatar-more', `+${r.users.length - 3}`) : null),
        h('span.live-detail',
          r.task ? t('consoles.live.task', { task: taskName(r.task.label), name: r.task.by.name })
            : r.pilot ? t('consoles.live.pilot', { name: r.pilot.name }) : t('consoles.live.noPilot'),
          r.state === 'silent' ? h('em.live-warn', t('terminal.phase.silent')) : null),
        r.lastCommand ? h('code.live-command', { title: t('consoles.live.lastCommand') }, r.lastCommand) : null))));
  }

  #renderFeed() {
    if (!this.#feed.length) {
      this.feedEl.replaceChildren(h('li.live-empty', tNode('consoles.live.quiet')));
      return;
    }
    this.feedEl.replaceChildren(...this.#feed.map((e) => h('li', h('time', { datetime: e.ts }, clock(e.ts)), h('span', describe(e)))));
  }
}

const clock = fmtTime;

/** One activity entry as a sentence */
export function describe(e) {
  const params = { name: e.user?.name ?? t('consoles.live.someone'), device: e.device, bench: e.bench, task: taskName(e.label ?? '') };
  if (e.kind === 'control') return t(`consoles.activity.control.${CONTROL_EVENTS.has(e.event) ? e.event : 'granted'}`, params);
  if (e.kind === 'task') return t(`consoles.activity.task.${['start', 'done', 'cancelled', 'failed'].includes(e.state) ? e.state : 'start'}`, params);
  if (['open', 'join', 'leave', 'freed', 'close'].includes(e.kind)) return t(`consoles.activity.${e.kind}`, params);
  return `${e.bench} ${e.device}`;
}
