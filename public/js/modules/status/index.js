/**
 * "Lab status" section (#/status/<tab>), for everyone signed in:
 *   - health: is the jump server up, do the console servers answer, is
 *     Proxmox reachable (states only; administrators also get the addresses,
 *     the errors and a "check now" button);
 *   - journaling: what the platform records about what you do, and for how
 *     long (the banner of the consoles points here).
 */
import { h, icon, loadCss, toast } from '../../core/dom.js';
import { getJson } from '../../core/api.js';
import { t, has, tNode, tError, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { mountTabs } from '../../shared/tabs.js';
import { formatDate, errorText } from '../admin/common.js';

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('admin', 'accounts'), loadCss('accounts'), loadCss('admin')]);
  const bar = h('div.admin-tabs');
  el.append(h('header.view-head', h('div.view-title', h('h1', tNode('admin.status.title')), h('p', tNode('admin.status.subtitle'))), bar));
  const body = h('div.admin-body');
  el.append(body);
  const tabs = mountTabs(body, [
    { id: 'health', title: () => t('admin.status.tabs.health'), load: async () => ({ mount: mountHealth }) },
    { id: 'journaling', title: () => t('admin.status.tabs.journaling'), load: async () => ({ mount: mountJournaling }) },
  ], { navigate, base: '#/status', label: t('admin.status.title'), bar });
  return { show: (params) => tabs.show(params), hide: () => tabs.hide() };
}

function mountHealth(el) {
  const cards = h('div.health-cards');
  const details = h('div.health-details');
  const meta = h('p.muted.small-note');
  const refresh = h('button.btn', { type: 'button', dataset: { action: 'refresh' }, hidden: !session.isAdmin }, icon('refresh'), h('span.lbl'));
  const notice = h('p.form-error', { role: 'alert' });
  el.append(h('div.panel', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), h('div.panel-toolbar', meta, refresh), notice, cards, details));
  let data = null;

  const card = (name, state, extra) => h('div.health-card', { dataset: { part: name, state } },
    h('span.health-led', { 'aria-hidden': 'true' }),
    h('div', h('strong', t(`admin.status.parts.${name}`)), h('span.health-state', extra ?? t(`admin.status.states.${state}`))));

  function render() {
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.status.${node.dataset.text}`);
    refresh.querySelector('.lbl').textContent = t('admin.status.refresh');
    if (!data) return;
    meta.textContent = t('admin.status.checkedAt', { date: formatDate(data.checkedAt) });
    const cs = data.consoleServers;
    const csState = cs.total === 0 ? 'unknown' : cs.ok === cs.total ? 'ok' : cs.ok === 0 ? 'down' : 'partial';
    cards.replaceChildren(
      card('jump', data.jump.state),
      card('consoleServers', csState, t('admin.status.serversUp', { ok: cs.ok, count: cs.total })),
      card('proxmox', data.proxmox.state, data.proxmox.tunnel
        ? `${t(`admin.status.states.${data.proxmox.state}`)} · ${t('admin.status.tunnel', { state: t(`admin.status.states.${data.proxmox.tunnel}`) })}`
        : undefined));
    if (!data.details) { details.replaceChildren(); return; }
    const d = data.details;
    const line = (what, host, state, error) => h('tr', { dataset: { state } }, h('td', what), h('td.mono', host ?? '—'), h('td', t(`admin.status.states.${state}`)), h('td', error ?? ''));
    details.replaceChildren(h('div.table-wrap', h('table.vm-table',
      h('thead', h('tr', ['part', 'address', 'state', 'error'].map((c) => h('th', t(`admin.status.columns.${c}`))))),
      h('tbody',
        line(t('admin.status.parts.jump'), d.jump.host, d.jump.state, d.jump.code ? tError(d.jump.code, d.jump.params, d.jump.error) : d.jump.error),
        d.consoleServers.map((s) => line(t('admin.status.parts.consoleServer'), `${s.host}:${s.port}`, s.state, s.error)),
        line(t('admin.status.parts.proxmox'), d.proxmox.host, d.proxmox.state, d.proxmox.error),
        d.proxmox.tunnel ? line(t('admin.status.parts.proxmoxTunnel'), d.proxmox.tunnel.transport, d.proxmox.tunnel.state,
          t('admin.status.tunnelDetail', { connections: d.proxmox.tunnel.connections, channels: d.proxmox.tunnel.openChannels })) : null))));
  }

  async function load(fresh = false) {
    refresh.disabled = true;
    try {
      data = await getJson(`/api/admin/health${fresh ? '?fresh=1' : ''}`);
      notice.textContent = '';
    } catch (err) {
      notice.textContent = errorText(err);
    } finally {
      refresh.disabled = false;
    }
    render();
  }
  refresh.addEventListener('click', () => load(true).then(() => toast(t('admin.status.checked'))));
  onLocaleChange(render);
  render();
  return { show: () => load() };
}

function mountJournaling(el) {
  const list = h('div.journaling');
  el.append(h('div.panel.sso-panel', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), list));
  let data = null;
  const block = (key, params) => h('section.account-card', h('h2', t(`admin.journaling.${key}.title`)),
    h('p', t(`admin.journaling.${key}.what`, params)), has(`admin.journaling.${key}.kept`) ? h('p.muted', t(`admin.journaling.${key}.kept`, params)) : null);

  function render() {
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.journaling.${node.dataset.text}`);
    if (!data) return;
    list.replaceChildren(
      block('audit'),
      data.consoleJournal.enabled ? block('consoles', { count: data.consoleJournal.retentionDays }) : block('noConsoleJournal'),
      block('sessions', { idle: data.sessions.idleHours, max: data.sessions.maxHours }),
      block('never'));
  }
  async function load() {
    try { data = await getJson('/api/admin/journaling'); } catch (err) { list.replaceChildren(h('p.form-error', errorText(err))); return; }
    render();
  }
  onLocaleChange(render);
  return { show: load };
}
