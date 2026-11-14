/**
 * "Home" section (#/home), the page shown after sign-in: my team, our bench,
 * our latest backups, what happened lately on our bench, our next slots and
 * the announcement, live
 *
 * The data is GET /api/overview/home, which the server builds for this very
 * person: a team's backups come to its members only, a bench's activity to
 * the people working on it. A card with nothing to show says what to do next
 * instead of staying empty. Read only; every action leads to the section
 * that owns it
 */
import { h, icon, loadCss } from '../../core/dom.js';
import { t, tNode, has, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { followApi, roomsSignature } from './live.js';
import { benchCard } from './benchCard.js';
import { replaceKeepingFocus } from './keepFocus.js';
import { fmtDateTime, fmtSlot, historyText } from '../teams/data.js';
import { fmtDate } from '../jobs/text.js';

// Console lines tell their own story; everything else the bench history knows how to say
const CONSOLE_ACTIONS = {
  'console.open': 'overview.activity.consoleOpen',
  'console.join': 'overview.activity.consoleJoin',
  'console.freed': 'overview.activity.consoleFreed',
};

const activityText = (e) => {
  const key = CONSOLE_ACTIONS[e.action];
  return key ? t(key, { who: e.actor.name, device: e.details.device ?? '' }) : historyText(e);
};

export async function mount(el) {
  await Promise.all([loadNamespace('overview', 'benches', 'jobs', 'teams'), loadCss('overview')]);

  let data = null;
  let failed = false;

  const body = h('div.ov-body.ov-home');
  const head = h('header.view-head', h('div.view-title', h('h1', tNode('overview.home.title')), h('p.ov-greeting')));
  el.append(head, body);

  const link = (href, label, id, extra = '') => h(`a.btn.small${extra}`, { href, dataset: { action: id } }, label);
  const panel = (id, title, ...content) => h(`section.ov-panel.ov-panel-${id}`, { dataset: { panel: id } }, h('h2', title), ...content);

  // ── The parts ─────────────────────────────────────────────────────────────

  function announcement(a) {
    return h('section.ov-announcement', { role: 'status', dataset: { level: a.level, panel: 'announcement' } }, icon('warning'),
      h('div', h('p.ov-announcement-text', a.text),
        h('p.muted', [t('overview.home.announcement.by', { name: a.by, time: fmtDateTime(a.at) }),
          a.expiresAt ? t('overview.home.announcement.until', { time: fmtDateTime(a.expiresAt) }) : null].filter(Boolean).join(' · '))));
  }

  function teamPanel(d) {
    if (d.team) {
      return panel('team', t('overview.home.team.title'),
        h('p.ov-team-name', icon('team'), h('strong', d.team.name)),
        h('ul.ov-people', { 'aria-label': t('overview.home.team.members') }, d.team.members.map((m) => h('li', { dataset: { you: String(m.you) } }, m.name, m.you ? h('small', t('overview.home.team.you')) : null))),
        h('div.ov-actions', link('#/team/mine', t('overview.home.team.manage'), 'team')));
    }
    if (session.isAdmin) {
      return panel('team', t('overview.home.team.title'), h('p.muted', t('overview.home.team.admin')),
        h('div.ov-actions', link('#/team/all', t('overview.home.team.allTeams'), 'team')));
    }
    return panel('team', t('overview.home.team.title'),
      h('p', t('overview.home.team.none')), h('p.muted', t('overview.home.team.noneHint')),
      h('div.ov-actions', link('#/team/mine', t('overview.home.team.create'), 'team', '.primary')));
  }

  function invitationsPanel(d) {
    if (!d.invitations.length) return null;
    return panel('invitations', t('overview.home.invitations.title'),
      h('ul.ov-list', d.invitations.map((i) => h('li', h('span', t('overview.home.invitations.item', { by: i.by, team: i.team })), h('time.muted', { datetime: i.at }, fmtDateTime(i.at))))),
      h('div.ov-actions', link('#/team/mine', t('overview.home.invitations.answer'), 'invitations', '.primary')));
  }

  function benchPanel(d) {
    if (d.bench) {
      const b = d.bench;
      const actions = [{ id: 'jobs', href: `#/jobs/${encodeURIComponent(b.bench)}`, label: t('overview.home.bench.jobs') }];
      return h('section.ov-panel.ov-bench-panel', { dataset: { panel: 'bench' } }, h('h2', t('overview.home.bench.title')), benchCard(b, { actions }));
    }
    const lab = d.lab;
    return panel('bench', t('overview.home.bench.title'),
      h('p', d.team ? t('overview.home.bench.noneTeam') : t('overview.home.bench.none')),
      h('p.muted', t('overview.home.bench.free', { count: lab.free, total: lab.benches })),
      h('div.ov-actions', link('#/overview', t('overview.home.bench.choose'), 'overview', '.primary')));
  }

  function backupsPanel(d) {
    if (!d.team) return null; // a backup belongs to a team: without one there is nothing to list or to look for
    const origin = (o) => (has(`jobs.origin.${o}`) ? t(`jobs.origin.${o}`) : o);
    const bench = d.backups[0]?.bench ?? d.bench?.bench;
    return panel('backups', t('overview.home.backups.title'),
      d.backups.length
        ? h('ul.ov-list', d.backups.map((s) => h('li', { dataset: { snapshot: s.id } },
          h('a', { href: `#/jobs/${encodeURIComponent(s.bench)}` }, h('strong', s.label || origin(s.origin))),
          h('span.muted', `${s.bench} · ${t('overview.home.backups.devices', { count: s.devices })} · ${s.author}`),
          h('time.muted', { datetime: s.createdAt }, fmtDate(s.createdAt)))))
        : h('p.muted', t('overview.home.backups.empty')),
      h('div.ov-actions', link(bench ? `#/jobs/${encodeURIComponent(bench)}` : '#/jobs', t('overview.home.backups.all'), 'backups')));
  }

  function activityPanel(d) {
    if (!d.bench?.you.occupant) return null; // the story of a bench is for those who work on it
    return panel('activity', t('overview.home.activity.title'),
      d.activity.length
        ? h('ol.ov-activity', d.activity.map((e) => h('li', h('time', { datetime: e.ts }, fmtDateTime(e.ts)), h('span', activityText(e)))))
        : h('p.muted', t('overview.home.activity.empty')));
  }

  function slotsPanel(d) {
    if (!d.team) return null;
    return panel('slots', t('overview.home.slots.title'),
      d.slots.length
        ? h('ul.ov-list', d.slots.map((s) => h('li', h('strong', s.bench), h('span', fmtSlot(s)))))
        : h('p.muted', t('overview.home.slots.empty')),
      h('div.ov-actions', link(`#/team/calendar${d.bench ? `/${encodeURIComponent(d.bench.bench)}` : ''}`, t('overview.home.slots.book'), 'calendar')));
  }

  function labPanel(d) {
    const l = d.lab;
    return panel('lab', t('overview.home.lab.title'),
      h('ul.ov-totals', [['free', l.free], ['taken', l.taken], ['locked', l.locked], ['consoles', l.consoles], ['jobs', l.jobs]]
        .map(([key, n]) => h('li', { dataset: { total: key, count: String(n) } }, t(`overview.totals.${key}`, { count: n })))),
      h('div.ov-actions', link('#/overview', t('overview.home.lab.overview'), 'overview')));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    head.querySelector('.ov-greeting').textContent = t('overview.home.greeting', { name: session.user?.name ?? '' });
    if (!data) {
      body.replaceChildren(h('p.ov-status.muted', { role: 'status' }, failed ? t('overview.loadError') : t('overview.loading'),
        failed ? h('button.btn.small', { type: 'button', dataset: { action: 'retry' }, onclick: () => feed.refresh() }, t('overview.retry')) : null));
      return;
    }
    const d = data;
    replaceKeepingFocus(body, [
      d.announcement ? announcement(d.announcement) : null,
      h('div.ov-home-grid', invitationsPanel(d), teamPanel(d), benchPanel(d), backupsPanel(d), activityPanel(d), slotsPanel(d), labPanel(d)),
    ].filter(Boolean));
  }

  const feed = followApi('/api/overview/home', {
    // Everything the page shows moves with one of these: the benches and teams, the jobs (a finished backup), the announcement
    topics: ['benches:state', 'benches:reservations', 'consoles:rooms', 'jobs:running', 'jobs:done', 'teams:changed', 'teams:invitation', 'admin:announcement'],
    changed: { 'consoles:rooms': roomsSignature },
    onData: (next) => {
      // Most events move nothing the page shows: draw again only when the answer differs
      const same = data && !failed && JSON.stringify(next) === JSON.stringify(data);
      data = next;
      failed = false;
      if (!same) render();
    },
    onError: () => { failed = true; if (!data) render(); },
  });
  onLocaleChange(render);
  render();

  return { show: () => feed.show(), hide: () => feed.hide() };
}
