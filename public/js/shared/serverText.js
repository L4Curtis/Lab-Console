/**
 * Messages the server sends over a console WebSocket (refusals, status lines,
 * automation progress and results). Each carries its English sentence in
 * `message` and a stable `code` with `params`; the browser shows the
 * translation of the code, or the English sentence when the code is unknown
 * (for example a message produced by the Proxmox module)
 *
 *   { type: 'error', message: "R1's console is already in use…", code: 'consoles.line_busy', params: { name: 'R1' } }
 *     → t('terminal.server.consoles.line_busy', { name: 'R1' })
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
  if (Array.isArray(msg.parts) && msg.parts.length) return msg.parts.map(one).join('. ');
  return one(msg);
}
