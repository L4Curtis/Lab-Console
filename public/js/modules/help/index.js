/**
 * "Help" section (#/help[/<section>]), for everyone signed in: what each part
 * of Lab Console does, the home page and the overview, how a team takes a
 * bench, sharing a console, backups, injection and reset, the bench checks,
 * the password recovery, what is journaled, what to do when a line is busy,
 * and the keyboard shortcuts
 *
 * The text is in the `help` dictionary (help.s.<section>.<key>); this file
 * only says which keys make which section. The few figures that the server
 * decides (journal retention, the bench's idle release, the session length)
 * are read when the page opens; while they are unknown, or if the request
 * fails, the sentence is the one without a number
 */
import { h, icon, loadCss } from '../../core/dom.js';
import { getJson } from '../../core/api.js';
import { t, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { isCompact, isCoarse, onViewportChange } from '../../core/viewport.js';
import { pageHeader } from '../../shared/pageHeader.js';
import { openMenu } from '../../shared/menu.js';
import { startTour } from './tour.js';

/**
 * A block is one of:
 *   { p: key }  { note: key }  { h: key }  { ul: [item] }  { ol: [item] }
 *   { keys: [id] }  { link: key, href }
 * and an item is a key, or { key, when(figures), params(figures) } for the
 * sentences that carry a figure
 */
const SECTIONS = [
  { id: 'sections', blocks: [
    { p: 'intro' },
    { ul: ['home', 'consoles', 'team', 'jobs', 'infra', 'status', 'admin', 'account', 'help', 'extras'] },
  ] },
  { id: 'home', blocks: [
    { p: 'intro' },
    { ul: ['homeTeam', 'homeBackups', 'homeActivity', 'homeNone'] },
    { ul: ['overview', 'overviewLines', 'overviewFilter', 'overviewPrivate'] },
  ] },
  { id: 'team', blocks: [
    { p: 'intro' },
    { ol: ['step1', 'step2', 'step3', 'step4'] },
    { ul: [
      { key: 'idle', when: (f) => f.idleHours !== null, params: (f) => ({ hours: f.idleHours }) },
      { key: 'idleUnknown', when: (f) => f.idleHours === null },
      'taken', 'free', 'reserve', 'lock', 'history', 'group',
    ] },
  ] },
  { id: 'share', blocks: [
    { p: 'intro' },
    { ul: ['who', 'ask', 'give', 'admin', 'task', 'free', 'live', 'tools'] },
  ] },
  { id: 'backup', blocks: [
    { note: 'warning' },
    { ol: ['step1', 'step2', 'step3', 'step4'] },
    { ul: ['offer', 'list', 'owner', 'templates', 'cisco', 'single'] },
  ] },
  { id: 'tasks', blocks: [
    { p: 'intro' },
    { h: 'injectTitle' },
    { ul: ['inject1', 'inject2', 'inject3', 'inject4'] },
    { h: 'resetTitle' },
    { ul: ['reset1', 'reset2', 'reset3', 'reset4', 'reset5'] },
    { p: 'stop' },
  ] },
  { id: 'checks', blocks: [
    { p: 'intro' },
    { ul: ['lines', 'cabling', 'ping', 'interfaces'] },
    { ul: ['who', 'untouched', 'results', 'stop', 'limits'] },
  ] },
  { id: 'recovery', blocks: [
    { p: 'intro' },
    { ol: ['step1', 'step2', 'step3', 'step4'] },
    { ul: ['kept', 'notLocked', 'stop', 'who', 'close', 'families', 'disabled'] },
  ] },
  { id: 'journal', blocks: [
    { p: 'intro' },
    { ul: [
      { key: 'consoles', when: (f) => f.journalDays !== null, params: (f) => ({ days: f.journalDays }) },
      { key: 'consolesUnknown', when: (f) => f.journalDays === null },
      'jobs', 'audit', 'kept',
      { key: 'session', when: (f) => f.sessionIdle !== null, params: (f) => ({ idle: f.sessionIdle, max: f.sessionMax }) },
      'never',
    ] },
    { link: 'open', href: '#/status/journaling' },
  ] },
  { id: 'trouble', blocks: [
    { h: 'busyTitle' }, { p: 'busy' }, { p: 'busy2' },
    { h: 'silentTitle' }, { p: 'silent' },
    { h: 'lockedTitle' }, { p: 'locked' }, { p: 'locked2' },
    { h: 'dialogTitle' }, { p: 'dialog' },
    { h: 'watchTitle' }, { p: 'watch' },
    { h: 'lostTitle' }, { p: 'lost' },
  ] },
  { id: 'phone', blocks: [
    { p: 'intro' },
    { ul: ['tabbar', 'consoles', 'screen', 'toolbar', 'line', 'interrupt', 'landscape'] },
  ] },
  { id: 'keys', blocks: [
    { p: 'intro' },
    { keys: ['finder', 'finderMove', 'device', 'copy', 'send', 'chat', 'close', 'splitter'] },
  ] },
];

const NO_FIGURES = { journalDays: null, idleHours: null, sessionIdle: null, sessionMax: null };

export async function mount(el) {
  await Promise.all([loadNamespace('help'), loadCss('help')]);
  let figures = { ...NO_FIGURES };
  let wanted = null;           // the section the address asks for
  const open = new Set();      // the sections unfolded on a phone

  const header = pageHeader({
    title: 'help.title',
    context: 'help.subtitle',
    actions: [{ id: 'replay-tour', label: 'help.replayTour', icon: 'tour', run: () => startTour() }],
  });
  const toc = h('nav.help-toc', { 'aria-label': t('help.toc') });
  const summary = h('button.btn.help-summary', { type: 'button', 'aria-haspopup': 'menu', dataset: { action: 'summary' }, onclick: (e) => pickSection(e.currentTarget) }, icon('menu'), h('span.lbl'));
  const article = h('div.help-sections');
  const body = h('div.view-body');
  body.append(h('div.help-body', toc, h('div.help-main', summary, article)));
  el.append(header.el, body);

  const text = (section, item) => {
    const key = typeof item === 'string' ? item : item.key;
    return t(`help.s.${section}.${key}`, typeof item === 'string' ? undefined : item.params?.(figures));
  };
  const shown = (items, f) => items.filter((i) => typeof i === 'string' || i.when?.(f) !== false);

  function renderBlock(section, block) {
    if (block.p) return h('p', text(section, block.p));
    if (block.note) return h('p.help-note', { role: 'note' }, text(section, block.note));
    if (block.h) return h('h3', text(section, block.h));
    if (block.ul) return h('ul', shown(block.ul, figures).map((i) => h('li', text(section, i))));
    if (block.ol) return h('ol', shown(block.ol, figures).map((i) => h('li', text(section, i))));
    if (block.link) return h('p', h('a.btn.sm', { href: block.href }, text(section, block.link)));
    if (block.keys) {
      return h('table.help-keys',
        h('thead', h('tr', h('th', t('help.s.keys.col.keys')), h('th', t('help.s.keys.col.what')))),
        h('tbody', block.keys.map((id) => h('tr', h('td', h('kbd', t(`help.s.keys.${id}.keys`))), h('td', t(`help.s.keys.${id}.what`))))));
    }
    return null;
  }

  /** On a phone a section is folded (its title is the button); from 720 px all of them are open */
  const isOpen = (id) => !isCompact() || open.has(id);

  function renderSection(s) {
    const id = `help-${s.id}`;
    const on = isOpen(s.id);
    const toggle = h('button.help-toggle', { type: 'button', 'aria-expanded': String(on), 'aria-controls': `${id}-body`, dataset: { toggle: s.id },
      onclick: () => { if (open.has(s.id)) open.delete(s.id); else open.add(s.id); render(); } },
    h('span', { id: `${id}-title` }, t(`help.s.${s.id}.title`)), isCompact() ? icon(on ? 'chevronUp' : 'chevronDown') : null);
    return h('section.card.help-section', { id, dataset: { section: s.id }, 'aria-labelledby': `${id}-title` },
      h('h2', toggle),
      h('div.help-text', { id: `${id}-body`, hidden: !on }, s.blocks.map((b) => renderBlock(s.id, b))));
  }

  /** The keyboard shortcuts mean nothing on a touch screen: "Sur téléphone" takes their place there */
  const sections = () => SECTIONS.filter((s) => !(isCoarse() && s.id === 'keys'));

  function render() {
    const list = sections();
    toc.replaceChildren(h('strong', t('help.toc')), h('ul', list.map((s) =>
      h('li', h('a', { href: `#/help/${s.id}`, dataset: { section: s.id } }, t(`help.s.${s.id}.title`))))));
    toc.setAttribute('aria-label', t('help.toc'));
    summary.querySelector('.lbl').textContent = t('help.summary');
    article.replaceChildren(...list.map(renderSection));
  }

  async function pickSection(button) {
    const id = await openMenu(button, sections().map((s) => ({ id: s.id, label: () => t(`help.s.${s.id}.title`) })), { label: t('help.summary') });
    if (id) location.hash = `#/help/${id}`;
  }

  async function loadFigures() {
    const [journaling, benches] = await Promise.allSettled([getJson('/api/admin/journaling'), getJson('/api/benches')]);
    const j = journaling.status === 'fulfilled' ? journaling.value : null;
    const idle = benches.status === 'fulfilled' ? benches.value?.idleHours : null;
    figures = {
      journalDays: j?.consoleJournal?.enabled ? j.consoleJournal.retentionDays : null,
      idleHours: Number.isFinite(idle) ? idle : null,
      sessionIdle: j?.sessions?.idleHours ?? null,
      sessionMax: j?.sessions?.maxHours ?? null,
    };
    render();
  }

  function scrollTo(id) {
    const target = id && el.querySelector(`#help-${CSS.escape(id)}`);
    if (target) {
      if (!open.has(id)) { open.add(id); render(); }
      el.querySelector(`#help-${CSS.escape(id)}`).scrollIntoView({ block: 'start' });
    } else body.scrollTo({ top: 0 });
  }

  render();
  onLocaleChange(render);
  let compact = isCompact();
  onViewportChange((now) => { if (now.compact !== compact) { compact = now.compact; render(); } });
  return {
    show: ([section] = []) => {
      wanted = section ?? null;
      loadFigures();
      scrollTo(wanted);
    },
  };
}
