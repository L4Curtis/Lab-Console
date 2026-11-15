/**
 * Every team, for admins (#/team/all): members (open the row to remove one),
 * the bench each team holds, rename or dissolve. The server answers 403 to
 * anyone else, whatever this screen shows
 */
import { h, icon } from '../../../core/dom.js';
import { live, request, getJson, callOrToast } from '../../../core/api.js';
import { loadFailure } from '../../../shared/loadState.js';
import { t, onLocaleChange } from '../../../core/i18n.js';
import { confirmDialog, formDialog, openDialog } from '../../../shared/dialog.js';
import { dataList } from '../../../shared/dataList.js';
import { teamUrl, onBenches, avatarStack, personAvatar } from '../data.js';
import { fmtDate } from '../../../core/format.js';

export function mount(el, { header }) {
  const failure = h('div');
  let teams = [];
  let benches = new Map();
  let visible = false;

  const heldBy = (team) => [...benches.values()].find((b) => b.holder?.teamId === team.id);
  const list = dataList({
    label: () => t('teams.all.title'),
    columns: [
      { id: 'team', label: 'teams.all.team', cell: (team) => team.name, primary: true },
      { id: 'members', label: 'teams.all.members', cell: (team) => h('span.team-members-cell', avatarStack(team.people ?? [], { max: 4 }), h('span.card-meta', t('teams.members.title', { count: team.people?.length ?? 0 }))) },
      { id: 'bench', label: 'teams.all.bench', cell: (team) => { const held = heldBy(team); return held ? h('a', { href: `#/team/bench/${encodeURIComponent(held.bench)}` }, held.bench) : h('span.card-meta', '—'); }, meta: true },
      { id: 'created', label: 'teams.all.created', cell: (team) => fmtDate(team.createdAt), hideCompact: true },
    ],
    actions: () => [
      { id: 'members', label: 'teams.all.manage', icon: 'team', primary: true, run: (team) => manage(team) },
      { id: 'rename', label: 'teams.rename.button', icon: 'edit', run: (team) => rename(team) },
      { id: 'dissolve', label: 'teams.all.dissolve', icon: 'trash', danger: true, run: (team) => dissolve(team) },
    ],
    empty: { icon: 'team', title: 'teams.all.noneTitle', text: 'teams.all.none' },
    onOpen: (team) => manage(team),
    rowKey: (team) => team.id,
  });
  el.append(h('div.team-wide', failure, list.el));

  async function load() {
    try {
      teams = (await getJson('/api/teams')).teams ?? [];
      failure.replaceChildren();
    } catch (err) {
      failure.replaceChildren(loadFailure('teams.loadFailed', err, load));
    }
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
    if (ok && await callOrToast('DELETE', teamUrl(team.id))) await load();
  }

  async function removeMember(team, person) {
    const ok = await confirmDialog({ title: t('teams.all.removeTitle', { name: person.name, team: team.name }), body: t('teams.all.removeBody'), confirmLabel: t('teams.all.remove'), danger: true });
    if (ok && await callOrToast('DELETE', teamUrl(team.id, `/members/${encodeURIComponent(person.id)}`))) await load();
  }

  /** The members of a team, each with a way to remove them, and who was invited */
  function manage(team) {
    const body = h('div.modal-body.team-manage');
    const draw = () => {
      const now = teams.find((x) => x.id === team.id);
      if (!now) { dlg.close(); return; }
      body.replaceChildren(
        h('ul.team-list', (now.people ?? []).map((p) => h('li', { dataset: { user: p.username } },
          personAvatar(p, '.md'),
          h('span.team-person', h('strong', p.name), h('span.card-meta', `@${p.username}`)),
          h('button.btn.sm.ghost.danger', { type: 'button', dataset: { action: 'remove-member' }, 'aria-label': `${t('teams.all.remove')} · ${p.name}`, onclick: async () => { await removeMember(now, p); draw(); } }, icon('close'), t('teams.all.removeShort'))))),
        now.invitations?.length ? h('p.card-meta', t('teams.all.invited', { names: now.invitations.map((i) => i.username).join(', ') })) : null);
    };
    const dlg = openDialog(body, { title: () => t('teams.all.manageTitle', { team: team.name }), size: 'md' });
    draw();
    const stop = live.on('teams:changed', () => load().then(draw));
    dlg.closed.then(stop);
  }

  function render() {
    if (visible) header.update({ context: () => t('teams.all.context', { count: teams.length }), primary: null, actions: [] });
    list.render(teams);
  }

  return {
    show() { visible = true; render(); load(); },
    hide() { visible = false; },
  };
}
