/**
 * The checks of a bench (SPEC "Lot checks"), opened from the consoles
 * section: run one (line status, cabling, ping matrix, interfaces), follow
 * it device by device, stop it, and read the last result of each kind.
 *
 *   openChecksDialog(lab)    lab: the diagram's page on screen
 *
 * The server decides who may run, read and stop: the buttons only follow
 * what GET /api/checks/benches/:bench says. Everything the devices printed
 * (hostnames, neighbours, addresses) is shown as text
 */
import { h, icon, toast, loadCss } from '../../core/dom.js';
import { getJson, request } from '../../core/api.js';
import { t, tNode, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { openDialog } from '../../shared/dialog.js';
import { onBenches } from '../teams/data.js';
import { startChecks, onChecks, lastOf, runningOn, remember, checksApi } from './data.js';
import {
  codeText, kindText, stateText, lineText, screenText, stepText, shortPort, ifStateText, reasonText, ageText,
} from './text.js';

const KINDS = ['lines', 'cabling', 'ping', 'interfaces'];
const ICONS = { lines: 'pulse', cabling: 'link', ping: 'network', interfaces: 'topology' };

export async function openChecksDialog(lab) {
  await Promise.all([loadNamespace('checks', 'ios'), loadCss('checks')]);
  startChecks();
  const bench = lab.name;
  let info = null; // GET /benches/:bench

  const notice = h('p.checks-notice', { hidden: true });
  const buttons = KINDS.map((kind) => h('button.btn.small', { type: 'button', dataset: { action: kind }, onclick: () => run(kind) }, icon(ICONS[kind]), h('span.checks-label', kindText(kind))));
  const current = h('section.checks-current', { hidden: true, 'aria-live': 'polite' });
  const results = h('div.checks-results');
  const body = h('div.checks-dialog',
    h('p.checks-intro', tNode('checks.intro')),
    notice,
    h('div.checks-actions', buttons),
    current,
    results);
  const dlg = openDialog(body, { title: t('checks.title', { bench }), wide: true });
  dlg.el.classList.add('checks-modal');

  async function load() {
    try {
      info = await getJson(checksApi(bench));
      for (const c of Object.values(info.results ?? {})) remember(c);
      if (info.running?.result !== undefined) remember(info.running);
    } catch (err) {
      info = null;
      notice.hidden = false;
      notice.textContent = codeText(err.code, err.params, err.message);
    }
    render();
  }

  async function run(kind) {
    try {
      const r = await request('POST', checksApi(bench, `/${kind}`), {});
      remember(r.check);
    } catch (err) {
      toast(codeText(err.code, err.params, err.message), 'warn', 7000);
    }
  }

  async function cancel() {
    try {
      await request('POST', checksApi(bench, '/cancel'), {});
    } catch (err) {
      toast(codeText(err.code, err.params, err.message), 'warn', 7000);
    }
  }

  function render() {
    if (!dlg.el.isConnected) return;
    const running = runningOn(bench);
    const canRun = Boolean(info?.canRun);
    if (info) {
      notice.hidden = canRun;
      notice.textContent = canRun ? '' : t('checks.notice.notOccupant');
    }
    for (const b of buttons) {
      b.disabled = !canRun || Boolean(running) || (b.dataset.action === 'ping' && info?.routers === 0);
      b.querySelector('.checks-label').textContent = kindText(b.dataset.action);
    }
    renderCurrent(running);
    results.replaceChildren(...KINDS.map((kind) => renderResult(kind, lastOf(bench, kind))).filter(Boolean));
    if (!results.children.length) results.append(h('p.muted', t('checks.none')));
  }

  function renderCurrent(c) {
    current.hidden = !c;
    if (!c) { current.replaceChildren(); return; }
    current.dataset.state = c.state ?? 'running';
    current.replaceChildren(
      h('div.checks-current-head',
        h('strong', kindText(c.kind)),
        h('span', t('checks.startedBy', { name: c.actor?.name ?? '' })),
        h('button.btn.small.danger', { type: 'button', dataset: { action: 'cancel' }, onclick: cancel }, icon('stop'), h('span', t('checks.cancel')))),
      h('table.checks-table',
        h('tbody', (c.devices ?? []).map((d) => h('tr', { dataset: { device: d.name ?? '', state: d.state } },
          h('th', d.name ?? ''),
          h('td', h('span.checks-state', { dataset: { state: d.state } }, stateText(d.state))),
          h('td.muted', d.step ? stepText(d.step, d.params) : '')))))
    );
  }

  /** The head of a result: kind, when, who, how it ended */
  function resultHead(c) {
    return h('header.checks-result-head',
      h('h3', kindText(c.kind)),
      h('span.checks-state', { dataset: { state: c.state } }, stateText(c.state)),
      h('span.muted', t('checks.ranBy', { name: c.actor?.name ?? '', when: ageText(c.endedAt) })));
  }

  /** Devices that did not finish, and why */
  function problems(c, list) {
    const bad = (list ?? []).filter((d) => d.state && d.state !== 'done' && d.code);
    if (!bad.length) return null;
    return h('ul.checks-problems', bad.map((d) => h('li', { dataset: { device: d.name } }, h('strong', d.name), ' — ', codeText(d.code, d.params, d.code))));
  }

  function renderResult(kind, c) {
    if (!c) return null;
    const r = c.result ?? {};
    const section = h('section.checks-result', { dataset: { kind, state: c.state } }, resultHead(c));
    if (kind === 'lines') {
      section.append(h('table.checks-table.checks-lines',
        h('thead', h('tr', h('th', t('checks.columns.device')), h('th', t('checks.columns.line')), h('th', t('checks.columns.screen')))),
        h('tbody', (r.devices ?? []).map((d) => h('tr', { dataset: { device: d.name, line: d.line } },
          h('th', d.name),
          h('td', h('span.checks-line', { dataset: { line: d.line } }, lineText(d.line))),
          h('td.muted', screenText(d.screen)))))));
      section.append(h('p.muted.checks-foot', t('checks.lines.foot')));
    } else if (kind === 'cabling') {
      const s = r.summary ?? {};
      section.append(h('p.checks-summary', t('checks.cabling.summary', { ok: s.ok ?? 0, wrong: s.wrong_port ?? 0, missing: s.missing ?? 0, unverified: s.unverified ?? 0, unexpected: s.unexpected ?? 0 })));
      section.append(h('table.checks-table.checks-cabling',
        h('thead', h('tr', h('th', t('checks.columns.link')), h('th', t('checks.columns.verdict')), h('th', t('checks.columns.seen')))),
        h('tbody',
          (r.links ?? []).map((l) => h('tr', { dataset: { status: l.status, link: `${l.a.name}-${l.b.name}` } },
            h('td', `${l.a.name} ${l.a.port ? shortPort(l.a.port) : ''} — ${l.b.name} ${l.b.port ? shortPort(l.b.port) : ''}`.replace(/\s+/g, ' ')),
            h('td', h('span.checks-verdict', { dataset: { status: l.status } }, t(`checks.cabling.status.${l.status}`)), l.reason ? h('div.muted', reasonText(l.reason)) : null, l.a.assumed ? h('div.muted', t('checks.cabling.assumed')) : null),
            h('td.muted', l.a.seen || l.b.seen ? `${shortPort(l.a.seen ?? '?')} — ${shortPort(l.b.seen ?? '?')}` : ''))),
          (r.unexpected ?? []).map((u) => h('tr', { dataset: { status: 'unexpected', link: `${u.a.name}-${u.b.name}` } },
            h('td', `${u.a.name} ${shortPort(u.a.port)} — ${u.b.name} ${shortPort(u.b.port)}`),
            h('td', h('span.checks-verdict', { dataset: { status: 'unexpected' } }, t('checks.cabling.status.unexpected')), u.b.key ? null : h('div.muted', t('checks.cabling.stranger'))),
            h('td.muted', ''))))));
      const p = problems(c, r.devices);
      if (p) section.append(p);
    } else if (kind === 'ping') {
      section.append(pingMatrix(r));
      const p = problems(c, r.routers);
      if (p) section.append(p);
    } else if (kind === 'interfaces') {
      const list = h('div.checks-ifs');
      for (const d of r.devices ?? []) {
        if (!d.interfaces) continue;
        list.append(h('details', { dataset: { device: d.name } },
          h('summary', h('strong', d.name), ' ', h('span.muted', [d.hostname, d.model].filter(Boolean).join(' · '))),
          h('table.checks-table',
            h('thead', h('tr', h('th', t('checks.columns.interface')), h('th', t('checks.columns.address')), h('th', t('checks.columns.state')))),
            h('tbody', d.interfaces.map((i) => h('tr', { dataset: { state: i.status === 'up' && i.protocol === 'up' ? 'up' : 'down' } },
              h('td', i.name), h('td', i.ip ?? '—'), h('td', ifStateText(i))))))));
      }
      section.append(list);
      const p = problems(c, r.devices);
      if (p) section.append(p);
    }
    return section;
  }

  /** Routers in rows, the addresses of the others in columns: green answered, red did not */
  function pingMatrix(r) {
    const routers = (r.routers ?? []).filter((d) => d.addresses?.length);
    const name = new Map((r.routers ?? []).map((d) => [d.key, d.name]));
    const targets = [];
    for (const c of r.cells ?? []) if (!targets.some((x) => x.to === c.to && x.ip === c.ip)) targets.push({ to: c.to, ip: c.ip, interface: c.interface });
    if (!routers.length || !targets.length) return h('p.muted', t('checks.ping.empty'));
    const cell = (from, x) => (r.cells ?? []).find((c) => c.from === from && c.to === x.to && c.ip === x.ip);
    return h('div.checks-matrix-wrap', r.tooMany ? h('p.muted', t('checks.ping.tooMany')) : null, h('table.checks-table.checks-matrix',
      h('caption.muted', t('checks.ping.caption', { count: r.repeat ?? 0 })),
      h('thead', h('tr', h('th', t('checks.ping.fromTo')), targets.map((x) => h('th', { scope: 'col', title: `${name.get(x.to)} ${x.interface}` }, h('div', name.get(x.to) ?? ''), h('div.muted', x.ip))))),
      h('tbody', routers.map((d) => h('tr', { dataset: { device: d.name } }, h('th', { scope: 'row' }, d.name),
        targets.map((x) => {
          if (x.to === d.key) return h('td.checks-self', '—');
          const c = cell(d.key, x);
          if (!c) return h('td', '');
          const text = c.state === 'error' || c.state === 'skipped' ? '?' : `${c.received}/${c.sent}`;
          const title = c.state === 'error' || (c.state === 'skipped' && c.code) ? codeText(c.code, c.params ?? {}, c.code ?? '') : t(`checks.ping.state.${c.state}`, { rtt: c.rtt?.avg ?? '' });
          return h('td.checks-ping', { dataset: { state: c.state, to: name.get(x.to), ip: x.ip }, title }, text);
        }))))));
  }

  const offChecks = onChecks(render);
  const offBenches = onBenches(() => load());
  const offLocale = onLocaleChange(render);
  dlg.closed.then(() => { offChecks(); offBenches(); offLocale(); });
  await load();
  return dlg;
}

