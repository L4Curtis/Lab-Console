/**
 * "Lab consoles" section: lab picker + topology diagram + the shared terminal workspace
 *
 * Consoles are shared (ARCHITECTURE §9): a device someone already opened is
 * joined, not refused. The diagram shows who is on each device and who
 * holds the keyboard (the "presence" decoration layer), and three states
 * besides "free": open in my workspace, open in the application by others,
 * busy outside the application (the console server refused it lately).
 * Around it: the live panel (open consoles, people, last command, activity),
 * the bench wall, the journal notice and the journal list
 */
import { h, icon, toast, prefs, loadCss } from '../../core/dom.js';
import { getJson, live } from '../../core/api.js';
import { t, tNode, tAttr, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { workspace } from '../../shared/workspace.js';
import { SplitView } from '../../shared/splitView.js';
import { consoleSession } from '../../shared/sessions.js';
import { serverText } from '../../shared/serverText.js';
import { DiagramView } from './diagramView.js';
import { LabPicker } from './labPicker.js';
import { QuickOpen } from './quickOpen.js';
import { mountBenchBar } from '../teams/benchBar.js';
import { LivePanel } from './livePanel.js';
import { openBenchWall } from './benchWall.js';
import { openJournalDialog } from './journalDialog.js';
import { openScriptLibrary } from '../../shared/scriptLibrary.js';

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('consoles', 'terminal'), loadCss('consoles')]);
  let labs = [];
  let current = null;
  let busy = new Set();          // 'host:port' refused by the console server lately
  let rooms = new Map();         // 'host:port' → room summary
  let version = null;
  let pendingLabName = null;
  let loadError = null;
  let notesList = [];
  let retentionDays = null;

  // ── Layout ────────────────────────────────────────────────────────────────
  const head = h('header.view-head', h('div.view-title', h('h1', tNode('consoles.title')), h('p', tNode('consoles.subtitle'))));
  const picker = new LabPicker(head, { onSelect: (lab) => selectLab(lab) });
  const quick = new QuickOpen({ onPick: (lab, device) => { selectLab(lab); openDevice(device); } });
  const liveBtn = h('button.find-btn.live-btn', { type: 'button', 'aria-pressed': 'false', onclick: () => livePanel.toggle() }, icon('network'), tNode('consoles.live.button'), h('span.live-badge', { hidden: true }));
  head.append(
    liveBtn,
    h('button.find-btn', { type: 'button', onclick: () => openJournalDialog() }, icon('script'), tNode('consoles.journal.button')),
    h('button.find-btn.icon-only', { type: 'button', dataset: { action: 'scripts' }, ...tAttr('title', 'consoles.scripts.button'), ...tAttr('aria-label', 'consoles.scripts.button'), onclick: () => openScriptLibrary({ pick: false }) }, icon('library')),
    h('button.find-btn', { type: 'button', onclick: () => quick.open() }, icon('search'), tNode('consoles.find'), h('kbd', 'Ctrl K')));

  const labTitle = h('h2.canvas-title');
  const labHint = h('p.canvas-hint');
  const wallBtn = h('button.btn.small.wall-btn', { type: 'button', hidden: true, onclick: () => current && openBenchWall(current, { onOpen: (d) => openDevice(d) }) }, icon('grid'), tNode('consoles.wall.button'));
  const notesBtn = h('button.notes-btn', { type: 'button', hidden: true, onclick: () => notes.toggleAttribute('hidden') }, icon('warning'));
  const notes = h('div.notes-pop', { hidden: true });
  const canvas = h('div.diagram-canvas');
  const journalNotice = h('div.journal-notice', { hidden: true, role: 'note' });
  const livePanel = new LivePanel({ onOpen: (r) => openSummary(r) });
  livePanel.el.addEventListener('toggle', () => liveBtn.setAttribute('aria-pressed', String(livePanel.open)));
  const diagramPane = h('div.diagram-pane', journalNotice, h('div.canvas-heading', labTitle, labHint, wallBtn), canvas, notesBtn, notes, livePanel.el);
  el.append(head);
  const benchBar = mountBenchBar(el); // who holds the bench on screen (lot teams)
  const split = new SplitView(el, diagramPane, { labelKey: 'consoles.topology', onResize: () => diagram.fit() });
  const diagram = new DiagramView(canvas, { onOpen: (d) => openDevice(d) });
  benchBar.decorate(diagram);
  workspace.addEventListener('change', () => refreshStates());

  // Presence on the diagram: who is on each device, who holds the keyboard
  diagram.decorate('presence', (device) => {
    const r = rooms.get(targetOf(device));
    if (!r) return null;
    const pilot = r.users.find((u) => u.pilot);
    const others = r.users.filter((u) => !u.pilot);
    return {
      ring: r.task ? 'task' : pilot ? 'pilot' : 'live',
      badges: [...(pilot ? [pilot] : []), ...others].map((u) => ({ text: u.initials || u.name.slice(0, 2), color: u.color, title: u.pilot ? t('terminal.presence.avatarPilot', { name: u.name }) : u.name, kind: u.pilot ? 'pilot' : 'watcher' })),
      tooltip: [
        pilot ? t('consoles.live.pilot', { name: pilot.name }) : t('consoles.live.noPilot'),
        others.length ? t('consoles.diagram.watchers', { names: others.map((u) => u.name).join(', '), count: others.length }) : null,
        r.task ? t('consoles.live.task', { task: r.task.label, name: r.task.by.name }) : null,
      ],
    };
  });

  // ── Data ──────────────────────────────────────────────────────────────────
  live.on('consoles:busy', (targets) => { busy = new Set(targets); refreshStates(); });
  live.on('consoles:rooms', (list) => {
    rooms = new Map(list.map((r) => [r.target, r]));
    const badge = liveBtn.querySelector('.live-badge');
    badge.hidden = !list.length;
    badge.textContent = String(list.length);
    refreshStates();
    diagram.refresh();
    wallBtn.hidden = !current || !current.devices.some((d) => rooms.has(targetOf(d)));
  });
  // "Tell me when it is free": the answer comes to this user only
  live.on('consoles:free', (n) => {
    const key = { free: 'consoles.notify.free', open: 'consoles.notify.open', expired: 'consoles.notify.expired' }[n.state] ?? 'consoles.notify.free';
    toast(t(key, { name: n.device, bench: n.bench }), n.state === 'expired' ? 'warn' : 'info', 10_000);
  });
  // Live reload when an instructor edits the diagram (the first load doesn't
  // depend on the event stream, so a proxy that buffers SSE can't blank the page)
  live.on('labs:version', ({ version: v, error }) => {
    if (error) toast(serverText(error), 'error', 8000);
    if (version !== null && v !== version) loadLabs();
  });
  loadLabs();

  async function loadLabs() {
    try {
      const data = await getJson('/api/consoles/labs');
      version = data.version;
      loadError = null;
      labs = data.labs;
      retentionDays = data.journal?.retentionDays ?? null;
      renderNotice();
      picker.render(labs);
      quick.setLabs(labs);
      renderNotes(data.warnings);
      const keep = labs.find((l) => l.id === current?.id || l.name === pendingLabName) || labs.find((l) => l.name === prefs.get('lab')) || labs[0];
      if (keep) selectLab(keep, true);
      else labTitle.textContent = t('consoles.noLabs');
    } catch (err) {
      loadError = err.message;
      writeLoadError();
    }
  }

  function writeLoadError() {
    labTitle.textContent = t('consoles.loadFailed');
    labHint.textContent = t('consoles.loadFailedHint', { error: loadError });
  }

  function selectLab(lab, force = false) {
    if (!force && current?.id === lab.id) return;
    current = lab;
    pendingLabName = null;
    prefs.set('lab', lab.name);
    navigate(`#/consoles/${encodeURIComponent(lab.name)}`);
    picker.setActive(lab.id);
    labTitle.textContent = lab.name;
    benchBar.setBench(lab.name);
    writeHint();
    diagram.render(lab);
    refreshStates();
    wallBtn.hidden = !lab.devices.some((d) => rooms.has(targetOf(d)));
  }

  function writeHint() {
    labHint.textContent = current && current.devices.length
      ? t('consoles.hint', { count: current.devices.length })
      : t('consoles.noDevice');
  }

  // Sessions are journaled: say it, once, until the user has read it
  function renderNotice() {
    if (retentionDays === null || prefs.get('journalNoticeSeen', false)) { journalNotice.hidden = true; return; }
    journalNotice.replaceChildren(
      icon('script'),
      h('p', t('consoles.journal.notice', { days: retentionDays })),
      h('button.btn.small.subtle', { type: 'button', onclick: () => openJournalDialog() }, tNode('consoles.journal.button')),
      h('button.icon-btn', { type: 'button', ...tAttr('title', 'consoles.journal.dismiss'), onclick: () => { prefs.set('journalNoticeSeen', true); journalNotice.hidden = true; } }, icon('close')));
    journalNotice.hidden = false;
  }

  // ── Consoles ──────────────────────────────────────────────────────────────
  const targetOf = (d) => `${d.target.host}:${d.target.port}`;

  function openDevice(device) {
    const session = consoleSession(device, current?.name ?? '');
    // Tiles are keyed by console line, so a device shown on several pages reuses its tile
    if (workspace.panes.has(session.key)) return workspace.open(session);
    if (!device.allowed) return toast(t('consoles.notAllowed', { name: device.name }), 'warn');
    // Anyone may watch a line that is already open; opening a new one needs the
    // right to pilot it (SPEC "Permissions"), on any bench of the device. The server decides again.
    if (!rooms.has(targetOf(device))) {
      const benches = labs.filter((l) => l.devices.some((d) => targetOf(d) === targetOf(device))).map((l) => l.name);
      if (!benchBar.mayOpen(device, benches)) return toast(benchBar.refusal(benches), 'warn', 6000);
    }
    workspace.open(session);
    diagram.pulse(device.key);
  }

  /** A console of the live panel: its device on its bench */
  function openSummary(r) {
    const lab = labs.find((l) => l.name === r.bench) ?? labs.find((l) => l.devices.some((d) => targetOf(d) === r.target));
    const device = lab?.devices.find((d) => d.key === r.key) ?? lab?.devices.find((d) => targetOf(d) === r.target);
    if (!device) return toast(t('consoles.live.elsewhere', { name: r.device, bench: r.bench }), 'info');
    selectLab(lab);
    openDevice(device);
  }

  function refreshStates() {
    const mine = workspace.liveTargets();
    diagram.setStates((d) => {
      if (!d.allowed) return 'disabled';
      if (mine.has(targetOf(d))) return 'open';
      if (rooms.has(targetOf(d))) return 'live';
      return busy.has(targetOf(d)) ? 'busy' : 'idle';
    });
    picker.setLive(new Set(labs.filter((l) => l.devices.some((d) => mine.has(targetOf(d)))).map((l) => l.id)));
  }

  // Each warning is { code, params, message }: translated by code, English sentence otherwise
  function renderNotes(warnings = notesList) {
    notesList = warnings;
    notesBtn.hidden = !warnings.length;
    notesBtn.replaceChildren(icon('warning'), h('span', t('consoles.notes', { count: warnings.length })));
    notes.replaceChildren(h('p', tNode('consoles.notesIntro')), h('ul', warnings.map((w) => h('li', serverText(w)))));
  }

  // Sentences made with a number or a name are written again when the language changes
  const offLocale = onLocaleChange(() => {
    renderNotes();
    renderNotice();
    if (loadError) writeLoadError();
    else if (current) writeHint();
    else if (labs.length === 0 && labTitle.textContent) labTitle.textContent = t('consoles.noLabs');
    refreshStates();
    diagram.refresh();
  });

  // Ctrl+K or "/" opens the device finder - but never steals keys from a terminal
  // (Ctrl+K is "erase to end of line" on Cisco IOS)
  const onKey = (e) => {
    if (el.hidden || e.target.closest?.('.xterm, input, textarea')) return;
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || e.key === '/') {
      e.preventDefault();
      quick.open();
    }
  };
  document.addEventListener('keydown', onKey);

  return {
    show([labName] = []) {
      if (labName) {
        const lab = labs.find((l) => l.name === labName);
        if (lab) selectLab(lab);
        else pendingLabName = labName;
      }
      split.activate();
    },
    // Sections stay mounted today; whoever unmounts this one calls destroy() so
    // nothing keeps drawing on a detached diagram
    destroy() {
      diagram.destroy();
      offLocale();
      document.removeEventListener('keydown', onKey);
    },
  };
}
