/**
 * Browser notifications (SPEC "Lot collab"): the system notification of three
 * things you would miss while looking at another window
 *
 *   - someone asks for the keyboard of a console you pilot   (SSE consoles:activity + consoles:rooms)
 *   - a line you waited for is free or can be joined           (SSE consoles:free, state free | open)
 *   - a job finished on your bench                             (SSE jobs:done { bench, jobId, kind, ok })
 *
 * Nothing new travels from the server: these are events the page already
 * receives, turned into notifications. They are shown only when this window
 * is not the one being looked at (hidden tab, other window): the page itself
 * already says it when it is in front. Each person turns them on with the
 * bell in the rail, which is also where the browser's permission is asked
 * (a browser only accepts that after a click); the choice stays in this
 * browser. Without the Notification API, or when permission was refused,
 * the bell says so and does nothing
 */
import { h, icon, toast, prefs } from '../../core/dom.js';
import { live } from '../../core/api.js';
import { t, has, onLocaleChange } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { benchSummary, isOccupant } from '../teams/data.js';

const PREF = 'notifications';

const supported = () => typeof Notification !== 'undefined';
const permission = () => (supported() ? Notification.permission : 'denied');
const isOn = () => supported() && permission() === 'granted' && prefs.get(PREF, false) === true;
const away = () => document.visibilityState === 'hidden' || !document.hasFocus();

/** Show a notification when the person asked for them and is looking elsewhere. → whether one was shown */
export function notify({ title, body, tag, href }, { force = false } = {}) {
  if (!isOn() || (!force && !away())) return false;
  try {
    const n = new Notification(title, { body, tag, icon: '/favicon.svg' });
    n.onclick = () => {
      window.focus();
      if (href) location.hash = href;
      n.close();
    };
    return true;
  } catch {
    return false; // some platforms only allow them from a service worker
  }
}

const benchHref = (bench) => `#/consoles/${encodeURIComponent(bench)}`;
const kindName = (kind) => (has(`collab.jobKinds.${kind}`) ? t(`collab.jobKinds.${kind}`) : String(kind ?? ''));

export function startNotifications() {
  const me = () => session.user?.id;
  let rooms = new Map(); // line → room summary

  // ── The bell ──────────────────────────────────────────────────────────────
  const label = h('span');
  const bell = h('button.rail-btn#notify-toggle', { type: 'button', onclick: toggle }, icon('bell'), label);
  document.getElementById('theme-toggle')?.before(bell);

  function render() {
    const state = !supported() ? 'unsupported' : permission() === 'denied' ? 'denied' : isOn() ? 'on' : 'off';
    bell.dataset.state = state;
    bell.disabled = state === 'unsupported' || state === 'denied';
    bell.setAttribute('aria-pressed', String(state === 'on'));
    label.textContent = t('collab.notify.rail');
    bell.title = t(`collab.notify.state.${state}`);
  }

  async function toggle() {
    if (isOn()) {
      prefs.set(PREF, false);
      render();
      return;
    }
    let answer = permission();
    if (answer === 'default') answer = await Notification.requestPermission();
    if (answer !== 'granted') {
      toast(t('collab.notify.refused'), 'warn', 8000);
      render();
      return;
    }
    prefs.set(PREF, true);
    render();
    // Proof that it works, and what the notifications look like
    if (!notify({ title: t('collab.notify.testTitle'), body: t('collab.notify.testBody'), tag: 'collab:test' }, { force: true })) toast(t('collab.notify.on'));
  }
  render();
  onLocaleChange(render);

  // ── The three events ──────────────────────────────────────────────────────
  live.on('consoles:rooms', (list) => { rooms = new Map(list.map((r) => [r.target, r])); });

  // A request for the keyboard of a line I pilot (a person's, or a task's)
  live.on('consoles:activity', (e) => {
    if (e.kind !== 'control' || e.event !== 'request') return;
    if (rooms.get(e.target)?.pilot?.id !== me() || e.user?.id === me()) return;
    notify({
      title: t('collab.notify.control.title', { device: e.device }),
      body: t('collab.notify.control.body', { name: e.user?.name ?? '', device: e.device, bench: e.bench }),
      tag: `control:${e.target}`,
      href: benchHref(e.bench),
    });
  });

  // "Tell me when it is free", answered
  // 'free': nobody holds the line any more; 'open': someone opened it in the app, it can be joined.
  // 'expired' (30 minutes without an answer) is not good news: the page says it, no notification
  live.on('consoles:free', (n) => {
    if (n.state !== 'free' && n.state !== 'open') return;
    notify({
      title: t(`collab.notify.${n.state}.title`, { device: n.device }),
      body: t(`collab.notify.${n.state}.body`, { device: n.device, bench: n.bench }),
      tag: `free:${n.target}`,
      href: benchHref(n.bench),
    });
  });

  // A job of my bench is over (the jobs lot publishes it to the bench's occupants; checked again here)
  live.on('jobs:done', (job) => {
    if (!job || !isOccupant(benchSummary(job.bench))) return;
    notify({
      title: t(job.ok ? 'collab.notify.job.titleOk' : 'collab.notify.job.titleFailed', { bench: job.bench }),
      body: t(job.ok ? 'collab.notify.job.bodyOk' : 'collab.notify.job.bodyFailed', { kind: kindName(job.kind), bench: job.bench }),
      tag: `job:${job.jobId}`,
      href: benchHref(job.bench),
    });
  });
}
