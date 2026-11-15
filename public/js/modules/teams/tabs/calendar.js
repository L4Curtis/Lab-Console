/**
 * Reservations (#/team/calendar[/<bench>]): one bench, one week, 08:00 to
 * 20:00. From 720 px a week grid; on a phone one day at a time, as an
 * agenda (docs/v2/UX.md §10.4). A free hour books a slot for my team (admins
 * choose the team); a slot of my team (any slot, for admins) cancels it. The
 * server checks the overlaps and the limits; its refusal is shown in the dialog
 */
import { h, icon, prefs } from '../../../core/dom.js';
import { getJson, live, request, callOrToast } from '../../../core/api.js';
import { t, getLocale, onLocaleChange } from '../../../core/i18n.js';
import { session } from '../../../core/session.js';
import { confirmDialog, formDialog } from '../../../shared/dialog.js';
import { openMenu } from '../../../shared/menu.js';
import { emptyState } from '../../../shared/loadState.js';
import { fmtSlot, isOccupant } from '../data.js';
import { fmtDay, fmtTime } from '../../../core/format.js';

const FIRST_HOUR = 8;
const LAST_HOUR = 20;
const DAY = 24 * 3_600_000;
const SWIPE_PX = 60;

/** The local time `hour`:00 of the day that starts at `day` (setHours, not an addition: days of 23 or 25 hours exist) */
function atHour(day, hour) {
  const d = new Date(day);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 (local time) of the week that contains `date` */
function weekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const hh = (hour) => `${String(hour).padStart(2, '0')}:00`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function mount(el, { header, navigate }) {
  let benchNames = [];
  let bench = null;
  let monday = weekStart(new Date());
  let dayIndex = (new Date().getDay() + 6) % 7; // the agenda's day: 0 = Monday
  let reservations = [];
  let limits = null;
  let teams = null;
  let visible = false;

  const picker = h('button.btn.sm.cal-picker', { type: 'button', dataset: { action: 'pick' }, 'aria-haspopup': 'menu', onclick: () => pickBench() });
  const title = h('strong.cal-week');
  const prev = h('button.icon-btn', { type: 'button', dataset: { action: 'previous' }, onclick: () => move(-7) }, icon('chevronLeft'));
  const today = h('button.btn.sm', { type: 'button', dataset: { action: 'today' }, onclick: () => { monday = weekStart(new Date()); dayIndex = (new Date().getDay() + 6) % 7; load(); } });
  const next = h('button.icon-btn', { type: 'button', dataset: { action: 'next' }, onclick: () => move(7) }, icon('chevronRight'));
  const note = h('p.card-meta.cal-note');
  const grid = h('div.cal-grid', { role: 'grid' });
  const agenda = h('div.cal-agenda');
  const outside = h('div.cal-outside');
  el.append(h('div.cal-panel',
    h('div.cal-toolbar', picker, h('span.cal-nav', prev, today, next), title),
    note, h('div.cal-scroll', grid), agenda, outside));

  function move(days) {
    monday = new Date(monday.getTime() + days * DAY);
    monday = weekStart(new Date(monday.getTime() + 12 * 3_600_000)); // daylight saving changes stay on Monday
    load();
  }

  async function pickBench() {
    const items = benchNames.map((n) => ({ id: n, label: n, checked: n === bench }));
    const id = await openMenu(picker, items, { label: t('teams.calendar.bench') });
    if (id && id !== bench) { bench = id; navigate?.(`#/team/calendar/${encodeURIComponent(bench)}`); load(); }
  }

  async function load() {
    if (!benchNames.length) {
      const data = await callOrToast('GET', '/api/benches', undefined, { quiet: true });
      benchNames = (data?.benches ?? []).map((b) => b.bench);
      // The bench of the address; else the one my team works on, the one I used last, the first
      const mine = (data?.benches ?? []).find((b) => isOccupant(b))?.bench;
      if (!bench || !benchNames.includes(bench)) bench = mine ?? benchNames.find((n) => n === prefs.get('lab')) ?? benchNames[0] ?? null;
    }
    if (!bench) { render(); return; }
    const from = monday.toISOString();
    const nextMonday = new Date(monday);
    nextMonday.setDate(nextMonday.getDate() + 7);
    const to = nextMonday.toISOString();
    const data = await callOrToast('GET', `/api/benches/reservations?bench=${encodeURIComponent(bench)}&from=${from}&to=${to}`);
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
    // 24 h starts, every half hour, that are still to come and not inside another booking
    const starts = [];
    for (let m = FIRST_HOUR * 60; m < LAST_HOUR * 60; m += 30) {
      const clock = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const at = new Date(day);
      at.setHours(Math.floor(m / 60), m % 60, 0, 0);
      const taken = reservations.some((r) => Date.parse(r.start) <= at.getTime() && at.getTime() < Date.parse(r.end));
      if (!taken && (session.isAdmin || at.getTime() >= Date.now())) starts.push({ value: clock, label: clock });
    }
    if (!starts.some((x) => x.value === hh(hour))) starts.unshift({ value: hh(hour), label: hh(hour) });
    const fields = [
      { name: 'time', label: t('teams.calendar.start'), type: 'select', options: starts, value: hh(hour), required: true },
      { name: 'minutes', label: t('teams.calendar.length'), type: 'select', options: durations, value: 120 },
    ];
    if (session.isAdmin) fields.push({ name: 'teamId', label: t('teams.calendar.team'), type: 'select', options: (info?.teams ?? []).map((x) => ({ value: x.id, label: x.name })), value: info?.mine?.id });
    await formDialog({
      title: t('teams.calendar.bookTitle', { bench, day: fmtDay(start) }),
      intro: limits && !session.isAdmin ? t('teams.calendar.limits', { max: limits.maxFuture, hours: limits.maxHours }) : undefined,
      fields,
      submitLabel: t('teams.calendar.book'),
      onSubmit: async ({ time, minutes, teamId }) => {
        const [h1, m1] = String(time).split(':').map(Number);
        const s = new Date(day);
        s.setHours(h1, m1, 0, 0);
        const e = new Date(s.getTime() + Number(minutes) * 60_000);
        await request('POST', '/api/benches/reservations', { bench, start: s.toISOString(), end: e.toISOString(), ...(teamId ? { teamId } : {}) });
        await load();
      },
    });
  }

  async function cancel(r) {
    const ok = await confirmDialog({ title: t('teams.slots.cancelTitle'), body: t('teams.slots.cancelBody', { bench: r.bench, slot: fmtSlot(r) }), confirmLabel: t('teams.slots.cancel'), danger: true });
    if (ok && await callOrToast('DELETE', `/api/benches/reservations/${encodeURIComponent(r.id)}`)) await load();
  }

  const weekDays = () => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });

  function render() {
    if (visible) header.update({ context: () => (bench ? t('teams.calendar.context', { bench }) : ''), primary: null, actions: [] });
    picker.replaceChildren(icon('rack'), bench ? t('teams.calendar.picker', { bench }) : t('teams.calendar.bench'), icon('chevronDown'));
    today.textContent = t('teams.calendar.thisWeek');
    prev.title = t('teams.calendar.previous');
    prev.setAttribute('aria-label', prev.title);
    next.title = t('teams.calendar.next');
    next.setAttribute('aria-label', next.title);
    const days = weekDays();
    title.textContent = t('teams.calendar.week', { from: fmtDay(days[0]), to: fmtDay(days[6]) });
    note.textContent = t('teams.calendar.hint');
    if (!bench) {
      grid.replaceChildren(emptyState({ icon: 'rack', title: 'teams.calendar.noBench' }));
      agenda.replaceChildren();
      outside.replaceChildren();
      return;
    }
    const myTeamId = teams?.mine?.id;
    renderGrid(days, myTeamId);
    renderAgenda(days, myTeamId);
    renderOutside(days, myTeamId);
  }

  /** From 720 px: the week */
  function renderGrid(days, myTeamId) {
    const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);
    const now = Date.now();
    const head = h('div.cal-row.cal-head', h('div.cal-corner'), days.map((d) => h(`div.cal-day${sameDay(d, new Date()) ? '.today' : ''}`, { role: 'columnheader' }, fmtDay(d))));
    const columns = days.map((d) => {
      const dayStart = atHour(d, FIRST_HOUR);
      const dayEnd = atHour(d, LAST_HOUR);
      const cells = hours.map((hour) => {
        const past = atHour(d, hour + 1) <= now;
        const label = t('teams.calendar.bookHover', { from: hh(hour), to: hh(hour + 1) });
        return h('button.cal-cell', { type: 'button', disabled: past, dataset: { hour: String(hour), label }, 'aria-label': `${fmtDay(d)} ${label}`, onclick: () => book(d, hour) });
      });
      const blocks = reservations.filter((r) => Date.parse(r.end) > dayStart && Date.parse(r.start) < dayEnd).map((r) => {
        const top = (Math.max(Date.parse(r.start), dayStart) - dayStart) / (dayEnd - dayStart) * 100;
        const bottom = (Math.min(Date.parse(r.end), dayEnd) - dayStart) / (dayEnd - dayStart) * 100;
        const mine = r.teamId === myTeamId;
        const canCancel = mine || session.isAdmin;
        const block = h(`${canCancel ? 'button' : 'div'}.cal-slot`, {
          type: canCancel ? 'button' : undefined,
          dataset: { mine: String(mine), team: r.teamId },
          title: `${r.teamName ?? '?'} · ${fmtTime(r.start)}–${fmtTime(r.end)}${canCancel ? ` · ${t('teams.slots.cancel')}` : ''}`,
          onclick: canCancel ? () => cancel(r) : undefined,
        }, h('strong', r.teamName ?? '?'), h('span', `${fmtTime(r.start)}–${fmtTime(r.end)}`));
        block.style.top = `${top}%`;
        block.style.height = `${bottom - top}%`;
        return block;
      });
      return h('div.cal-col', { role: 'gridcell' }, cells, blocks);
    });
    const times = h('div.cal-times', hours.map((hour) => h('div.cal-time', fmtTime(new Date(2026, 0, 1, hour)))));
    grid.replaceChildren(head, h('div.cal-row.cal-body', times, columns));
  }

  /** On a phone: a row of days, then the hours of the chosen one */
  function renderAgenda(days, myTeamId) {
    const now = Date.now();
    const intl = new Intl.DateTimeFormat(getLocale(), { weekday: 'short' });
    const chosen = days[dayIndex];
    const chips = h('div.cal-days.chips', { role: 'group', 'aria-label': t('teams.calendar.days') }, days.map((d, i) => {
      const past = atHour(d, LAST_HOUR) <= now;
      const isToday = sameDay(d, new Date());
      return h('button.chip.cal-day-chip', {
        type: 'button', 'aria-pressed': String(i === dayIndex), dataset: { day: String(i), today: String(isToday), past: String(past) },
        'aria-label': fmtDay(d), onclick: () => { dayIndex = i; render(); },
      }, h('span.cal-dow', intl.format(d)), h('span.cal-dom', String(d.getDate())));
    }));
    const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);
    const rows = [];
    let gone = null; // the hours already over with nothing booked in them: one line, not a screen of "Passé"
    const closeGone = () => {
      if (!gone) return;
      rows.push(h('li.cal-hour.cal-hour-past', { dataset: { hour: String(gone.first) } },
        h('time.cal-hour-label', hh(gone.first)), h('div.cal-past', t('teams.calendar.pastUntil', { time: hh(gone.last + 1) }))));
      gone = null;
    };
    for (const hour of hours) {
      const from = atHour(chosen, hour);
      const to = atHour(chosen, hour + 1);
      const past = to <= now;
      const r = reservations.find((x) => Date.parse(x.end) > from && Date.parse(x.start) < to);
      if (past && !r) {
        gone = gone ? { ...gone, last: hour } : { first: hour, last: hour };
        continue;
      }
      closeGone();
      let content;
      if (r) {
        const mine = r.teamId === myTeamId;
        const canCancel = mine || session.isAdmin;
        const label = mine ? t('teams.calendar.yourTeam') : r.teamName ?? '?';
        content = canCancel
          ? h('button.cal-booked', { type: 'button', dataset: { mine: String(mine), team: r.teamId }, onclick: () => cancel(r) },
            h('span.cal-booked-text', h('strong', label), h('span.card-meta', `${fmtTime(r.start)}–${fmtTime(r.end)}`)), h('span.cal-act', t('teams.slots.cancel')))
          : h('div.cal-booked', { dataset: { mine: 'false', team: r.teamId } }, h('span.cal-booked-text', h('strong', label), h('span.card-meta', `${fmtTime(r.start)}–${fmtTime(r.end)}`)));
      } else if (from <= now && !session.isAdmin) {
        // The hour in progress: the server refuses a slot that has begun, so it is not offered
        content = h('div.cal-now', t('teams.calendar.now'));
      } else {
        content = h('button.cal-free', { type: 'button', dataset: { hour: String(hour) }, onclick: () => book(chosen, hour) }, h('span', t('teams.calendar.free')), h('span.cal-act', t('teams.calendar.book')));
      }
      rows.push(h('li.cal-hour', { dataset: { hour: String(hour) } }, h('time.cal-hour-label', hh(hour)), content));
    }
    closeGone();
    const hoursList = h('ol.cal-hours', { 'aria-label': fmtDay(chosen) }, rows);
    // A swipe changes the day (past the ends: the next or the previous week)
    let startX = null;
    let startY = null;
    hoursList.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
    hoursList.addEventListener('touchend', (e) => {
      if (startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      startX = null;
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dy) > Math.abs(dx) / 2) return;
      step(dx < 0 ? 1 : -1);
    }, { passive: true });
    agenda.replaceChildren(chips, h('p.cal-day-title', h('strong', fmtDay(chosen))), hoursList);
  }

  function step(by) {
    const to = dayIndex + by;
    if (to >= 0 && to <= 6) { dayIndex = to; render(); return; }
    dayIndex = to < 0 ? 6 : 0;
    move(to < 0 ? -7 : 7);
  }

  /** The grid shows 08:00 to 20:00 only: a booking that does not fit in it is listed below, so the week never looks free when it is not */
  function renderOutside(days, myTeamId) {
    const fits = (r) => days.some((d) => Date.parse(r.start) >= atHour(d, FIRST_HOUR) && Date.parse(r.end) <= atHour(d, LAST_HOUR));
    const rest = reservations.filter((r) => !fits(r));
    if (!rest.length) { outside.replaceChildren(); return; }
    outside.replaceChildren(
      h('p.card-meta.cal-note', t('teams.calendar.outside', { from: hh(FIRST_HOUR), to: hh(LAST_HOUR) })),
      h('ul.cal-outside-list', rest.map((r) => {
        const canCancel = r.teamId === myTeamId || session.isAdmin;
        return h('li', { dataset: { team: r.teamId } },
          h('strong', r.teamName ?? '?'), ' ', h('span', fmtSlot(r)),
          canCancel ? h('button.icon-btn', { type: 'button', title: t('teams.slots.cancel'), 'aria-label': t('teams.slots.cancel'), onclick: () => cancel(r) }, icon('close')) : null);
      })));
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
