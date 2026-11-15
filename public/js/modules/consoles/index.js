/**
 * The Consoles section (UX.md §8): the bench on screen, its diagram (or its
 * devices as a list) and the shared terminal workspace
 *
 *   header       "Consoles", the bench picker, the device finder (Ctrl K, "/"),
 *                En direct and Discussion (side panels), Outils ▾ (checks, the
 *                console wall, journals, the script library)
 *   bench line   who holds the bench (the bench strip of the teams section)
 *   notice       once per browser: consoles are journaled (pushes the
 *                content down, never covers it)
 *   body         diagram | splitter | workspace; the side panels beside them
 *
 * On a phone (UX.md §8.3) the same section has two screens: the bench
 * (`#/consoles/B4M`: the diagram, pinch and pan, or the list; a dock back to
 * the open consoles) and a console on the whole screen
 * (`#/consoles/B4M/R1`, consoleScreen.js). Back returns to the bench; the
 * consoles stay connected.
 *
 * Consoles are shared (ARCHITECTURE §9): a device someone already opened is
 * joined, not refused. The diagram shows who is on each device and who
 * holds the keyboard (the "presence" layer), and three states besides
 * "free": open in my workspace, open in the application by others, busy
 * outside the application (the console server refused it lately)
 */
import { h, icon, toast, prefs, loadCss } from '../../core/dom.js';
import { getJson, live } from '../../core/api.js';
import { t, tNode, tAttr, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { isCompact, isCoarse, onViewportChange } from '../../core/viewport.js';
import { workspace } from '../../shared/workspace.js';
import { SplitView } from '../../shared/splitView.js';
import { consoleSession } from '../../shared/sessions.js';
import { serverText } from '../../shared/serverText.js';
import { pageHeader } from '../../shared/pageHeader.js';
import { openMenu } from '../../shared/menu.js';
import { sideHost } from '../../shared/sidePanel.js';
import { loadFailure, emptyState } from '../../shared/loadState.js';
import { DiagramView } from './diagramView.js';
import { BenchPicker } from './benchPicker.js';
import { DeviceList } from './deviceList.js';
import { Dock } from './dock.js';
import { consoleScreen } from './consoleScreen.js';
import { openDeviceSheet } from './deviceSheet.js';
import { QuickOpen } from './quickOpen.js';
import { mountBenchBar } from '../teams/benchBar.js';
import { myBenchName, onBenches } from '../teams/data.js';
import { LivePanel } from './livePanel.js';
import { openBenchWall } from './benchWall.js';
import { openJournalDialog } from './journalDialog.js';
import { openScriptLibrary } from '../../shared/scriptLibrary.js';
import { mountBenchPanel } from '../collab/benchPanel.js';
import { knowDevices } from '../collab/notes.js';
import { openChecksDialog } from '../checks/dialog.js';

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('consoles', 'terminal'), loadCss('consoles'), loadCss('terminal')]);
  let labs = [];
  let current = null;
  let busy = new Set();          // 'host:port' refused by the console server lately
  let rooms = new Map();         // 'host:port' → room summary
  let version = null;
  let pendingLabName = null;
  let pendingDevice = null;      // a device in the address, until the labs are there
  let loadError = null;
  let notesList = [];
  let retentionDays = null;
  let shown = false;
  let autoPicked = false;        // the bench on screen is the default one, not a choice (the first answer about benches may change it)
  let pushedScreen = false;      // the console screen added a history entry (Back takes it away)
  // The list on a phone (a diagram that does not fit makes a student pan before the first tap); the diagram elsewhere, unless chosen
  let view = prefs.get('consolesView', null) ?? (isCompact() ? 'list' : 'diagram');

  const targetOf = (d) => `${d.target.host}:${d.target.port}`;
  const stateOf = (d) => {
    if (!d.allowed) return 'disabled';
    if (workspace.liveTargets().has(targetOf(d))) return 'open';
    if (rooms.has(targetOf(d))) return 'live';
    return busy.has(targetOf(d)) ? 'busy' : 'idle';
  };
  /** The bench of a tile (its subtitle) and the address of its console screen */
  const labOf = (pane) => labs.find((l) => l.name === pane.session.subtitle) ?? null;
  const addressOf = (pane) => `#/consoles/${encodeURIComponent(pane.session.subtitle ?? current?.name ?? '')}/${encodeURIComponent(pane.session.title)}`;

  // ── Header ────────────────────────────────────────────────────────────────
  const header = pageHeader({ title: 'consoles.title', full: true });
  header.el.classList.add('consoles-header');
  const picker = new BenchPicker({ onSelect: (lab) => selectLab(lab), openCount: (lab) => lab.devices.filter((d) => rooms.has(targetOf(d))).length });
  const quick = new QuickOpen({ onPick: (lab, device) => { selectLab(lab); openDevice(device); } });
  header.heading.after(picker.button('.in-header'));

  const finder = h('button.finder', { type: 'button', dataset: { action: 'find' }, onclick: () => quick.open() },
    icon('search'), h('span.finder-text', tNode('consoles.find')), h('kbd', 'Ctrl K'));
  const liveCount = h('span.count', { hidden: true });
  const liveBtn = h('button.btn.live-btn', { type: 'button', 'aria-pressed': 'false', dataset: { action: 'live' }, onclick: () => livePanel.toggle() },
    icon('network'), h('span.btn-label', tNode('consoles.live.button')), liveCount);
  const toolsBtn = h('button.btn.tools-btn', { type: 'button', 'aria-haspopup': 'menu', dataset: { action: 'tools' }, onclick: () => toolsMenu(toolsBtn) },
    icon('more', 'tools-more'), h('span.btn-label', tNode('consoles.tools.title')), icon('chevronDown', 'tools-chevron'));
  const tools = h('div.cs-tools', finder, liveBtn); // Discussion joins once the panel is mounted, before Outils

  // ── Bench line, notice ────────────────────────────────────────────────────
  const benchLine = h('div.cs-benchline');
  const linePicker = picker.button('.in-line'); // on a phone: the first thing of the bench strip's line (UX.md §8.3)
  let noticeOnScreen = false;  // shown once per browser: on screen until closed or the page is left, then never again
  const noticeText = h('p');
  const notice = h('div.cs-notice', { role: 'note', hidden: true },
    icon('info'), noticeText,
    h('a.btn.sm.ghost', { href: '#/help/journal', dataset: { action: 'journal-help' } }, tNode('consoles.journal.more')),
    h('button.icon-btn', { type: 'button', ...tAttr('title', 'consoles.journal.dismiss'), ...tAttr('aria-label', 'consoles.journal.dismiss'), onclick: () => { noticeOnScreen = false; notice.hidden = true; } }, icon('close')));

  // ── The diagram, the list ─────────────────────────────────────────────────
  const viewBtns = Object.fromEntries(['diagram', 'list'].map((v) => [v,
    h('button.seg-btn', { type: 'button', dataset: { view: v }, 'aria-pressed': String(v === view), onclick: () => setView(v) }, icon(v === 'diagram' ? 'topology' : 'rows'), tNode(`consoles.view.${v}`))]));
  const viewSeg = h('div.seg.fill-compact.cs-view', { role: 'group', ...tAttr('aria-label', 'consoles.view.label') }, Object.values(viewBtns));
  const hint = h('p.canvas-hint');
  const notesBtn = h('button.btn.sm.notes-btn', { type: 'button', hidden: true, 'aria-expanded': 'false', onclick: () => { notes.hidden = !notes.hidden; notesBtn.setAttribute('aria-expanded', String(!notes.hidden)); } });
  const notes = h('div.notes-pop', { hidden: true });
  const canvas = h('div.diagram-canvas');
  const failure = h('div.cs-state', { hidden: true });
  const deviceList = new DeviceList({ onOpen: (d) => openDevice(d), onMenu: (d) => deviceMenu(d) });
  const listWrap = h('div.device-list-wrap', deviceList.el);
  const dock = new Dock({ onOpen: (pane) => enterScreen(pane, true) });
  canvas.append(hint, notesBtn, notes);
  const stage = h('div.cs-stage', viewSeg, canvas, listWrap, failure, dock.el);
  const diagramPane = h('div.diagram-pane', { dataset: { state: 'loading', view } }, notice, stage);

  el.append(header.el, benchLine);
  const body = h('div.cs-body');
  el.append(body);
  const split = new SplitView(body, diagramPane, { labelKey: 'consoles.topology', onResize: () => diagram.fit() });
  const host = sideHost(body);
  const livePanel = new LivePanel({ host, onOpen: (r) => openSummary(r) });
  // The notes and the chat of the bench (lot collab) share the side with the live panel: one at a time
  const group = mountBenchPanel({ host });
  tools.append(group.button, toolsBtn);
  header.el.append(tools);
  livePanel.onToggle((on) => { liveBtn.setAttribute('aria-pressed', String(on)); requestAnimationFrame(() => { diagram.refit(); workspace.refit(); }); });
  group.onToggle(() => requestAnimationFrame(() => { diagram.refit(); workspace.refit(); }));

  const benchBar = mountBenchBar(benchLine, { variant: 'strip', lead: linePicker }); // who holds the bench on screen (lot teams)
  const diagram = new DiagramView(canvas, {
    onOpen: (d) => openDevice(d),
    onMenu: (d) => deviceMenu(d),
    insets: () => {
      const box = canvas.getBoundingClientRect();
      const over = (n) => (n.hidden || !n.offsetParent ? 0 : n.getBoundingClientRect());
      const top = over(hint);
      const bottom = [diagram.controls, notesBtn, dock.el].map(over).filter(Boolean);
      return {
        top: top ? Math.max(0, top.bottom - box.top + 8) : 0,
        bottom: Math.max(0, ...bottom.map((r) => box.bottom - r.top + 8)),
      };
    },
  });
  benchBar.decorate(diagram);
  const screen = consoleScreen({
    section: el,
    onLeave: () => leaveScreen(),
    onSwitch: (pane) => {
      const lab = labOf(pane);
      if (lab && lab.id !== current?.id) selectLab(lab, false, false);
      navigate(addressOf(pane));
    },
  });
  workspace.addEventListener('change', () => { refreshStates(); writeHint(); });

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
    liveCount.hidden = !list.length;
    liveCount.textContent = String(list.length);
    refreshStates();
    diagram.refresh();
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
  // The first state of the benches tells which one is mine: it replaces a default pick that was only the last used or the first
  const offBenches = onBenches(() => {
    if (!autoPicked || !labs.length) return;
    autoPicked = false;
    const mine = labs.find((l) => l.name === myBenchName());
    if (mine && mine.id !== current?.id) selectLab(mine, false, false);
  });
  loadLabs();

  async function loadLabs() {
    try {
      const data = await getJson('/api/consoles/labs');
      version = data.version;
      loadError = null;
      labs = data.labs;
      knowDevices(labs);
      retentionDays = data.journal?.retentionDays ?? null;
      renderNotice();
      picker.render(labs);
      quick.setLabs(labs);
      renderNotes(data.warnings);
      // The bench of the address or already on screen; else the one my team works on, the one I used last, the first
      const chosen = labs.find((l) => l.id === current?.id || l.name === pendingLabName);
      const mine = labs.find((l) => l.name === myBenchName());
      const keep = chosen || mine || labs.find((l) => l.name === prefs.get('lab')) || labs[0];
      if (keep) {
        diagramPane.dataset.state = 'ready';
        failure.hidden = true;
        failure.replaceChildren();
        selectLab(keep, true, false);
        autoPicked = !chosen && !mine; // the benches' state may not have arrived yet
        openPendingDevice();
      } else {
        diagramPane.dataset.state = 'empty';
        failure.replaceChildren(emptyState({ icon: 'topology', title: 'consoles.noLabs', text: 'consoles.noLabsHint' }));
        failure.hidden = false;
      }
    } catch (err) {
      loadError = err;
      diagramPane.dataset.state = 'failed';
      writeLoadError();
    }
  }

  function writeLoadError() {
    failure.replaceChildren(loadFailure('consoles.loadFailed', loadError, () => { failure.hidden = true; diagramPane.dataset.state = 'loading'; loadLabs(); }));
    failure.hidden = false;
  }

  /** `address`: write the bench in the address (not when the address is what brought us here) */
  function selectLab(lab, force = false, address = true) {
    if (!force && current?.id === lab.id) return;
    current = lab;
    autoPicked = false;
    pendingLabName = null;
    prefs.set('lab', lab.name);
    el.dataset.bench = lab.name;
    if (address && !screen.active) navigate(`#/consoles/${encodeURIComponent(lab.name)}`);
    picker.setActive(lab.id);
    benchBar.setBench(lab.name);
    group.setBench(lab);
    diagram.render(lab);
    refreshStates();
    writeHint();
  }

  function setView(next, { chosen = true } = {}) {
    view = next;
    if (chosen) prefs.set('consolesView', next);
    diagramPane.dataset.view = next;
    for (const [v, b] of Object.entries(viewBtns)) b.setAttribute('aria-pressed', String(v === next));
    if (next === 'diagram') requestAnimationFrame(() => diagram.refit());
  }

  // Until the person chooses, a diagram column too narrow to read (consoles open beside it) shows the list
  const NARROW_PX = 400;
  new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width;
    if (!width || prefs.get('consolesView', null) !== null || isCompact()) return;
    const next = width < NARROW_PX ? 'list' : width >= NARROW_PX + 40 ? 'diagram' : view; // a little room before it flips back
    if (next !== view) setView(next, { chosen: false });
  }).observe(diagramPane);

  /** The hint over the canvas while no console is open: what to do, with a mouse or a finger */
  function writeHint() {
    hint.hidden = !current || workspace.panes.size > 0 || diagramPane.dataset.state !== 'ready';
    hint.textContent = !current ? '' : current.devices.length
      ? t(isCoarse() ? 'consoles.hintTouch' : 'consoles.hint', { count: current.devices.length })
      : t('consoles.noDevice');
  }

  // Sessions are journaled: say it, once, until the user has read it
  function renderNotice() {
    const show = retentionDays !== null && (noticeOnScreen || !prefs.get('journalNoticeSeen', false));
    notice.hidden = !show;
    if (show && !noticeOnScreen) { noticeOnScreen = true; prefs.set('journalNoticeSeen', true); }
    noticeText.textContent = retentionDays === null ? '' : t('consoles.journal.notice', { days: retentionDays });
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  /** Outils: checks, the console wall, journals, the script library; on a phone also the finder and En direct */
  async function toolsMenu(anchor) {
    const compact = isCompact();
    const openHere = current ? current.devices.some((d) => rooms.has(targetOf(d))) : false;
    await openMenu(anchor, [
      compact ? { id: 'find', icon: 'search', label: 'consoles.find', run: () => quick.open() } : null,
      compact ? { id: 'live', icon: 'network', label: 'consoles.live.button', trail: rooms.size ? String(rooms.size) : null, run: () => livePanel.toggle(true) } : null,
      compact ? 'separator' : null,
      { id: 'checks', icon: 'check', label: 'consoles.tools.checks', disabled: !current, run: () => current && openChecksDialog(current) },
      { id: 'wall', icon: 'grid', label: 'consoles.tools.wall', disabled: !openHere, hint: openHere ? null : 'consoles.tools.wallNone', run: () => current && openBenchWall(current, { onOpen: (d) => openDevice(d) }) },
      { id: 'journals', icon: 'script', label: 'consoles.tools.journals', run: () => openJournalDialog() },
      { id: 'scripts', icon: 'library', label: 'consoles.tools.scripts', run: () => openScriptLibrary({ pick: false }) },
    ], { label: t('consoles.tools.title') });
  }

  // ── Consoles ──────────────────────────────────────────────────────────────
  /** → the tile, or null when the console may not be opened from here */
  function openDevice(device) {
    const session = consoleSession(device, current?.name ?? '');
    // Tiles are keyed by console line, so a device shown on several pages reuses its tile
    let pane = workspace.panes.get(session.key);
    if (pane) workspace.open(session);
    else {
      if (!device.allowed) { toast(t('consoles.notAllowed', { name: device.name }), 'warn'); return null; }
      // Anyone may watch a line that is already open; opening a new one needs the
      // right to pilot it (SPEC "Permissions"), on any bench of the device. The server decides again.
      if (!rooms.has(targetOf(device))) {
        const benches = labs.filter((l) => l.devices.some((d) => targetOf(d) === targetOf(device))).map((l) => l.name);
        if (!benchBar.mayOpen(device, benches)) { toast(benchBar.refusal(benches), 'warn', 6000); return null; }
      }
      pane = workspace.open(session);
      diagram.pulse(device.key);
    }
    // On a phone a console opens on the whole screen
    if (isCompact()) enterScreen(pane, true);
    return pane;
  }

  /** A long press (or a right click) on a device: its sheet */
  function deviceMenu(device) {
    openDeviceSheet(device, { bench: current?.name ?? '', state: stateOf(device), room: rooms.get(targetOf(device)), onOpen: (d) => openDevice(d) });
  }

  /** A console of the live panel: its device on its bench */
  function openSummary(r) {
    const lab = labs.find((l) => l.name === r.bench) ?? labs.find((l) => l.devices.some((d) => targetOf(d) === r.target));
    const device = lab?.devices.find((d) => d.key === r.key) ?? lab?.devices.find((d) => targetOf(d) === r.target);
    if (!device) return toast(t('consoles.live.elsewhere', { name: r.device, bench: r.bench }), 'info');
    livePanel.toggle(false);
    selectLab(lab);
    openDevice(device);
  }

  /** The device of the address (#/consoles/B4M/R1): opened once the labs are there */
  function openPendingDevice() {
    if (!pendingDevice || !current) return;
    const name = pendingDevice;
    pendingDevice = null;
    const device = current.devices.find((d) => d.name === name);
    if (!device) { toast(t('consoles.unknownDevice', { name, bench: current.name }), 'warn'); navigate(`#/consoles/${encodeURIComponent(current.name)}`); return; }
    if (!openDevice(device) && screen.active) leaveScreen();
  }

  // ── The console screen of a phone ─────────────────────────────────────────

  function enterScreen(pane, push) {
    if (!isCompact()) return;
    const address = addressOf(pane);
    if (push && !screen.active && location.hash !== address) {
      navigate(address, { replace: false });
      pushedScreen = true;
    } else navigate(address);
    screen.enter(pane);
    dock.render();
  }

  /** Back to the bench: the history entry of the console screen goes, when it added one */
  function leaveScreen({ fromAddress = false } = {}) {
    if (!screen.active) return;
    screen.leave();
    const bench = `#/consoles/${encodeURIComponent(current?.name ?? '')}`;
    if (!fromAddress) {
      if (pushedScreen) history.back();
      else navigate(bench);
    }
    pushedScreen = false;
    requestAnimationFrame(() => { diagram.refit(); writeHint(); });
  }

  /** The open console the address names (#/consoles/B4M/R2), when there is one */
  function paneOfAddress() {
    const [, section, bench, device] = location.hash.split('/').map((x) => decodeURIComponent(x));
    if (section !== 'consoles' || !bench || !device) return null;
    return [...workspace.panes.values()].find((p) => p.session.title === device && p.session.subtitle === bench) ?? null;
  }

  // The window grows past the phone's width: the console screen becomes tiles again. A narrow one
  // (a phone turned upright or on its side) shows the console its address names on the whole screen
  onViewportChange(({ compact }) => {
    if (!compact && screen.active) { screen.leave(); pushedScreen = false; }
    else if (compact && shown && !screen.active) {
      const pane = paneOfAddress();
      if (pane) { screen.enter(pane); dock.render(); }
    }
    writeHint();
  });

  function refreshStates() {
    const mine = workspace.liveTargets();
    diagram.setStates(stateOf);
    deviceList.render(current, { stateOf, roomOf: (d) => rooms.get(targetOf(d)) });
    picker.setLive(new Set(labs.filter((l) => l.devices.some((d) => mine.has(targetOf(d)))).map((l) => l.id)));
    picker.refresh();
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
    writeHint();
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
    show([labName, deviceName] = []) {
      shown = true;
      if (labName) {
        const lab = labs.find((l) => l.name === labName);
        if (lab) selectLab(lab, false, false);
        else pendingLabName = labName;
      }
      split.activate();
      // The address names a device: open it (the console screen on a phone); without one, back to the bench
      if (deviceName) {
        const pane = [...workspace.panes.values()].find((p) => p.session.title === deviceName && p.session.subtitle === (labName ?? current?.name));
        if (pane) { workspace.open(pane.session); if (isCompact()) screen.enter(pane); } else { pendingDevice = deviceName; if (labs.length) openPendingDevice(); }
      } else if (screen.active) leaveScreen({ fromAddress: true });
      requestAnimationFrame(() => { diagram.refit(); writeHint(); dock.render(); });
    },
    hide() {
      shown = false;
      if (screen.active) { screen.leave(); pushedScreen = false; }
      livePanel.toggle(false);
      group.toggle(false);
    },
    // Sections stay mounted today; whoever unmounts this one calls destroy() so
    // nothing keeps drawing on a detached diagram
    destroy() {
      diagram.destroy();
      offLocale();
      offBenches();
      document.removeEventListener('keydown', onKey);
    },
    get shown() { return shown; },
  };
}
