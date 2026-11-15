/**
 * "Machines et switchs" (#/infra/<tab>): Proxmox VMs and the admin switches,
 * next to the same shared terminal workspace as the lab consoles
 *
 * Underline tabs: Machines virtuelles (a list, with the consoles, the power and
 * the VLAN of each VM as row actions) and Switchs d'admin (one card per
 * switch). For an administrator the page belongs to the administration (its
 * list at the left, ← to the hub on a phone); for a student it is reached from
 * Plus. Routes: #/infra/vms · #/infra/switches
 */
import { h, loadCss } from '../../core/dom.js';
import { getJson } from '../../core/api.js';
import { t, loadNamespace } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { mountTabs } from '../../shared/tabs.js';
import { pageHeader } from '../../shared/pageHeader.js';
import { SplitView } from '../../shared/splitView.js';
import { adminNav, tabsBesideNav } from '../admin/nav.js';
import { VmPanel } from './vmPanel.js';
import { SwitchPanel } from './switchPanel.js';

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('infra', 'admin'), loadCss('infra'), loadCss('admin')]);
  const admin = session.isAdmin;
  if (admin) el.classList.add('admin-sub');

  const header = pageHeader({ title: 'infra.title', context: 'infra.subtitle', back: admin ? '#/admin' : undefined, tabs: true });
  const primary = h('div.view-body.infra-primary');
  const layout = admin ? h('div.admin-layout', adminNav({ current: 'infra' }).el) : el;
  el.append(header.el);
  if (admin) el.append(layout);
  const split = new SplitView(layout, primary, { labelKey: 'infra.title' });
  if (admin) tabsBesideNav(header, primary, el);
  const panels = { vms: null, switches: new SwitchPanel() };

  // The VM panel needs to know whether Proxmox is configured (and how it is reached)
  const vmsReady = getJson('/api/proxmox/status')
    .catch(() => ({ proxmox: false }))
    .then((status) => {
      panels.vms = new VmPanel({ ...status, admin: status.admin ?? session.isAdmin }); // an unconfigured Proxmox answers { proxmox: false } to everyone
      panels.vms.onActionsChange = () => applyActions('vms');
      return panels.vms;
    });

  let shownTab = null;
  const applyActions = (id) => { if (id === shownTab) header.update({ actions: panels[id]?.actions() ?? [] }); };
  const tab = (id, titleKey) => ({
    id,
    title: () => t(titleKey),
    load: async () => ({
      mount: async (host) => {
        const panel = panels[id] ?? await vmsReady;
        host.append(panel.el);
        return { show() { shownTab = id; header.update({ actions: panel.actions() }); panel.show(); } };
      },
    }),
  });
  const tabs = mountTabs(primary, [tab('vms', 'infra.tabs.vms'), tab('switches', 'infra.tabs.switches')], { navigate, base: '#/infra', label: t('infra.title'), bar: header.tabBar });

  return {
    show(params = []) {
      tabs.show(params);
      split.activate();
    },
    hide() { tabs.hide(); },
  };
}
