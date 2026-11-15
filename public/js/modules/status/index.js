/**
 * "État du labo" (#/status/<tab>), for everyone signed in (docs/v2/UX.md §10.9):
 *   - Santé: a summary line first (everything works, or how many parts have a
 *     problem), then one card per part: is the jump server up, do the console
 *     servers answer, is Proxmox reachable (states only; administrators also get
 *     the addresses, the errors and "Vérifier maintenant");
 *   - Ce qui est journalisé: what the platform records about what you do, and
 *     for how long (the banner of the consoles points here).
 * For an administrator the page belongs to the administration (its list at the
 * left, ← to the hub on a phone); for a student it is reached from Plus
 */
import { h, icon, loadCss, toast } from '../../core/dom.js';
import { getJson } from '../../core/api.js';
import { t, has, tError, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { mountTabs } from '../../shared/tabs.js';
import { pageHeader } from '../../shared/pageHeader.js';
import { dataList } from '../../shared/dataList.js';
import { fmtLong } from '../../core/format.js';
import { loading, loadFailure } from '../../shared/loadState.js';
import { adminNav } from '../admin/nav.js';

export async function mount(el, { navigate }) {
  await Promise.all([loadNamespace('admin', 'accounts'), loadCss('accounts'), loadCss('admin')]);
  const admin = session.isAdmin;
  if (admin) el.classList.add('admin-sub');
  const header = pageHeader({ title: 'admin.status.title', context: 'admin.status.subtitle', back: admin ? '#/admin' : undefined, tabs: true });
  const body = h('div.view-body.admin-content');
  el.append(header.el, admin ? h('div.admin-layout', adminNav({ current: 'status' }).el, body) : body);
  const ctx = { setActions: (actions) => header.update({ actions }), setContext: (text) => header.update({ context: text ? () => text : 'admin.status.subtitle' }) };
  const tabs = mountTabs(body, [
    { id: 'health', title: () => t('admin.status.tabs.health'), load: async () => ({ mount: mountHealth }) },
    { id: 'journaling', title: () => t('admin.status.tabs.journaling'), load: async () => ({ mount: mountJournaling }) },
  ], { navigate, base: '#/status', label: t('admin.status.title'), bar: header.tabBar, ctx });
  return { show: (params) => tabs.show(params), hide: () => tabs.hide() };
}

function mountHealth(el, ctx) {
  const summary = h('div.health-summary', { role: 'status', hidden: true });
  const cards = h('div.health-cards');
  const details = h('section.admin-section.health-details', { hidden: true });
  let metaText = '';
  const notice = h('div');
  el.append(h('div.admin-page', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), notice, summary, cards, details));
  let data = null;
  let busy = false;

  const card = (name, state, extra) => h('div.card.health-card', { dataset: { part: name, state } },
    h('span.health-led', { 'aria-hidden': 'true' }),
    h('div', h('strong', t(`admin.status.parts.${name}`)), h('span.health-state', extra ?? t(`admin.status.states.${state}`))));

  const detailRows = (d) => {
    const line = (what, host, state, error) => ({ what, host: host ?? '—', state, error: error ?? '' });
    return [
      line(t('admin.status.parts.jump'), d.jump.host, d.jump.state, d.jump.code ? tError(d.jump.code, d.jump.params, d.jump.error) : d.jump.error),
      ...d.consoleServers.map((s) => line(t('admin.status.parts.consoleServer'), `${s.host}:${s.port}`, s.state, s.error)),
      line(t('admin.status.parts.proxmox'), d.proxmox.host, d.proxmox.state, d.proxmox.error),
      ...(d.proxmox.tunnel ? [line(t('admin.status.parts.proxmoxTunnel'), d.proxmox.tunnel.transport, d.proxmox.tunnel.state,
        t('admin.status.tunnelDetail', { connections: d.proxmox.tunnel.connections, channels: d.proxmox.tunnel.openChannels }))] : []),
      // The SSH connections the console lines share: one row each
      ...(d.consoles?.pool?.lines ?? []).map((c) => line(t('admin.status.parts.poolConnection'), c.key, c.state === 'ready' ? 'ok' : c.state === 'dead' ? 'down' : 'unknown',
        t('admin.status.poolChannels', { count: c.channels, capacity: c.capacity }))),
    ];
  };
  const detailList = dataList({
    label: () => t('admin.status.detailsTitle'),
    dense: true,
    columns: [
      { id: 'what', label: () => t('admin.status.columns.part'), cell: (r) => r.what, primary: true },
      { id: 'state', label: () => t('admin.status.columns.state'), cell: (r) => h('span.badge', { dataset: { tone: STATE_TONES[r.state] ?? 'neutral' } }, h('span.dot'), t(`admin.status.states.${r.state}`)), badge: true },
      { id: 'host', label: () => t('admin.status.columns.address'), cell: (r) => h('span.mono', r.host), meta: true },
      { id: 'error', label: () => t('admin.status.columns.error'), cell: (r) => r.error, meta: true },
    ],
  });
  details.append(h('h2', { dataset: { text: 'detailsTitle' } }), detailList.el);

  function render() {
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.status.${node.dataset.text}`);
    ctx.setActions(session.isAdmin ? [{ id: 'refresh', label: 'admin.status.refresh', icon: 'refresh', bar: true, disabled: busy, run: () => load(true).then(() => toast(t('admin.status.checked'))) }] : []);
    if (!data) return;
    metaText = t('admin.status.checkedAt', { date: fmtLong(data.checkedAt) });
    ctx.setContext?.(metaText);
    const cs = data.consoleServers;
    const csState = cs.total === 0 ? 'unknown' : cs.ok === cs.total ? 'ok' : cs.ok === 0 ? 'down' : 'partial';
    const parts = [
      card('jump', data.jump.state),
      card('consoleServers', csState, t('admin.status.serversUp', { ok: cs.ok, count: cs.total })),
      card('proxmox', data.proxmox.state, data.proxmox.tunnel
        ? `${t(`admin.status.states.${data.proxmox.state}`)} · ${t('admin.status.tunnel', { state: t(`admin.status.states.${data.proxmox.tunnel}`) })}`
        : undefined),
      data.consoles ? card('lines', 'ok', t('admin.status.linesOpen', { count: data.consoles.open, connections: data.consoles.connections ?? 0 })) : null,
      data.journal ? card('journal', data.journal.maxBytes && data.journal.bytes > data.journal.maxBytes ? 'partial' : 'ok', data.journal.maxBytes
        ? t('admin.status.journalUsed', { used: megabytes(data.journal.bytes), max: megabytes(data.journal.maxBytes) })
        : t('admin.status.journalSize', { used: megabytes(data.journal.bytes) })) : null,
    ].filter(Boolean);
    const problems = parts.filter((p) => ['down', 'partial'].includes(p.dataset.state)).length;
    summary.hidden = false;
    summary.dataset.state = problems ? 'problem' : 'ok';
    summary.replaceChildren(icon(problems ? 'warning' : 'success'), h('span', problems ? t('admin.status.problems', { count: problems }) : t('admin.status.allWell')));
    cards.replaceChildren(...parts);
    details.hidden = !data.details;
    if (data.details) detailList.render(detailRows(data.details));
  }

  async function load(fresh = false) {
    busy = true;
    render();
    if (!data) cards.replaceChildren(loading());
    try {
      data = await getJson(`/api/admin/health${fresh ? '?fresh=1' : ''}`);
      notice.replaceChildren();
    } catch (err) {
      if (!data) cards.replaceChildren();
      notice.replaceChildren(loadFailure('admin.status.loadFailed', err, () => load(fresh)));
    } finally {
      busy = false;
    }
    render();
  }
  onLocaleChange(render);
  return { show: () => { ctx.setContext(metaText); render(); return load(); } };
}

const STATE_TONES = { ok: 'success', down: 'danger', partial: 'warning', unknown: 'neutral', off: 'neutral' };

/** Bytes as megabytes with one decimal, in the page's language */
const megabytes = (bytes) => (bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 });

function mountJournaling(el, ctx) {
  const list = h('div.journaling');
  el.append(h('div.admin-page.sso-panel', h('p.muted.panel-intro', { dataset: { text: 'intro' } }), list));
  let data = null;
  const block = (key, params) => h('section.card', h('div.card-head', h('h2', t(`admin.journaling.${key}.title`))),
    h('p', t(`admin.journaling.${key}.what`, params)), has(`admin.journaling.${key}.kept`) ? h('p.muted', t(`admin.journaling.${key}.kept`, params)) : null);

  function render() {
    for (const node of el.querySelectorAll('[data-text]')) node.textContent = t(`admin.journaling.${node.dataset.text}`);
    if (!data) return;
    list.replaceChildren(
      block('audit'),
      data.consoleJournal.enabled ? block('consoles', { count: data.consoleJournal.retentionDays }) : block('noConsoleJournal'),
      data.consoleJournal.enabled ? h('p.muted', t('admin.journaling.consoles.limits', {
        day: megabytes(data.consoleJournal.maxBytesPerDay), total: data.consoleJournal.maxTotalBytes ? megabytes(data.consoleJournal.maxTotalBytes) : '—',
      })) : null,
      block('sessions', { idle: data.sessions.idleHours, max: data.sessions.maxHours }),
      block('never'));
  }
  async function load() {
    ctx.setActions([]);
    ctx.setContext(null);
    if (!data) list.replaceChildren(loading());
    try { data = await getJson('/api/admin/journaling'); } catch (err) { list.replaceChildren(loadFailure('admin.journaling.loadFailed', err, load)); return; }
    render();
  }
  onLocaleChange(render);
  return { show: load };
}
