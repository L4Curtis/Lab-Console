/**
 * Every team, for admins: members (remove one), invitations waiting, the
 * bench each team holds; rename or dissolve. The server answers 403 to
 * anyone else, whatever this screen shows
 */
import { h, icon } from '../../../core/dom.js';
import { live, request } from '../../../core/api.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { confirmDialog, formDialog } from '../../../shared/dialog.js';
import { call, teamUrl, onBenches } from '../data.js';

export function mount(el) {
  const body = h('tbody');
  const table = h('table.vm-table.team-table', h('thead', h('tr', h('th'), h('th'), h('th'), h('th'))), body);
  const head = table.querySelector('tr');
  el.append(h('div.panel', h('div.table-wrap', table)));
  let teams = [];
  let benches = new Map();
  let visible = false;

  async function load() {
    const data = await call('GET', '/api/teams', undefined, { quiet: true });
    teams = data?.teams ?? [];
    render();
  }

  live.on('teams:changed', () => visible && load());
  onBenches((all) => { benches = all; render(); });
  onLocaleChange(() => render());

  async function rename(team) {
    await formDialog({
      title: t('teams.rename.title'),
      fields: [{ name: 'name', label: t('teams.create.name'), value: team.name, required: true, attrs: { maxlength: 40 } }],
      submitLabel: t('teams.rename.confirm'),
      onSubmit: async ({ name }) => { await request('PATCH', teamUrl(team.id), { name }); await load(); },
    });
  }

  async function dissolve(team) {
    const ok = await confirmDialog({ title: t('teams.all.dissolveTitle', { team: team.name }), body: t('teams.all.dissolveBody'), confirmLabel: t('teams.all.dissolve'), danger: true, requireText: team.name });
    if (ok && await call('DELETE', teamUrl(team.id))) await load();
  }

  async function removeMember(team, person) {
    const ok = await confirmDialog({ title: t('teams.all.removeTitle', { name: person.name, team: team.name }), body: t('teams.all.removeBody'), confirmLabel: t('teams.all.remove'), danger: true });
    if (ok && await call('DELETE', teamUrl(team.id, `/members/${encodeURIComponent(person.id)}`))) await load();
  }

  function render() {
    const labels = [t('teams.all.team'), t('teams.all.members'), t('teams.all.bench'), ''];
    [...head.children].forEach((th, i) => { th.textContent = labels[i]; });
    if (!teams.length) {
      body.replaceChildren(h('tr', h('td.empty-row', { colspan: 4 }, t('teams.all.none'))));
      return;
    }
    body.replaceChildren(...teams.map((team) => {
      const held = [...benches.values()].find((b) => b.holder?.teamId === team.id);
      return h('tr', { dataset: { team: team.id } },
        h('td', h('strong', team.name)),
        h('td', h('ul.team-chips', (team.people ?? []).map((p) => h('li', p.name,
          h('button.icon-btn.small', { type: 'button', title: t('teams.all.remove'), 'aria-label': `${t('teams.all.remove')} · ${p.name}`, onclick: () => removeMember(team, p) }, icon('close'))))),
        team.invitations?.length ? h('small.muted', t('teams.all.invited', { names: team.invitations.map((i) => i.username).join(', ') })) : ''),
        h('td', held ? h('a', { href: `#/consoles/${encodeURIComponent(held.bench)}` }, held.bench) : h('span.muted', '—')),
        h('td.right',
          h('button.btn.small.subtle', { type: 'button', dataset: { action: 'rename' }, onclick: () => rename(team) }, t('teams.rename.button')),
          h('button.btn.small.danger', { type: 'button', dataset: { action: 'dissolve' }, onclick: () => dissolve(team) }, t('teams.all.dissolve'))));
    }));
  }

  return {
    show() { visible = true; load(); },
    hide() { visible = false; },
  };
}
