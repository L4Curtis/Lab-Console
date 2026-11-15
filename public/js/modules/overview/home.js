/**
 * "Accueil" (#/home), the page shown after sign-in (docs/v2/UX.md §10.1):
 *
 *   1. Attention: only what needs this person now, one action each (a join
 *      request on our bench, a team invitation, the bench about to be released,
 *      a job running, the bench locked; for administrators the accounts waiting
 *      for validation and a problem in the lab's health)
 *   2. Ma baie: the hero card (bench, state, team, who is there, open consoles)
 *      with "Ouvrir les consoles"; without a team, or without a bench, what to do
 *   3. Le labo (index.js): every bench, filtered by chips (#/home/lab[/<filter>])
 *   4. Nos prochains créneaux, nos dernières sauvegardes, l'activité récente
 *
 * The data is GET /api/overview/home (built by the server for this very
 * person: a team's backups come to its members only, a bench's activity to
 * the people working on it) and GET /api/overview/benches. A card with nothing
 * to show says what to do next. Taking a bench is the one thing it does by
 * itself (a team without a bench is offered three free ones); everything else
 * leads to the section that owns it. An administrator's page puts Le labo
 * first, then shortcuts to the administration
 */
import { h, icon, loadCss, toast } from '../../core/dom.js';
import { t, loadNamespace, onLocaleChange } from '../../core/i18n.js';
import { getJson, request, live } from '../../core/api.js';
import { setNavBadge } from '../../core/nav.js';
import { session } from '../../core/session.js';
import { pageHeader } from '../../shared/pageHeader.js';
import { loading, loadFailure } from '../../shared/loadState.js';
import { followApi, roomsSignature, checksSignature } from './live.js';
import { labBlock, isFilter } from './index.js';
import { stateBadge, avatarStack, lineStatus } from './benchCard.js';
import { replaceKeepingFocus } from './keepFocus.js';
import { fmtSlot, historyText } from '../teams/data.js';
import { fmtShort, fmtDateTime, fmtTime } from '../../core/format.js';

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

const RELEASE_WARNING_MS = 30 * 60_000;
const TICK_MS = 30_000;
const ADMIN_REFRESH_MS = 30_000;
const ACTIVITY_SHOWN = 5;
const BACKUPS_SHOWN = 2;
const SLOTS_SHOWN = 3;
const FREE_BENCHES_OFFERED = 3;

const benchPath = (bench, rest = '') => `/api/benches/${encodeURIComponent(bench)}${rest}`;

export async function mount(el, { navigate } = {}) {
  await Promise.all([loadNamespace('overview', 'benches', 'jobs', 'teams'), loadCss('overview')]);

  let data = null;
  let cards = null;
  let failure = null; // the error of a read that left the page empty
  let more = false;          // the activity list shows everything the server sent
  let extra = { requests: [], invitations: [], pendingAccounts: 0, health: null }; // what the home data alone cannot say
  let extraTicket = 0;
  let adminReadAt = 0;
  let wantLab = false;       // #/home/lab: the heading of Le labo gets the focus once the page is drawn
  let timer = null;

  const header = pageHeader({
    title: 'overview.home.title',
    context: () => t('overview.home.greeting', { name: session.user?.name ?? '' }),
  });
  const body = h('div.view-body');
  const content = h('div.ov-home');
  body.append(content);
  el.append(header.el, body);
  const lab = labBlock({ onFilter: (id) => navigate?.(`#/home/lab/${id}`) });

  const link = (href, label, id, cls = '') => h(`a.btn${cls}`, { href, dataset: { action: id } }, label);
  const act = (label, id, run, cls = '') => h(`button.btn${cls}`, { type: 'button', dataset: { action: id }, onclick: run }, label);

  // ── Attention: what needs this person now ─────────────────────────────────

  /** Run `fn`, say what went wrong as a toast, and read everything again */
  async function answer(fn, done) {
    try {
      await fn();
      if (done) toast(done);
    } catch (err) {
      toast(err.message, 'error', 7000);
    }
    feed.refresh();
    extraFeed();
  }

  function attentionItems(d) {
    const items = [];
    const b = d.bench;
    for (const r of b ? extra.requests : []) { // a request read for a bench we may no longer be on is not shown
      items.push({
        id: 'request', tone: 'warning', icon: 'team', key: `request-${r.id}`,
        text: t('overview.attention.request', { name: r.name, bench: b.bench }),
        actions: [
          act(t('overview.attention.accept'), 'accept-request', () => answer(() => request('POST', benchPath(b.bench, `/requests/${encodeURIComponent(r.id)}/accept`)), t('overview.attention.accepted', { name: r.name })), '.primary.sm'),
          act(t('overview.attention.refuse'), 'refuse-request', () => answer(() => request('POST', benchPath(b.bench, `/requests/${encodeURIComponent(r.id)}/refuse`))), '.sm'),
        ],
      });
    }
    for (const inv of extra.invitations) {
      items.push({
        id: 'invitation', tone: 'info', icon: 'team', key: `invitation-${inv.team.id}`,
        text: t('overview.home.invitations.item', { by: inv.by?.name ?? inv.by?.username ?? '', team: inv.team.name }),
        actions: [act(t('overview.attention.join'), 'accept-invitation', () => answer(() => request('POST', `/api/teams/${encodeURIComponent(inv.team.id)}/accept`), t('overview.attention.joined', { team: inv.team.name })), '.primary.sm')],
      });
    }
    if (b?.you.occupant && b.holder && b.releaseAt) {
      const left = Date.parse(b.releaseAt) - Date.now();
      if (left > 0 && left < RELEASE_WARNING_MS) {
        items.push({
          id: 'release', tone: 'warning', icon: 'history', key: 'release',
          text: t('overview.attention.release', { bench: b.bench, count: Math.max(1, Math.ceil(left / 60_000)) }),
          actions: [act(t('overview.attention.stay'), 'stay', () => answer(() => request('POST', benchPath(b.bench, '/touch')), t('overview.attention.stayed')), '.primary.sm')],
        });
      }
    }
    if (b?.job) {
      items.push({
        id: 'job', tone: 'info', icon: 'archive', key: 'job',
        text: t('overview.attention.job', { bench: b.bench, name: b.job.actor, done: b.job.devices.finished, total: b.job.devices.total }),
        actions: [link(`#/jobs/${encodeURIComponent(b.bench)}`, t('overview.attention.see'), 'job', '.sm')],
      });
    }
    // Our own bench, locked; for an administrator every locked bench of the lab
    const locked = session.isAdmin ? (cards ?? []).filter((c) => c.state === 'locked') : b?.lock && b.you.occupant ? [b] : [];
    for (const c of locked) {
      items.push({
        id: 'locked', tone: 'danger', icon: 'lock', key: `locked-${c.bench}`,
        text: t('overview.attention.locked', { bench: c.bench, reason: c.lock.reason }),
        actions: [link(`#/consoles/${encodeURIComponent(c.bench)}`, t('overview.attention.see'), 'locked', '.sm')],
      });
    }
    if (session.isAdmin && extra.pendingAccounts) {
      items.push({
        id: 'accounts', tone: 'warning', icon: 'user', key: 'accounts',
        text: t('overview.attention.accounts', { count: extra.pendingAccounts }),
        actions: [link('#/admin/users', t('overview.attention.validate'), 'validate', '.primary.sm')],
      });
    }
    if (session.isAdmin && extra.health) {
      items.push({
        id: 'health', tone: 'danger', icon: 'pulse', key: 'health',
        text: t('overview.attention.health'),
        actions: [link('#/status', t('overview.attention.see'), 'health', '.sm')],
      });
    }
    return items;
  }

  function attentionPanel(d) {
    const items = attentionItems(d);
    if (!items.length) return null;
    return h('section.ov-attention', { dataset: { panel: 'attention' }, 'aria-labelledby': 'ov-attention-title' },
      h('h2.sr-only#ov-attention-title', t('overview.attention.title')),
      h('ul.ov-attention-list', items.map((i) => h('li.card.ov-attention-item', { dataset: { attention: i.id, tone: i.tone } },
        icon(i.icon), h('p', i.text), h('div.ov-attention-actions', i.actions)))));
  }

  // ── Ma baie ───────────────────────────────────────────────────────────────

  function heroCard(d) {
    const b = d.bench;
    const tone = b.state === 'locked' ? 'danger' : b.state === 'free' ? 'success' : null; // taken: the accent bar
    const consoles = b.consoles ?? [];
    const card = h('article.card.hero.ov-card.ov-hero', { dataset: { bench: b.bench, state: b.state, mine: String(b.you.occupant), ...(tone ? { tone } : {}) } });
    const holder = b.holder ? t('overview.card.heldBy', { team: b.holder.teamName ?? '?', time: fmtTime(b.holder.since) }) : t('overview.card.free');
    card.append(
      h('p.ov-eyebrow', t('overview.home.bench.title')),
      h('div.ov-hero-head', h('h2.ov-hero-name', b.bench), stateBadge(b), b.you.guest ? h('span.badge', { dataset: { tone: 'neutral' } }, t('overview.card.guest')) : null),
      h('p.ov-holder', holder));
    if (b.lock) card.append(h('p.ov-lock', { role: 'status' }, icon('lock'), h('span', h('strong', t('overview.card.locked')), ' ', b.lock.reason)));
    card.append(
      h('div.ov-hero-people', avatarStack(b.occupants.map((p) => p.name), { max: 4, label: t('overview.card.onBench') }),
        h('ul.sr-only', { 'aria-label': t('overview.card.onBench') }, b.occupants.map((p) => h('li', p.name)))),
      h('p.ov-meta', [
        t('overview.card.lines', { count: b.lines.open, total: b.lines.total }),
        b.holder && b.releaseAt ? t('overview.card.releaseAt', { time: fmtTime(b.releaseAt) }) : null,
      ].filter(Boolean).join(' · ')));
    const lines = lineStatus(b);
    if (lines) card.append(lines);
    if (consoles.length) {
      card.append(h('ul.ov-devices', { 'aria-label': t('overview.card.consolesOpen') }, consoles.map((k) => h('li.ov-device', { dataset: { device: k.device, task: String(Boolean(k.task)), state: k.state === 'connected' || k.state === 'silent' ? k.state : 'connecting' },
        title: [k.pilot ? t('overview.card.pilot', { name: k.pilot }) : t('overview.card.noPilot'), k.task ? t('overview.card.task') : null].filter(Boolean).join(' · ') },
        h('span.dot'), k.device, k.task ? h('small.ov-task', t('overview.card.task')) : null))));
    }
    card.append(h('div.card-foot.ov-hero-actions',
      link(`#/jobs/${encodeURIComponent(b.bench)}/backup`, t('overview.home.bench.backup'), 'backup'),
      link(`#/consoles/${encodeURIComponent(b.bench)}`, t('overview.home.bench.open'), 'open', '.primary')));
    return h('section.ov-bench-panel', { dataset: { panel: 'bench' } }, card);
  }

  function freeBenchesCard() {
    const free = (cards ?? []).filter((c) => c.state === 'free').slice(0, FREE_BENCHES_OFFERED);
    return h('section.card.ov-bench-panel', { dataset: { panel: 'bench' } },
      h('div.card-head', h('h2', t('overview.home.bench.title'))),
      h('div.card-body',
        h('p', t('overview.home.bench.noneTeam')),
        free.length
          ? h('ul.ov-take', free.map((c) => h('li', { dataset: { bench: c.bench } }, h('strong', c.bench),
            h('button.btn.sm.primary', { type: 'button', dataset: { action: 'take' }, onclick: (e) => take(c.bench, e.currentTarget) }, t('overview.home.bench.take')))))
          : h('p.muted', t('overview.home.bench.nonFree'))),
      h('div.card-foot', link('#/home/lab/free', t('overview.home.bench.seeAll'), 'overview')));
  }

  async function take(bench, button) {
    button.disabled = true;
    await answer(() => request('POST', benchPath(bench, '/take')), t('overview.home.bench.taken', { bench }));
    button.disabled = false;
  }

  function noTeamCard() {
    if (session.isAdmin) return null;
    return h('section.card.ov-bench-panel', { dataset: { panel: 'bench' } },
      h('div.card-head', h('h2', t('overview.home.bench.title'))),
      h('div.card-body', h('p', t('overview.home.bench.none')), h('p.muted', t('overview.home.team.noneHint'))),
      h('div.card-foot', link('#/team/mine', t('overview.home.team.create'), 'team', '.primary')));
  }

  function benchPanel(d) {
    if (d.bench) return heroCard(d);
    if (d.team) return freeBenchesCard();
    return noTeamCard();
  }

  function teamPanel(d) {
    if (d.team) {
      const names = d.team.members.map((m) => m.name);
      return h('a.card.link.ov-team', { href: '#/team/mine', dataset: { panel: 'team', action: 'team' } },
        h('p.ov-eyebrow', t('overview.home.team.title')),
        h('p.ov-team-name', h('strong', d.team.name)),
        h('p.ov-meta', t('overview.home.team.count', { count: names.length })),
        h('div.ov-members', avatarStack(names, { max: 4, label: t('overview.home.team.members') }),
          h('ul.sr-only', { 'aria-label': t('overview.home.team.members') }, d.team.members.map((m) => h('li', { dataset: { you: String(m.you) } }, m.name)))));
    }
    return null;
  }

  // ── The cards of the bottom row ───────────────────────────────────────────

  function slotsPanel(d) {
    if (!d.team) return null;
    const bench = d.bench?.bench;
    return h('section.card.ov-panel', { dataset: { panel: 'slots' } },
      h('div.card-head', h('h2', t('overview.home.slots.title'))),
      d.slots.length
        ? h('ul.ov-list', d.slots.slice(0, SLOTS_SHOWN).map((s) => h('li', h('strong', s.bench), h('span', fmtSlot(s)))))
        : h('p.muted', t('overview.home.slots.empty')),
      h('div.card-foot', link(`#/team/calendar${bench ? `/${encodeURIComponent(bench)}` : ''}`, t('overview.home.slots.book'), 'calendar', '.sm')));
  }

  function backupsPanel(d) {
    if (!d.team) return null; // a backup belongs to a team: without one there is nothing to list or to look for
    const bench = d.backups[0]?.bench ?? d.bench?.bench;
    return h('section.card.ov-panel', { dataset: { panel: 'backups' } },
      h('div.card-head', h('h2', t('overview.home.backups.title'))),
      d.backups.length
        ? h('ul.ov-list', d.backups.slice(0, BACKUPS_SHOWN).map((s) => h('li', { dataset: { snapshot: s.id } },
          h('div.ov-list-text',
            h('a', { href: `#/jobs/${encodeURIComponent(s.bench)}` }, h('strong', s.label || fmtShort(s.createdAt))),
            h('span.muted', `${s.bench} · ${t('overview.home.backups.devices', { count: s.devices })} · ${s.author}`)),
          h('a.btn.sm', { href: `/api/jobs/snapshots/${encodeURIComponent(s.id)}/zip`, download: '', dataset: { action: 'download' }, 'aria-label': `${t('overview.home.backups.download')} · ${s.label || fmtShort(s.createdAt)}` }, icon('download'), t('overview.home.backups.download')))))
        : h('p.muted', t('overview.home.backups.empty')),
      h('div.card-foot', link(bench ? `#/jobs/${encodeURIComponent(bench)}` : '#/jobs', t('overview.home.backups.all'), 'backups', '.sm')));
  }

  function activityPanel(d) {
    if (!d.bench?.you.occupant) return null; // the story of a bench is for those who work on it
    const shown = more ? d.activity : d.activity.slice(0, ACTIVITY_SHOWN);
    return h('section.card.ov-panel', { dataset: { panel: 'activity' } },
      h('div.card-head', h('h2', t('overview.home.activity.title'))),
      d.activity.length
        ? h('ol.ov-activity', shown.map((e) => h('li', h('time', { datetime: e.ts }, fmtDateTime(e.ts)), h('span', activityText(e)))))
        : h('p.muted', t('overview.home.activity.empty')),
      d.activity.length > ACTIVITY_SHOWN
        ? h('div.card-foot', act(t(more ? 'overview.home.activity.less' : 'overview.home.activity.more'), 'more', () => { more = !more; render(); }, '.sm.ghost'))
        : null);
  }

  /** An administrator's shortcuts: invite, announce, lab parameters */
  function adminPanel() {
    return h('section.card.ov-panel.ov-admin', { dataset: { panel: 'admin' } },
      h('div.card-head', h('h2', t('overview.home.admin.title'))),
      h('div.ov-shortcuts',
        link('#/admin/invitations', t('overview.home.admin.invite'), 'invite'),
        link('#/admin/announcement', t('overview.home.admin.announce'), 'announce'),
        link('#/admin/lab', t('overview.home.admin.lab'), 'lab')));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    header.update({});
    if (!data) {
      content.replaceChildren(failure ? loadFailure('overview.loadError', failure, () => { failure = null; render(); feed.refresh(); }) : loading());
      return;
    }
    const d = data;
    lab.render(cards);
    const trio = [slotsPanel(d), backupsPanel(d), activityPanel(d)].filter(Boolean);
    const personal = session.isAdmin
      ? [lab.el, adminPanel()]
      : [h('div.ov-top', benchPanel(d), teamPanel(d)), lab.el, trio.length ? h('div.ov-trio', trio) : null];
    replaceKeepingFocus(content, [
      attentionPanel(d),
      ...personal,
    ].filter(Boolean));
    if (wantLab) {
      wantLab = false;
      lab.focusHeading();
    }
  }

  // The few things the home data alone cannot say: who asks to join, the invitations' teams, the accounts waiting
  async function readExtra({ force = false } = {}) {
    const ticket = ++extraTicket;
    const d = data;
    if (!d) return;
    // The administration's numbers move slowly and cost a request each: read them again every 30 s, or when accounts change
    const adminFresh = !force && Date.now() - adminReadAt < ADMIN_REFRESH_MS;
    const next = { requests: [], invitations: [], pendingAccounts: adminFresh ? extra.pendingAccounts : 0, health: adminFresh ? extra.health : null };
    const jobs = [];
    if (d.bench?.requests && d.bench.you.occupant) {
      jobs.push(getJson(benchPath(d.bench.bench)).then((b) => { next.requests = b.requests ?? []; }));
    }
    if (d.invitations.length) jobs.push(getJson('/api/teams').then((r) => { next.invitations = r.invitations ?? []; }));
    if (session.isAdmin && !adminFresh) {
      adminReadAt = Date.now();
      jobs.push(getJson('/api/accounts/users').then(({ users }) => { next.pendingAccounts = users.filter((u) => u.state === 'pending').length; }));
      jobs.push(getJson('/api/admin/health').then((hl) => {
        const bad = (s) => s === 'down' || s === 'partial';
        next.health = bad(hl.jump?.state) || bad(hl.proxmox?.state) || (hl.consoleServers?.total > 0 && hl.consoleServers.ok < hl.consoleServers.total) ? true : null;
      }));
    }
    await Promise.allSettled(jobs);
    if (ticket !== extraTicket) return;
    if (session.isAdmin) setNavBadge('admin', next.pendingAccounts ? { count: next.pendingAccounts, tone: 'danger' } : null);
    const same = JSON.stringify(next) === JSON.stringify(extra);
    extra = next;
    if (!same) render();
  }
  const extraFeed = (options) => { readExtra(options); };

  const topics = ['benches:state', 'benches:reservations', 'consoles:rooms', 'jobs:running', 'jobs:done', 'jobs:snapshots', 'teams:changed', 'teams:invitation', 'admin:announcement', 'checks:running'];
  const feed = followApi('/api/overview/home', {
    // Everything the page shows moves with one of these: the benches and teams, the jobs (a finished backup), the announcement
    topics,
    changed: { 'consoles:rooms': roomsSignature, 'checks:running': checksSignature },
    onData: (next) => {
      // Most events move nothing the page shows: draw again only when the answer differs
      const same = data && !failure && JSON.stringify(next) === JSON.stringify(data);
      data = next;
      failure = null;
      if (!same) { render(); extraFeed(); }
    },
    onError: (err) => { failure = err; if (!data) render(); },
  });
  const benchesFeed = followApi('/api/overview/benches', {
    topics: ['benches:state', 'benches:reservations', 'consoles:rooms', 'consoles:busy', 'jobs:running', 'teams:changed', 'checks:running'],
    changed: { 'consoles:rooms': roomsSignature, 'checks:running': checksSignature },
    onData: (next) => {
      const same = cards && JSON.stringify(next.benches) === JSON.stringify(cards);
      cards = next.benches;
      if (!same) render();
    },
    onError: () => {},
  });
  // Accounts waiting for validation move with the administration's own topic
  live.on('accounts:changed', () => { if (session.isAdmin && timer) extraFeed({ force: true }); });

  onLocaleChange(render);
  render();

  return {
    show([sub, filter] = []) {
      feed.show();
      benchesFeed.show();
      // The release warning counts down: look again now and then
      timer ??= setInterval(() => { if (data) render(); }, TICK_MS);
      if (sub === 'lab') {
        if (isFilter(filter)) lab.setFilter(filter);
        // The block is in the page once the data is there
        wantLab = true;
        if (data) render();
      }
    },
    hide() {
      feed.hide();
      benchesFeed.hide();
      clearInterval(timer);
      timer = null;
    },
  };
}
