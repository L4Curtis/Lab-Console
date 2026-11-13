/**
 * "Lab consoles" section: lab picker + topology diagram + the shared terminal workspace
 */
import { h, icon, toast, prefs } from '../../core/dom.js';
import { getJson, live } from '../../core/api.js';
import { t, tNode, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { workspace } from '../../shared/workspace.js';
import { SplitView } from '../../shared/splitView.js';
import { consoleSession } from '../../shared/sessions.js';
import { serverText } from '../../shared/serverText.js';
import { DiagramView } from './diagramView.js';
import { LabPicker } from './labPicker.js';
import { QuickOpen } from './quickOpen.js';
import { mountBenchBar } from '../teams/benchBar.js';

export async function mount(el, { navigate }) {
  await loadNamespace('consoles', 'terminal');
  let labs = [];
  let current = null;
  let busy = new Set();
  let version = null;
  let pendingLabName = null;
  let loadError = null;
  let notesList = [];

  // ── Layout ────────────────────────────────────────────────────────────────
  const head = h('header.view-head', h('div.view-title', h('h1', tNode('consoles.title')), h('p', tNode('consoles.subtitle'))));
  const picker = new LabPicker(head, { onSelect: (lab) => selectLab(lab) });
  const quick = new QuickOpen({ onPick: (lab, device) => { selectLab(lab); openDevice(device); } });
  head.append(h('button.find-btn', { type: 'button', onclick: () => quick.open() }, icon('search'), tNode('consoles.find'), h('kbd', 'Ctrl K')));

  const labTitle = h('h2.canvas-title');
  const labHint = h('p.canvas-hint');
  const notesBtn = h('button.notes-btn', { type: 'button', hidden: true, onclick: () => notes.toggleAttribute('hidden') }, icon('warning'));
  const notes = h('div.notes-pop', { hidden: true });
  const canvas = h('div.diagram-canvas');
  const diagramPane = h('div.diagram-pane', h('div.canvas-heading', labTitle, labHint), canvas, notesBtn, notes);
  el.append(head);
  const benchBar = mountBenchBar(el); // who holds the bench on screen (lot teams)
  const split = new SplitView(el, diagramPane, { labelKey: 'consoles.topology', onResize: () => diagram.fit() });
  const diagram = new DiagramView(canvas, { onOpen: (d) => openDevice(d) });
  benchBar.decorate(diagram);
  workspace.addEventListener('change', () => refreshStates());

  // ── Data ──────────────────────────────────────────────────────────────────
  live.on('consoles:busy', (targets) => { busy = new Set(targets); refreshStates(); });
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
  }

  function writeHint() {
    labHint.textContent = current && current.devices.length
      ? t('consoles.hint', { count: current.devices.length })
      : t('consoles.noDevice');
  }

  // ── Consoles ──────────────────────────────────────────────────────────────
  const targetOf = (d) => `${d.target.host}:${d.target.port}`;

  function openDevice(device) {
    const session = consoleSession(device, current?.name ?? '');
    // Tiles are keyed by console line, so a device shown on several pages reuses its tile
    if (workspace.panes.has(session.key)) return workspace.open(session);
    if (!device.allowed) return toast(t('consoles.notAllowed', { name: device.name }), 'warn');
    if (busy.has(targetOf(device))) return toast(t('consoles.busy', { name: device.name }), 'warn');
    // A device on several pages follows any of its benches (SPEC "Permissions"); the server decides again
    const benches = labs.filter((l) => l.devices.some((d) => targetOf(d) === targetOf(device))).map((l) => l.name);
    if (!benchBar.mayOpen(device, benches)) return toast(benchBar.refusal(benches), 'warn', 6000);
    workspace.open(session);
    diagram.pulse(device.key);
  }

  function refreshStates() {
    const mine = workspace.liveTargets();
    diagram.setStates((d) => {
      if (!d.allowed) return 'disabled';
      if (mine.has(targetOf(d))) return 'open';
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
  onLocaleChange(() => {
    renderNotes();
    if (loadError) writeLoadError();
    else if (current) writeHint();
    else if (labs.length === 0 && labTitle.textContent) labTitle.textContent = t('consoles.noLabs');
    refreshStates();
  });

  // Ctrl+K or "/" opens the device finder - but never steals keys from a terminal
  // (Ctrl+K is "erase to end of line" on Cisco IOS)
  document.addEventListener('keydown', (e) => {
    if (el.hidden || e.target.closest?.('.xterm, input, textarea')) return;
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || e.key === '/') {
      e.preventDefault();
      quick.open();
    }
  });

  return {
    show([labName] = []) {
      if (labName) {
        const lab = labs.find((l) => l.name === labName);
        if (lab) selectLab(lab);
        else pendingLabName = labName;
      }
      split.activate();
    },
  };
}
