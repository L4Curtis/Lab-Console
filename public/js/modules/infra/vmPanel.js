/**
 * Virtual machines tab - a plain list of every Proxmox VM with:
 *   power (Start / Stop / Force stop), consoles (Serial / VNC),
 *   the VLAN tag of net0 (edit in place), "Clone template",
 *   and bulk power: tick VMs (or all), then Start selected / Stop selected
 */
import { h, icon, toast } from '../../core/dom.js';
import { t, has, tAttr, tNode, onLocaleChange } from '../../core/i18n.js';
import { getJson, request, live } from '../../core/api.js';
import { workspace } from '../../shared/workspace.js';
import { vmSerialSession, vmScreenSession } from '../../shared/sessions.js';
import { openCloneDialog } from './dialogs.js';

const BULK_PARALLEL = 4; // power requests in flight at once during a bulk action
const keyOf = (vm) => `${vm.node}/${vm.vmid}`;

export class VmPanel {
  vms = [];
  selected = new Set(); // keyOf(vm); survives the periodic refresh
  #timer = null;
  #reloadSoon = null;
  #jobs = [];

  constructor({ proxmox, host, via }) {
    this.proxmox = proxmox;
    this.filter = h('input.field.filter', { type: 'search', ...tAttr('placeholder', 'infra.vm.filter'), ...tAttr('aria-label', 'infra.vm.filterLabel'), oninput: () => this.#renderRows() });
    this.jobsEl = h('ul.jobs', { 'aria-live': 'polite' });
    this.tbody = h('tbody');
    this.foot = h('p.table-foot');
    this.selectAll = h('input', { type: 'checkbox', ...tAttr('aria-label', 'infra.vm.selectAll'), onchange: () => this.#toggleAll() });
    this.selCount = h('span.bulk-count');
    this.bulkStart = h('button.btn.small', { type: 'button', onclick: () => this.#bulk('start') }, icon('play'), tNode('infra.vm.startSelected'));
    this.bulkStop = h('button.btn.small', { type: 'button', onclick: () => this.#bulk('stop') }, icon('power'), tNode('infra.vm.stopSelected'));
    this.bulkClear = h('button.btn.small.subtle', { type: 'button', onclick: () => { this.selected.clear(); this.#renderRows(); } }, tNode('infra.vm.clear'));
    this.bulkBar = h('div.bulk-bar', this.selCount, this.bulkStart, this.bulkStop, this.bulkClear);
    this.el = h('div.panel',
      h('div.panel-toolbar',
        this.filter,
        host ? h('span.badge', tAttr('title', 'infra.vm.reachedVia'), t('infra.vm.hostVia', { host, via })) : null,
        h('button.icon-btn', { type: 'button', ...tAttr('title', 'infra.vm.reload'), onclick: () => this.load(true) }, icon('refresh')),
        h('button.btn.primary', { type: 'button', onclick: () => this.#clone() }, icon('plus'), tNode('infra.vm.clone'))),
      this.bulkBar,
      this.jobsEl,
      h('div.table-wrap', h('table.vm-table',
        h('thead', h('tr', h('th.select', this.selectAll), h('th', tNode('infra.vm.colVm')), h('th', tNode('infra.vm.colVlan')), h('th', tNode('infra.vm.colConsole')), h('th.right', tNode('infra.vm.colPower')))),
        this.tbody)),
      this.foot);

    if (!proxmox) {
      this.el.replaceChildren(h('div.placeholder', icon('rack', 'placeholder-icon'),
        h('h2', tNode('infra.vm.notConfigured')),
        h('p', tNode('infra.vm.notConfiguredHint'))));
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

  show() {
    if (!this.proxmox) return;
    this.load();
    // Power state also changes outside the platform (guest shutdown): refresh while visible
    clearInterval(this.#timer);
    this.#timer = setInterval(() => { if (this.el.isConnected && !document.hidden) this.load(); else clearInterval(this.#timer); }, 15_000);
  }

  async load(manual = false) {
    if (!this.vms.length) this.tbody.replaceChildren(h('tr', h('td.empty-row', { colspan: 5 }, t('infra.vm.loading'))));
    try {
      ({ vms: this.vms } = await getJson('/api/proxmox/vms'));
      this.#renderRows();
      if (manual) toast(t('infra.vm.reloaded'));
    } catch (err) {
      this.tbody.replaceChildren(h('tr', h('td.empty-row', { colspan: 5 },
        h('p.form-error', t('infra.vm.unreachable', { error: err.message })),
        h('button.btn.small', { type: 'button', onclick: () => this.load(true) }, tNode('common.actions.retry')))));
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
    if (this.tbody.contains(document.activeElement) && document.activeElement.matches('.vlan-input')) return;
    this.tbody.replaceChildren(...shown.map((vm) => this.#row(vm)));
    if (!shown.length) this.tbody.append(h('tr', h('td.empty-row', { colspan: 5 }, t(q ? 'infra.vm.noMatch' : 'infra.vm.none'))));
    const templates = this.vms.filter((v) => v.template).length;
    this.foot.textContent = t('infra.vm.foot', { vms: t('infra.vm.count', { count: machines.length }), templates: t('infra.vm.templateCount', { count: templates }) });
  }

  #row(vm) {
    const running = vm.status === 'running';
    const btn = (labelKey, iconName, attrs) => h('button.btn.small', { type: 'button', 'aria-label': t('infra.vm.rowLabel', { action: t(labelKey), name: vm.name }), ...attrs }, icon(iconName), h('span.lbl', t(labelKey)));

    const consoles = [
      btn('infra.vm.serial', 'terminal', {
        disabled: !running || !vm.hasSerial,
        title: t(!vm.hasSerial ? 'infra.vm.noSerial' : running ? 'infra.vm.serialTitle' : 'infra.vm.startFirst'),
        onclick: () => workspace.open(vmSerialSession(vm)),
      }),
      btn('infra.vm.vnc', 'screen', {
        disabled: !running,
        title: t(running ? 'infra.vm.vncTitle' : 'infra.vm.startFirst'),
        onclick: () => workspace.open(vmScreenSession(vm)),
      }),
    ];
    const power = running
      ? [btn('infra.vm.stop', 'power', { title: t('infra.vm.stopTitle'), onclick: () => this.#power(vm, 'stop') }),
        btn('infra.vm.forceStop', 'close', { class: 'btn small danger', title: t('infra.vm.forceStopTitle'), onclick: () => this.#power(vm, 'force-stop') })]
      : [btn('infra.vm.start', 'play', { title: t('infra.vm.startTitle'), onclick: () => this.#power(vm, 'start') })];

    const tick = h('input', {
      type: 'checkbox', checked: this.selected.has(keyOf(vm)), 'aria-label': t('infra.vm.select', { name: vm.name }),
      onchange: (e) => { if (e.target.checked) this.selected.add(keyOf(vm)); else this.selected.delete(keyOf(vm)); this.#updateBulk(); e.target.closest('tr').classList.toggle('picked', e.target.checked); },
    });
    return h(`tr${this.selected.has(keyOf(vm)) ? '.picked' : ''}`, { dataset: { status: vm.status } },
      h('td.select', tick),
      h('td', h('div.vm-cell',
        h('span.vm-led', { title: has(`infra.vm.status.${vm.status}`) ? t(`infra.vm.status.${vm.status}`) : vm.status }),
        h('div', h('strong', vm.name), h('span.vm-meta', t('infra.vm.location', { vmid: vm.vmid, node: vm.node }))))),
      h('td', vm.bridge ? this.#vlanEditor(vm) : h('span.muted', t('infra.vm.noNet0'))),
      h('td', h('div.row-actions', consoles)),
      h('td.right', h('div.row-actions.end', power)));
  }

  /** net0 VLAN tag, edited in place: type a number (empty = untagged), Enter or Set */
  #vlanEditor(vm) {
    const input = h('input.field.vlan-input', {
      type: 'number', min: 1, max: 4094, placeholder: t('infra.vm.vlanNone'), value: vm.vlan ?? '',
      'aria-label': t('infra.vm.vlanLabel', { name: vm.name }), title: t('infra.vm.vlanTitle', { bridge: vm.bridge }),
    });
    const set = h('button.btn.small.primary', { type: 'button', hidden: true }, t('infra.vm.vlanSet'));
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
    this.bulkClear.hidden = !picked.length;
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
    if (action === 'stop' && !confirm(`${t('infra.vm.confirmStop', { count: targets.length })}\n\n${targets.map((v) => v.name).join(', ')}`)) return;
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
    if (action === 'force-stop' && !confirm(t('infra.vm.confirmForceStop', { name: vm.name }))) return;
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
