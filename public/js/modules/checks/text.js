/**
 * What the bench checks say, in the user's language: line states, cabling
 * verdicts and their reasons, interface states, steps, codes of the server
 */
import { t, has, getLocale } from '../../core/i18n.js';
import { codeText } from '../jobs/text.js';

export { codeText };

export const kindText = (kind) => (has(`checks.kind.${kind}`) ? t(`checks.kind.${kind}`) : kind);
export const stateText = (state) => (has(`checks.state.${state}`) ? t(`checks.state.${state}`) : state);
export const lineText = (line) => (has(`checks.line.${line}`) ? t(`checks.line.${line}`) : line);
export const screenText = (screen) => (screen && has(`checks.screen.${screen}`) ? t(`checks.screen.${screen}`) : screen ?? '');

/** A progress step: the server says 'checks.steps.<name>' */
export function stepText(step, params = {}) {
  if (!step) return '';
  const name = String(step).split('.').pop();
  return has(`checks.steps.${name}`) ? t(`checks.steps.${name}`, params) : step;
}

/** "Fa0/5" for "FastEthernet0/5" (what fits on a diagram) */
export function shortPort(name) {
  const s = String(name ?? '');
  const m = s.match(/^([A-Za-z-]+?)(\d.*)$/);
  if (!m) return s;
  const SHORT = { fastethernet: 'Fa', gigabitethernet: 'Gi', tengigabitethernet: 'Te', ethernet: 'Et', serial: 'Se', loopback: 'Lo', vlan: 'Vl', 'port-channel': 'Po', tunnel: 'Tu' };
  return `${SHORT[m[1].toLowerCase()] ?? m[1]}${m[2]}`;
}

/** An interface's state: up, down, shut */
export function ifStateText(i) {
  if (!i?.status) return '';
  if (i.status === 'administratively down') return t('checks.interfaces.shut');
  if (i.status === 'up' && i.protocol === 'up') return t('checks.interfaces.up');
  if (i.status === 'up') return t('checks.interfaces.protocolDown');
  return t('checks.interfaces.down');
}

const endText = (e) => (e.port ? `${e.name} ${shortPort(e.port)}` : e.name);

/** One cabling verdict as a sentence */
export function linkText(l) {
  const params = { a: endText(l.a), b: endText(l.b), seenA: l.a.seen ? shortPort(l.a.seen) : '?', seenB: l.b.seen ? shortPort(l.b.seen) : '?' };
  const base = t(`checks.cabling.line.${l.status}`, params);
  const why = l.reason ? reasonText(l.reason) : '';
  return why ? `${base} (${why})` : base;
}

export function reasonText(reason) {
  if (!reason?.code) return '';
  const p = { ...reason.params };
  if (p.port) p.port = shortPort(p.port);
  return has(`checks.cabling.reason.${reason.code}`) ? t(`checks.cabling.reason.${reason.code}`, p) : reason.code;
}

export function timeText(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

/** "à 10:42" today, "le 12 nov. à 10:42" another day */
export function ageText(value) {
  if (!value) return '';
  const d = new Date(value);
  const today = new Date().toDateString() === d.toDateString();
  if (today) return t('checks.at', { time: timeText(value) });
  return t('checks.atDay', { day: new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short' }).format(d), time: timeText(value) });
}
