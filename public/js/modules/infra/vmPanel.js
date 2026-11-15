/**
 * Virtual machines tab - every Proxmox VM as a list (a table from 720 px, one
 * card per VM below), with:
 *   consoles (Serial / VNC) and power (Start / Stop / Force stop) as row
 *   actions, the VLAN tag of net0 (edit in place), "Clone template", and bulk
 *   power: "Select" in the header's ⋯ shows the ticks, then Start selected /
 *   Stop selected
 * The page header's actions come from here: `actions()`
 */
import { h, icon, toast } from '../../core/dom.js';
import { t, has, tAttr, onLocaleChange } from '../../core/i18n.js';
import { getJson, request, live } from '../../core/api.js';
import { workspace } from '../../shared/workspace.js';
import { vmSerialSession, vmScreenSession } from '../../shared/sessions.js';
import { dataList } from '../../shared/dataList.js';
import { confirmDialog } from '../../shared/dialog.js';
import { emptyState, loading } from '../../shared/loadState.js';
import { openCloneDialog } from './dialogs.js';

const BULK_PARALLEL = 4; // power requests in flight at once during a bulk action
const keyOf = (vm) => `${vm.node}/${vm.vmid}`;

export class VmPanel {
  vms = [];
  selected = new Set(); // keyOf(vm); survives the periodic refresh
  #timer = null;
  #reloadSoon = null;
  #jobs = [];

  /** status: GET /api/proxmox/status ({ proxmox, admin, host?, via? }): only administrators get the list */
  constructor({ proxmox, admin = false, host, via }) {
    this.proxmox = proxmox && admin;
    this.host = host;
    this.via = via;
    this.selecting = false;
    this.filter = h('input.field.filter', { type: 'search', ...tAttr('placeholder', 'infra.vm.filter'), ...tAttr('aria-label', 'infra.vm.filterLabel'), oninput: () => this.#renderRows() });
    this.jobsEl = h('ul.jobs', { 'aria-live': 'polite' });
    this.notice = h('div.vm-notice');
    this.foot = h('p.table-foot');
    this.selectAll = h('input', { type: 'checkbox', ...tAttr('aria-label', 'infra.vm.selectAll'), onchange: () => this.#toggleAll() });
    this.selCount = h('span.bulk-count');
    this.bulkStart = h('button.btn.sm', { type: 'button', onclick: () => this.#bulk('start') }, icon('play'), t('infra.vm.startSelected'));
    this.bulkStop = h('button.btn.sm', { type: 'button', onclick: () => this.#bulk('stop') }, icon('power'), t('infra.vm.stopSelected'));
    this.bulkDone = h('button.btn.sm.ghost', { type: 'button', onclick: () => this.setSelecting(false) }, t('infra.vm.selectDone'));
    this.bulkBar = h('div.bulk-bar', { hidden: true }, this.selCount, this.bulkStart, this.bulkStop, this.bulkDone);
    this.list = dataList({
      label: () => t('infra.vm.listLabel'),
      dense: true,
      rowKey: keyOf,
      columns: [
        { id: 'select', label: () => this.selectAll, cell: (vm) => this.#tick(vm) },
        { id: 'vm', label: () => t('infra.vm.colVm'), cell: (vm) => this.#nameCell(vm), primary: true },
        { id: 'status', label: () => t('infra.vm.colStatus'), cell: (vm) => this.#statusBadge(vm), badge: true },
        { id: 'vlan', label: () => t('infra.vm.colVlan'), cell: (vm) => (vm.bridge ? this.#vlanEditor(vm) : h('span.muted', t('infra.vm.noNet0'))), meta: true },
      ],
      actions: (vm) => this.#rowActions(vm),
    });
    this.list.el.classList.add('vm-list');
    this.empty = h('div.vm-empty', { hidden: true });
    this.el = h('div.admin-page.vm-panel',
      h('div.admin-toolbar', this.filter, host ? h('span.badge', { dataset: { tone: 'neutral' }, ...tAttr('title', 'infra.vm.reachedVia') }, t('infra.vm.hostVia', { host, via })) : null),
      this.bulkBar, this.jobsEl, this.notice, this.list.el, this.empty, this.foot);

    if (!this.proxmox) {
      // The names of the settings are an administrator's business: a student is only told it is not there
      const [title, hint] = proxmox ? ['infra.vm.adminOnly', 'infra.vm.adminOnlyHint']
        : admin ? ['infra.vm.notConfigured', 'infra.vm.notConfiguredHint']
          : ['infra.vm.unavailable', null];
      this.el.replaceChildren(emptyState({ icon: 'rack', title, text: hint }));
      return;
    }
    live.on('proxmox:jobs', (jobs) => { this.#jobs = jobs; this.#renderJobs(jobs); });
    live.on('proxmox:changed', () => {
      clearTimeout(this.#reloadSoon);
      this.#reloadSoon = setTimeout(() => this.load(), 300);
    });
    // Rows, counts and the bulk bar are made of sentences: write them again
    onLocaleChange(() => { this.#renderRows(); this.#renderJobs(this.#jobs); });
  }

  /** What the page header offers while this tab is on screen */
  actions() {
    if (!this.proxmox) return [];
    return [
      { id: 'clone', label: 'infra.vm.clone', icon: 'plus', run: () => this.#clone() },
      { id: 'select', label: this.selecting ? 'infra.vm.selectDone' : 'infra.vm.select', icon: 'check', run: () => this.setSelecting(!this.selecting) },
      { id: 'reload', label: 'infra.vm.reload', icon: 'refresh', run: () => this.load(true) },
    ];
  }

  /** The header shows the actions of the tab: it asks again after a change (the selection) */
  onActionsChange = null;

  setSelecting(on) {
    this.selecting = on;
    if (!on) this.selected.clear();
    this.list.el.classList.toggle('selecting', on);
    this.#renderRows();
    this.onActionsChange?.();
  }

  show() {
    if (!this.proxmox) return;
    this.load();
    // Power state also changes outside the platform (guest shutdown): refresh while visible
    clearInterval(this.#timer);
    this.#timer = setInterval(() => { if (this.el.isConnected && !document.hidden) this.load(); else clearInterval(this.#timer); }, 15_000);
  }

  async load(manual = false) {
    if (!this.vms.length) this.notice.replaceChildren(loading());
    try {
      ({ vms: this.vms } = await getJson('/api/proxmox/vms'));
      this.notice.replaceChildren();
      this.#renderRows();
      if (manual) toast(t('infra.vm.reloaded'));
    } catch (err) {
      this.notice.replaceChildren(h('div.load-failure', { role: 'alert' },
        // A coded answer is a whole sentence already (infra.unreachable: the detail stays in the server's log)
        h('p', err.code ? err.message : t('infra.vm.unreachable', { error: err.message })),
        h('button.btn.sm', { type: 'button', dataset: { action: 'retry' }, onclick: () => this.load(true) }, t('common.actions.retry'))));
    }
  }

  #renderRows() {
    const q = this.filter.value.trim().toLowerCase();
    const machines = this.vms.filter((v) => !v.template);
    const shown = machines.filter((v) => !q || `${v.name} ${v.vmid} ${v.vlan ?? ''}`.toLowerCase().includes(q));
    // Forget selected VMs that no longer exist (deleted in Proxmox).
    const existing = new Set(machines.map(keyOf));
    for (const k of this.selected) if (!existing.has(k)) this.selected.delete(k);
    this.shown = shown;
    this.#updateBulk();
    // Don't wipe a VLAN field someone is typing in during the 15 s refresh
    if (this.list.el.contains(document.activeElement) && document.activeElement.matches('.vlan-input')) return;
    this.list.render(shown);
    for (const tr of this.list.el.querySelectorAll('tbody tr')) {
      const vm = shown.find((v) => keyOf(v) === tr.dataset.key);
      if (vm) { tr.dataset.status = vm.status; tr.classList.toggle('picked', this.selected.has(keyOf(vm))); }
    }
    const none = shown.length === 0 && this.vms.length === 0 && !this.notice.firstChild;
    this.list.el.hidden = machines.length === 0;
    this.empty.hidden = !(machines.length === 0 || shown.length === 0) || Boolean(this.notice.firstChild);
    if (!this.empty.hidden) {
      this.empty.replaceChildren(emptyState(machines.length === 0 && !none ? { icon: 'vm', title: 'infra.vm.noneTitle', text: 'infra.vm.none' } : { icon: 'search', title: 'infra.vm.noMatch' }));
    }
    const templates = this.vms.filter((v) => v.template).length;
    this.foot.textContent = machines.length ? t('infra.vm.foot', { vms: t('infra.vm.count', { count: machines.length }), templates: t('infra.vm.templateCount', { count: templates }) }) : '';
  }

  #nameCell(vm) {
    return h('div.vm-cell',
      h('span.vm-led', { title: has(`infra.vm.status.${vm.status}`) ? t(`infra.vm.status.${vm.status}`) : vm.status }),
      h('div', h('strong', vm.name), h('span.vm-meta', t('infra.vm.location', { vmid: vm.vmid, node: vm.node }))));
  }

  #statusBadge(vm) {
    const tone = vm.status === 'running' ? 'success' : vm.status === 'paused' ? 'warning' : 'neutral';
    return h('span.badge', { dataset: { tone } }, h('span.dot'), has(`infra.vm.status.${vm.status}`) ? t(`infra.vm.status.${vm.status}`) : vm.status);
  }

  #tick(vm) {
    return h('input', {
      type: 'checkbox', checked: this.selected.has(keyOf(vm)), 'aria-label': t('infra.vm.select', { name: vm.name }),
      onchange: (e) => { if (e.target.checked) this.selected.add(keyOf(vm)); else this.selected.delete(keyOf(vm)); this.#updateBulk(); e.target.closest('tr').classList.toggle('picked', e.target.checked); },
    });
  }

  /** The consoles first (the table shows the first two), then the power */
  #rowActions(vm) {
    const running = vm.status === 'running';
    const label = (key) => () => t('infra.vm.rowLabel', { action: t(key), name: vm.name });
    return [
      { id: 'serial', label: () => t('infra.vm.serial'), icon: 'terminal', primary: true, disabled: !running || !vm.hasSerial, hint: !vm.hasSerial ? 'infra.vm.noSerial' : !running ? 'infra.vm.startFirst' : null, run: () => workspace.open(vmSerialSession(vm)) },
      { id: 'vnc', label: () => t('infra.vm.vnc'), icon: 'screen', disabled: !running, hint: running ? null : 'infra.vm.startFirst', run: () => workspace.open(vmScreenSession(vm)) },
      ...(running
        ? [{ id: 'stop', label: label('infra.vm.stop'), icon: 'power', run: () => this.#power(vm, 'stop') },
          { id: 'force-stop', label: label('infra.vm.forceStop'), icon: 'close', danger: true, run: () => this.#power(vm, 'force-stop') }]
        : [{ id: 'start', label: label('infra.vm.start'), icon: 'play', run: () => this.#power(vm, 'start') }]),
    ];
  }

  /** net0 VLAN tag, edited in place: type a number (empty = untagged), Enter or Set */
  #vlanEditor(vm) {
    const input = h('input.field.vlan-input', {
      type: 'number', min: 1, max: 4094, placeholder: t('infra.vm.vlanNone'), value: vm.vlan ?? '',
      'aria-label': t('infra.vm.vlanLabel', { name: vm.name }), title: t('infra.vm.vlanTitle', { bridge: vm.bridge }),
    });
    const set = h('button.btn.sm.primary', { type: 'button', hidden: true }, t('infra.vm.vlanSet'));
    const dirty = () => input.value !== String(vm.vlan ?? '');
    input.addEventListener('input', () => { set.hidden = !dirty(); });
    const save = async () => {
      if (!dirty()) return;
      const vlan = input.value === '' ? null : Number(input.value);
      set.disabled = true;
      try {
        await request('PUT', `/api/proxmox/vms/${vm.node}/${vm.vmid}/vlan`, { vlan });
        vm.vlan = vlan;
        set.hidden = true;
        toast(t(vlan === null ? 'infra.vm.vlanNowUntagged' : 'infra.vm.vlanNowTagged', { name: vm.name, vlan }));
        input.blur();
      } catch (err) {
        toast(err.message, 'error');
      } finally { set.disabled = false; }
    };
    set.addEventListener('click', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') { input.value = vm.vlan ?? ''; set.hidden = true; input.blur(); }
    });
    return h('div.vlan-edit', input, set);
  }

  // ── bulk power ────────────────────────────────────────────────────────────

  #toggleAll() {
    const on = this.selectAll.checked;
    for (const vm of this.shown || []) { if (on) this.selected.add(keyOf(vm)); else this.selected.delete(keyOf(vm)); }
    this.#renderRows();
  }

  #updateBulk() {
    const picked = this.#pickedVms();
    const shownPicked = (this.shown || []).filter((vm) => this.selected.has(keyOf(vm))).length;
    this.selectAll.checked = shownPicked > 0 && shownPicked === (this.shown || []).length;
    this.selectAll.indeterminate = shownPicked > 0 && !this.selectAll.checked;
    const toStart = picked.filter((v) => v.status !== 'running').length;
    const toStop = picked.filter((v) => v.status === 'running').length;
    this.selCount.textContent = picked.length
      ? t('infra.vm.selected', { count: picked.length, running: toStop, stopped: toStart })
      : t('infra.vm.tickHint');
    this.bulkStart.disabled = this.busy || !toStart;
    this.bulkStop.disabled = this.busy || !toStop;
    this.bulkBar.hidden = !this.selecting;
    this.bulkBar.classList.toggle('active', picked.length > 0);
  }

  #pickedVms() {
    return this.vms.filter((v) => !v.template && this.selected.has(keyOf(v)));
  }

  /**
   * Start or stop every selected VM that needs it (already-running VMs are
   * skipped by Start, stopped ones by Stop), BULK_PARALLEL requests at a time,
   * through the same power endpoint as the per-row buttons
   */
  async #bulk(action) {
    const targets = this.#pickedVms().filter((v) => (action === 'start' ? v.status !== 'running' : v.status === 'running'));
    if (!targets.length) return;
    if (action === 'stop' && !await confirmDialog({ title: t('infra.vm.confirmStop', { count: targets.length }), body: targets.map((v) => v.name).join(', '), confirmLabel: t('infra.vm.stop'), danger: true })) return;
    this.busy = true;
    this.#updateBulk();
    const failed = [];
    const queue = [...targets];
    await Promise.all(Array.from({ length: Math.min(BULK_PARALLEL, queue.length) }, async () => {
      for (let vm = queue.shift(); vm; vm = queue.shift()) {
        try {
          await request('POST', `/api/proxmox/vms/${vm.node}/${vm.vmid}/power`, { action });
        } catch (err) {
          failed.push(`${vm.name} (${err.message})`);
        }
      }
    }));
    this.busy = false;
    this.#updateBulk();
    const ok = targets.length - failed.length;
    if (ok) toast(t(action === 'start' ? 'infra.vm.bulkStarting' : 'infra.vm.bulkStopping', { count: ok }));
    if (failed.length) toast(t(action === 'start' ? 'infra.vm.bulkFailedStart' : 'infra.vm.bulkFailedStop', { names: failed.join(', ') }), 'error', 9000);
  }

  async #power(vm, action) {
    if (action === 'force-stop' && !await confirmDialog({ title: t('infra.vm.forceStop'), body: t('infra.vm.confirmForceStop', { name: vm.name }), confirmLabel: t('infra.vm.forceStop'), danger: true })) return;
    try {
      await request('POST', `/api/proxmox/vms/${vm.node}/${vm.vmid}/power`, { action });
      toast(t({ start: 'infra.vm.powerStarting', stop: 'infra.vm.powerStopping', 'force-stop': 'infra.vm.powerForceStopping' }[action], { name: vm.name }));
    } catch (err) { toast(err.message, 'error'); }
  }

  async #clone() {
    const templates = this.vms.filter((v) => v.template);
    if (!templates.length) return toast(t('infra.vm.noTemplate'), 'warn');
    const { nodes } = await getJson('/api/proxmox/nodes').catch(() => ({ nodes: [] }));
    openCloneDialog({ templates, nodes });
  }

  #renderJobs(jobs) {
    this.jobsEl.replaceChildren(...jobs.map((j) => h(`li.job.${j.state}`,
      j.state === 'running' ? h('span.spinner', { 'aria-hidden': 'true' }) : icon(j.state === 'done' ? 'check' : 'warning'),
      h('strong', j.label), h('span', j.message))));
  }
}
