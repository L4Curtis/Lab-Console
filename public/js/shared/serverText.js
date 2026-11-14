/**
 * Messages the server sends over a console WebSocket (refusals, status lines,
 * automation progress and results). Each carries its English sentence in
 * `message` and a stable `code` with `params`; the browser shows the
 * translation of the code, or the English sentence when the code is unknown
 * (for example a message produced by the Proxmox module)
 *
 *   { type: 'error', message: "R1's console address is not…", code: 'consoles.not_allowed', params: { name: 'R1' } }
 *     → t('terminal.server.consoles.not_allowed', { name: 'R1' })
 *
 * A summary made of several sentences carries them as `parts`
 * ([{ code, params }]); they are joined with ". "
 */
import { t, has } from '../core/i18n.js';

const PREFIX = 'terminal.server.';

function one({ code, params, message }) {
  return code && has(PREFIX + code) ? t(PREFIX + code, params) : message;
}

export function serverText(msg) {
  if (!msg) return '';
  if (Array.isArray(msg.parts) && msg.parts.length) return msg.parts.map(one).join('. ');
  return one(msg);
}

/** An API error thrown by core/api.js (status, code, params, serverMessage), in the user's language */
export function errorText(err) {
  return serverText({ code: err?.code, params: err?.params ?? {}, message: err?.serverMessage ?? err?.message ?? '' });
}

/**
 * A task's name as people read it: 'inject' → "injection". The server names its
 * tasks with a short identifier (export, inject, paste, broadcast, a job's); one
 * without an entry in terminal.taskNames is shown as it is
 */
export function taskName(label) {
  const key = `terminal.taskNames.${label}`;
  return has(key) ? t(key) : String(label ?? '');
}
