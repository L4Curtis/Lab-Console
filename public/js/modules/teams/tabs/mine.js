/**
 * "My team": the invitations waiting for me, then either a form to create a
 * team or my team (members, invitations sent, the bench it holds, its slots)
 * with invite / rename / leave
 */
import { h, icon, toast } from '../../../core/dom.js';
import { live, request } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { session } from '../../../core/session.js';
import { confirmDialog, formDialog } from '../../../shared/dialog.js';
import { call, teamUrl, onBenches, fmtDateTime, fmtSlot } from '../data.js';

export function mount(el) {
  const root = h('div.panel.team-panel');
  el.append(root);
  let data = null;
  let slots = [];
  let benches = new Map();
  let visible = false;

  async function load() {
    const [teams, resv] = await Promise.all([
      call('GET', '/api/teams', undefined, { quiet: true }),
      call('GET', `/api/benches/reservations?from=${new Date().toISOString()}`, undefined, { quiet: true }),
    ]);
    data = teams;
    slots = resv?.reservations ?? [];
    render();
  }

  live.on('teams:changed', () => visible && load());
  live.on('teams:invitation', () => visible && load());
  live.on('benches:reservations', () => visible && load());
  onBenches((all) => { benches = all; if (data) render(); });
  onLocaleChange(() => data && render());

  // ── Actions ───────────────────────────────────────────────────────────────

  async function create(form) {
    const name = form.elements.name.value;
    const res = await call('POST', '/api/teams', { name });
    if (res) { toast(t('teams.create.done', { name: res.team.name })); await load(); }
  }

  async function invite(form, team) {
    const username = form.elements.username.value.trim();
    if (!username) return;
    const res = await call('POST', teamUrl(team.id, '/invitations'), { username });
    if (res) { toast(t('teams.invite.done', { username })); form.reset(); await load(); }
  }

  async function answer(inv, accept) {
    const res = accept
      ? await call('POST', teamUrl(inv.team.id, '/accept'))
      : await call('DELETE', teamUrl(inv.team.id, `/invitations/${encodeURIComponent(session.user.username)}`));
    if (res) { if (accept) toast(t('teams.invitations.joined', { team: inv.team.name })); await load(); }
  }

  async function withdraw(team, username) {
    if (await call('DELETE', teamUrl(team.id, `/invitations/${encodeURIComponent(username)}`))) await load();
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
    if (ok && await call('POST', teamUrl(team.id, '/leave'))) await load();
  }

  async function cancelSlot(r) {
    const ok = await confirmDialog({ title: t('teams.slots.cancelTitle'), body: t('teams.slots.cancelBody', { bench: r.bench, slot: fmtSlot(r) }), confirmLabel: t('teams.slots.cancel'), danger: true });
    if (ok && await call('DELETE', `/api/benches/reservations/${encodeURIComponent(r.id)}`)) await load();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    if (!data) { root.replaceChildren(h('p.muted', t('teams.loadFailed'))); return; }
    root.replaceChildren(invitations(), data.mine ? myTeam(data.mine) : createForm());
  }

  function invitations() {
    if (!data.invitations.length) return '';
    return h('section.team-card.team-invitations', h('h2', t('teams.invitations.title')),
      h('ul.team-list', data.invitations.map((inv) => h('li', { dataset: { team: inv.team.id } },
        h('span', t('teams.invitations.line', { team: inv.team.name, name: inv.by?.name ?? '' })),
        h('span.team-row-actions',
          h('button.btn.small.primary', { type: 'button', dataset: { action: 'accept' }, onclick: () => answer(inv, true) }, t('teams.invitations.accept')),
          h('button.btn.small', { type: 'button', dataset: { action: 'decline' }, onclick: () => answer(inv, false) }, t('teams.invitations.decline')))))));
  }

  function createForm() {
    return h('section.team-card',
      h('h2', t('teams.create.title')),
      h('p.muted', session.isAdmin ? t('teams.create.adminNote') : t('teams.create.intro')),
      h('form.team-form', { onsubmit: (e) => { e.preventDefault(); create(e.target); } },
        h('label', h('span', t('teams.create.name')), h('input.field', { name: 'name', required: true, minlength: 2, maxlength: 40, autocomplete: 'off', placeholder: t('teams.create.placeholder') })),
        h('button.btn.primary', { type: 'submit', dataset: { action: 'create' } }, icon('plus'), t('teams.create.submit'))));
  }

  function myTeam(team) {
    const held = [...benches.values()].find((b) => b.holder?.teamId === team.id);
    const mySlots = slots.filter((r) => r.teamId === team.id);
    return h('section.team-card.team-mine', { dataset: { team: team.id } },
      h('div.team-head',
        h('h2', icon('team'), h('span.team-name', team.name)),
        h('span.team-row-actions',
          h('button.btn.small.subtle', { type: 'button', dataset: { action: 'rename' }, onclick: () => rename(team) }, t('teams.rename.button')),
          h('button.btn.small.danger', { type: 'button', dataset: { action: 'leave' }, onclick: () => leave(team) }, t('teams.leave.button')))),
      h('h3', t('teams.members.title', { count: team.people.length })),
      h('ul.team-list.team-members', team.people.map((p) => h('li', { dataset: { user: p.username } },
        h('strong', p.name), h('span.muted', `@${p.username}`), h('span.muted', t('teams.members.since', { time: fmtDateTime(p.since) }))))),
      h('h3', t('teams.invite.title')),
      h('form.team-form', { onsubmit: (e) => { e.preventDefault(); invite(e.target, team); } },
        h('label', h('span', t('teams.invite.username')), h('input.field', { name: 'username', required: true, maxlength: 64, autocomplete: 'off', spellcheck: 'false', placeholder: t('teams.invite.placeholder') })),
        h('button.btn', { type: 'submit', dataset: { action: 'invite' } }, t('teams.invite.submit'))),
      team.invitations.length ? h('ul.team-list.team-sent', team.invitations.map((inv) => h('li', { dataset: { invitee: inv.username } },
        h('span', t('teams.invite.pending', { username: inv.username })),
        h('button.btn.small.subtle', { type: 'button', dataset: { action: 'withdraw' }, onclick: () => withdraw(team, inv.username) }, t('teams.invite.withdraw'))))) : '',
      h('h3', t('teams.bench.title')),
      held
        ? h('p.team-bench', t('teams.bench.holds', { bench: held.bench }), ' ', h('a', { href: `#/consoles/${encodeURIComponent(held.bench)}` }, t('teams.bench.open')))
        : h('p.muted', t('teams.bench.none')),
      h('h3', t('teams.slots.title')),
      mySlots.length
        ? h('ul.team-list', mySlots.map((r) => h('li', h('span', `${r.bench} · ${fmtSlot(r)}`),
          h('button.btn.small.subtle', { type: 'button', dataset: { action: 'cancel-slot' }, onclick: () => cancelSlot(r) }, t('teams.slots.cancel')))))
        : h('p.muted', t('teams.slots.none')));
  }

  return {
    show() { visible = true; load(); },
    hide() { visible = false; },
  };
}
