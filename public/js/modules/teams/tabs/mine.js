/**
 * "Mon équipe" (#/team/mine): the invitations waiting for me, then either a
 * form to create a team, or my team: its members, the invitation form, the
 * invitations still open, the bench it holds and its slots (docs/v2/UX.md
 * §10.2). Renaming and leaving are in the header
 */
import { h, icon, toast } from '../../../core/dom.js';
import { live, request, getJson, callOrToast } from '../../../core/api.js';
import { loading, loadFailure, emptyState } from '../../../shared/loadState.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { session } from '../../../core/session.js';
import { confirmDialog, formDialog } from '../../../shared/dialog.js';
import { moreButton } from '../../../shared/menu.js';
import { teamUrl, onBenches, fmtSlot, personAvatar } from '../data.js';
import { fmtDateTime } from '../../../core/format.js';

export function mount(el, { header }) {
  const root = h('div.team-page');
  el.append(root);
  let data = null;
  let slots = [];
  let benches = new Map();
  let visible = false;
  let failure = null;

  async function load() {
    if (!data) root.replaceChildren(loading());
    try {
      const [teams, resv] = await Promise.all([
        getJson('/api/teams'),
        getJson(`/api/benches/reservations?from=${new Date().toISOString()}`),
      ]);
      data = teams;
      slots = resv.reservations ?? [];
      failure = null;
    } catch (err) {
      failure = err;
    }
    render();
  }

  live.on('teams:changed', () => visible && load());
  live.on('teams:invitation', () => visible && load());
  live.on('benches:reservations', () => visible && load());
  onBenches((all) => { benches = all; if (data) render(); });
  onLocaleChange(() => render());

  // ── Actions ───────────────────────────────────────────────────────────────

  async function create(form) {
    const name = form.elements.name.value;
    const res = await callOrToast('POST', '/api/teams', { name });
    if (res) { toast(t('teams.create.done', { name: res.team.name })); await load(); }
  }

  async function invite(form, team) {
    const username = form.elements.username.value.trim();
    if (!username) return;
    const res = await callOrToast('POST', teamUrl(team.id, '/invitations'), { username });
    if (res) { toast(t('teams.invite.done', { username })); form.reset(); await load(); }
  }

  async function answer(inv, accept) {
    const res = accept
      ? await callOrToast('POST', teamUrl(inv.team.id, '/accept'))
      : await callOrToast('DELETE', teamUrl(inv.team.id, `/invitations/${encodeURIComponent(session.user.username)}`));
    if (res) { if (accept) toast(t('teams.invitations.joined', { team: inv.team.name })); await load(); }
  }

  async function withdraw(team, username) {
    if (await callOrToast('DELETE', teamUrl(team.id, `/invitations/${encodeURIComponent(username)}`))) await load();
  }

  async function rename(team) {
    await formDialog({
      title: t('teams.rename.title'),
      fields: [{ name: 'name', label: t('teams.create.name'), value: team.name, required: true, attrs: { maxlength: 40 } }],
      submitLabel: t('teams.rename.confirm'),
      onSubmit: async ({ name }) => { await request('PATCH', teamUrl(team.id), { name }); await load(); },
    });
  }

  async function leave(team) {
    const last = team.members.length === 1;
    const ok = await confirmDialog({
      title: t('teams.leave.title', { team: team.name }),
      body: last ? t('teams.leave.last') : t('teams.leave.body'),
      confirmLabel: t('teams.leave.confirm'),
      danger: true,
    });
    if (ok && await callOrToast('POST', teamUrl(team.id, '/leave'))) await load();
  }

  async function cancelSlot(r) {
    const ok = await confirmDialog({ title: t('teams.slots.cancelTitle'), body: t('teams.slots.cancelBody', { bench: r.bench, slot: fmtSlot(r) }), confirmLabel: t('teams.slots.cancel'), danger: true });
    if (ok && await callOrToast('DELETE', `/api/benches/reservations/${encodeURIComponent(r.id)}`)) await load();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /** The header follows what is on screen: rename and leave only with a team */
  function syncHeader() {
    if (!visible) return;
    const team = data?.mine;
    header.update({
      context: team ? () => t('teams.context', { team: team.name }) : () => t('teams.contextNone'),
      primary: null,
      actions: team ? [
        { id: 'rename', label: 'teams.rename.button', icon: 'edit', run: () => rename(team) },
        { id: 'leave', label: 'teams.leave.button', icon: 'logout', run: () => leave(team), danger: true },
      ] : [],
    });
  }

  function render() {
    syncHeader();
    if (!data) { root.replaceChildren(failure ? loadFailure('teams.loadFailed', failure, load) : loading()); return; }
    // What someone is typing survives a redraw caused by an event
    const typed = new Map([...root.querySelectorAll('input[name]')].map((input) => [input.name, input.value]));
    const hadFocus = document.activeElement?.name;
    root.replaceChildren(...(data.mine ? myTeam(data.mine) : [invitations(), createForm()]).filter(Boolean));
    for (const input of root.querySelectorAll('input[name]')) {
      if (typed.get(input.name)) input.value = typed.get(input.name);
      if (hadFocus && input.name === hadFocus) input.focus();
    }
  }

  function invitations() {
    if (!data.invitations.length) return null;
    return h('section.card.team-invitations', { 'aria-label': t('teams.invitations.title') },
      h('div.card-head', h('h2', t('teams.invitations.title')), h('span.count', { dataset: { tone: 'danger' } }, String(data.invitations.length))),
      h('ul.team-list', data.invitations.map((inv) => h('li', { dataset: { team: inv.team.id } },
        h('span.team-line', t('teams.invitations.line', { team: inv.team.name, name: inv.by?.name ?? '' })),
        h('span.team-row-actions',
          h('button.btn.sm.primary', { type: 'button', dataset: { action: 'accept' }, onclick: () => answer(inv, true) }, t('teams.invitations.accept')),
          h('button.btn.sm.ghost', { type: 'button', dataset: { action: 'decline' }, onclick: () => answer(inv, false) }, t('teams.invitations.decline')))))));
  }

  function createForm() {
    return h('section.card', { 'aria-label': t('teams.create.title') },
      h('div.card-head', h('h2', t('teams.create.title'))),
      h('form.team-form.form-grid', { onsubmit: (e) => { e.preventDefault(); create(e.target); } },
        h('p.card-meta', session.isAdmin ? t('teams.create.adminNote') : t('teams.create.intro')),
        h('label', h('span', t('teams.create.name')), h('input.field', { name: 'name', required: true, minlength: 2, maxlength: 40, autocomplete: 'off', placeholder: t('teams.create.placeholder') })),
        h('div.team-form-actions', h('button.btn.primary', { type: 'submit', dataset: { action: 'create' } }, icon('plus'), t('teams.create.submit')))));
  }

  function myTeam(team) {
    const held = [...benches.values()].find((b) => b.holder?.teamId === team.id);
    const mySlots = slots.filter((r) => r.teamId === team.id);
    return [
      h('section.card.team-mine', { dataset: { team: team.id }, 'aria-label': team.name },
        h('div.card-head', h('h2', icon('team'), h('span.team-name', team.name)), h('span.card-meta', t('teams.members.title', { count: team.people.length }))),
        h('ul.team-list.team-members', team.people.map((p) => h('li', { dataset: { user: p.username } },
          personAvatar(p, '.md'),
          h('span.team-person', h('strong', p.name), h('span.card-meta', `@${p.username} · ${t('teams.members.since', { time: fmtDateTime(p.since) })}`)))))),
      h('section.card', { 'aria-label': t('teams.invite.title') },
        h('div.card-head', h('h2', t('teams.invite.title'))),
        h('form.team-form.form-grid', { onsubmit: (e) => { e.preventDefault(); invite(e.target, team); } },
          h('label', h('span', t('teams.invite.username')), h('input.field', { name: 'username', required: true, maxlength: 64, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: t('teams.invite.placeholder') })),
          h('div.team-form-actions', h('button.btn.primary', { type: 'submit', dataset: { action: 'invite' } }, icon('send'), t('teams.invite.submit')))),
        team.invitations.length ? h('div.card-section',
          h('h3', t('teams.invite.waiting')),
          h('ul.team-list.team-sent', team.invitations.map((inv) => h('li', { dataset: { invitee: inv.username } },
            h('span.team-line', t('teams.invite.pending', { username: inv.username })),
            moreButton(() => [{ id: 'withdraw', label: 'teams.invite.withdraw', icon: 'close', danger: true }], { onSelect: () => withdraw(team, inv.username), label: () => t('teams.invite.menu', { username: inv.username }) }))))) : null),
      h('section.card', { 'aria-label': t('teams.bench.title') },
        h('div.card-head', h('h2', t('teams.bench.title'))),
        held
          ? h('div.team-bench', h('p', t('teams.bench.holds', { bench: held.bench })),
            h('span.team-row-actions',
              h('a.btn.sm', { href: `#/team/bench/${encodeURIComponent(held.bench)}` }, icon('rack'), t('teams.bench.manage')),
              h('a.btn.sm', { href: `#/consoles/${encodeURIComponent(held.bench)}` }, icon('topology'), t('teams.bench.open'))))
          : emptyState({ icon: 'rack', title: 'teams.bench.noneTitle', text: 'teams.bench.none', action: { label: 'teams.bench.take', icon: 'check', run: () => { location.hash = '#/team/bench'; } } }),
        h('div.card-section',
          h('div.card-head', h('h3', t('teams.slots.title')), h('a.btn.sm', { href: '#/team/calendar', dataset: { action: 'calendar' } }, icon('calendar'), t('teams.slots.book'))),
          mySlots.length
            ? h('ul.team-list', mySlots.map((r) => h('li', h('span.team-line', `${r.bench} · ${fmtSlot(r)}`),
              h('button.btn.sm.ghost.danger', { type: 'button', dataset: { action: 'cancel-slot' }, onclick: () => cancelSlot(r) }, t('teams.slots.cancel')))))
            : h('p.card-meta', t('teams.slots.none')))),
    ];
  }

  return {
    show() { visible = true; syncHeader(); load(); },
    hide() { visible = false; },
  };
}
