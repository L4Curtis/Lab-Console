/**
 * Reservation calendar: one bench, one week, 8:00 to 20:00. A click on a
 * free hour books a slot for my team (admins choose the team); a click on a
 * slot of my team (any slot, for admins) cancels it. The server checks the
 * overlaps and the limits; its refusal is shown in the dialog
 */
import { h, icon } from '../../../core/dom.js';
import { getJson, live, request } from '../../../core/api.js';
import { t, getLocale, onLocaleChange } from '../../../core/i18n.js';
import { session } from '../../../core/session.js';
import { confirmDialog, formDialog } from '../../../shared/dialog.js';
import { call, fmtDay, fmtSlot, fmtTime } from '../data.js';

const FIRST_HOUR = 8;
const LAST_HOUR = 20;
const DAY = 24 * 3_600_000;

/** Monday 00:00 (local time) of the week that contains `date` */
function weekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export function mount(el, { navigate }) {
  let benchNames = [];
  let bench = null;
  let monday = weekStart(new Date());
  let reservations = [];
  let limits = null;
  let teams = null;
  let visible = false;

  const select = h('select.field', { 'aria-label': t('teams.calendar.bench'), onchange: () => { bench = select.value; navigate(`#/team/calendar/${encodeURIComponent(bench)}`); load(); } });
  const title = h('strong.cal-week');
  const prev = h('button.icon-btn', { type: 'button', onclick: () => move(-7) }, icon('chevronLeft'));
  const today = h('button.btn.small', { type: 'button', onclick: () => { monday = weekStart(new Date()); load(); } });
  const next = h('button.icon-btn', { type: 'button', onclick: () => move(7) }, icon('chevronRight'));
  const note = h('p.muted.cal-note');
  const grid = h('div.cal-grid', { role: 'grid' });
  el.append(h('div.panel.cal-panel', h('div.panel-toolbar', select, prev, today, next, title), note, h('div.cal-scroll', grid)));

  function move(days) {
    monday = new Date(monday.getTime() + days * DAY);
    monday = weekStart(new Date(monday.getTime() + 12 * 3_600_000)); // daylight saving changes stay on Monday
    load();
  }

  async function load() {
    if (!benchNames.length) {
      const data = await call('GET', '/api/benches', undefined, { quiet: true });
      benchNames = (data?.benches ?? []).map((b) => b.bench);
      if (!bench || !benchNames.includes(bench)) bench = benchNames[0] ?? null;
    }
    if (!bench) { grid.replaceChildren(h('p.muted', t('teams.calendar.noBench'))); return; }
    const from = monday.toISOString();
    const to = new Date(monday.getTime() + 7 * DAY + 3_600_000).toISOString();
    const data = await call('GET', `/api/benches/reservations?bench=${encodeURIComponent(bench)}&from=${from}&to=${to}`);
    reservations = data?.reservations ?? [];
    limits = data?.limits ?? limits;
    render();
  }

  live.on('benches:reservations', (d) => { if (visible && d?.bench === bench) load(); });
  onLocaleChange(() => render());

  async function myTeam() {
    if (!teams) teams = await getJson('/api/teams').catch(() => null);
    return teams;
  }

  async function book(day, hour) {
    const start = new Date(day);
    start.setHours(hour, 0, 0, 0);
    teams = null; // read again: the team may have changed since the calendar was drawn
    const info = await myTeam();
    if (!info?.mine && !session.isAdmin) return confirmDialog({ title: t('teams.calendar.needTeamTitle'), body: t('teams.calendar.needTeam'), confirmLabel: t('common.actions.ok') });
    const maxHours = session.isAdmin ? 12 : limits?.maxHours ?? 4;
    const durations = [];
    for (let m = 30; m <= maxHours * 60; m += 30) durations.push({ value: m, label: t('teams.calendar.duration', { hours: Math.floor(m / 60), minutes: String(m % 60).padStart(2, '0') }) });
    const fields = [
      { name: 'time', label: t('teams.calendar.start'), type: 'time', value: `${String(hour).padStart(2, '0')}:00`, required: true, attrs: { step: 900 } },
      { name: 'minutes', label: t('teams.calendar.length'), type: 'select', options: durations, value: 120 },
    ];
    if (session.isAdmin) fields.push({ name: 'teamId', label: t('teams.calendar.team'), type: 'select', options: (info?.teams ?? []).map((x) => ({ value: x.id, label: x.name })), value: info?.mine?.id });
    await formDialog({
      title: t('teams.calendar.bookTitle', { bench, day: fmtDay(start) }),
      intro: limits && !session.isAdmin ? t('teams.calendar.limits', { max: limits.maxFuture, hours: limits.maxHours }) : undefined,
      fields,
      submitLabel: t('teams.calendar.book'),
      onSubmit: async ({ time, minutes, teamId }) => {
        const [hh, mm] = String(time).split(':').map(Number);
        const s = new Date(day);
        s.setHours(hh, mm, 0, 0);
        const e = new Date(s.getTime() + Number(minutes) * 60_000);
        await request('POST', '/api/benches/reservations', { bench, start: s.toISOString(), end: e.toISOString(), ...(teamId ? { teamId } : {}) });
        await load();
      },
    });
  }

  async function cancel(r) {
    const ok = await confirmDialog({ title: t('teams.slots.cancelTitle'), body: t('teams.slots.cancelBody', { bench: r.bench, slot: fmtSlot(r) }), confirmLabel: t('teams.slots.cancel'), danger: true });
    if (ok && await call('DELETE', `/api/benches/reservations/${encodeURIComponent(r.id)}`)) await load();
  }

  function render() {
    select.replaceChildren(...benchNames.map((n) => h('option', { value: n, selected: n === bench }, n)));
    select.setAttribute('aria-label', t('teams.calendar.bench'));
    today.textContent = t('teams.calendar.thisWeek');
    prev.title = t('teams.calendar.previous');
    prev.setAttribute('aria-label', prev.title);
    next.title = t('teams.calendar.next');
    next.setAttribute('aria-label', next.title);
    const sunday = new Date(monday.getTime() + 6 * DAY);
    title.textContent = t('teams.calendar.week', { from: fmtDay(monday), to: fmtDay(sunday) });
    note.textContent = t('teams.calendar.hint');

    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
    const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);
    const now = Date.now();
    const myTeamId = teams?.mine?.id;

    const head = h('div.cal-row.cal-head', h('div.cal-corner'), days.map((d) => h('div.cal-day', { role: 'columnheader' }, fmtDay(d))));
    const columns = days.map((d) => {
      const dayStart = d.getTime() + FIRST_HOUR * 3_600_000;
      const dayEnd = d.getTime() + LAST_HOUR * 3_600_000;
      const cells = hours.map((hour) => {
        const at = d.getTime() + hour * 3_600_000;
        const past = at + 3_600_000 <= now;
        return h('button.cal-cell', { type: 'button', disabled: past, dataset: { hour: String(hour) }, title: `${fmtDay(d)} ${String(hour).padStart(2, '0')}:00`, onclick: () => book(d, hour) });
      });
      const blocks = reservations.filter((r) => Date.parse(r.end) > dayStart && Date.parse(r.start) < dayEnd).map((r) => {
        const top = (Math.max(Date.parse(r.start), dayStart) - dayStart) / (dayEnd - dayStart) * 100;
        const bottom = (Math.min(Date.parse(r.end), dayEnd) - dayStart) / (dayEnd - dayStart) * 100;
        const mine = r.teamId === myTeamId;
        const canCancel = mine || session.isAdmin;
        const block = h(`${canCancel ? 'button' : 'div'}.cal-slot`, {
          type: canCancel ? 'button' : undefined,
          dataset: { mine: String(mine), team: r.teamId },
          title: `${r.teamName ?? '?'} · ${fmtTime(r.start)}–${fmtTime(r.end)}`,
          onclick: canCancel ? () => cancel(r) : undefined,
        }, h('strong', r.teamName ?? '?'), h('span', `${fmtTime(r.start)}–${fmtTime(r.end)}`));
        block.style.top = `${top}%`;
        block.style.height = `${bottom - top}%`;
        return block;
      });
      return h('div.cal-col', { role: 'gridcell' }, cells, blocks);
    });
    const times = h('div.cal-times', hours.map((hour) => h('div.cal-time', new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(2026, 0, 1, hour)))));
    grid.replaceChildren(head, h('div.cal-row.cal-body', times, columns));
  }

  return {
    async show([name] = []) {
      visible = true;
      if (name) bench = name;
      await myTeam();
      await load();
    },
    hide() { visible = false; },
  };
}
