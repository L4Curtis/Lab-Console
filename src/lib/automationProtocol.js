/**
 * WebSocket glue between a console tile and its CliAutomation (shared by lab /
 * admin-switch consoles and Proxmox serial consoles)
 *
 *   browser → server   {"type":"export-config"}
 *                      {"type":"inject","script":"…","options":{waitForPrompt,delayMs,stopOnError,skipComments}}
 *                      {"type":"paste","script":"…","options":{…}}       a multi-line paste, paced like an injection;
 *                                                                        every line is sent as typed (comments included)
 *                      {"type":"broadcast","batch":"…","script":"…","options":{…}}   the same lines sent to several
 *                                                                        consoles: the browser sends this frame on each of
 *                                                                        its console sockets, each room decides for itself
 *                      {"type":"automation-cancel"}
 *   server → browser   {"type":"automation","task","state":"running|done|warning|error|cancelled","message","code","params","parts","done","total","result","batch"?}
 *                      `message` is the English sentence; `code` and `params` (and, for a summary made of
 *                      several sentences, `parts`: a list of { code, params }) let the browser translate it
 *                      {"type":"export-result","filename","content"}
 *
 * Who runs the task: by default the handler takes the keyboard itself
 * (`cli.perform`). A shared console passes `run(label, fn)` instead (its
 * room's runExclusive: the pilot is asked, spectators are refused) and
 * `report` to show the progress to everyone on the console; the exported
 * file only goes back to the person who asked (`send`). An error carrying a
 * `code` (a refusal of the room) is reported with that code
 *
 * `paste` and `broadcast` exist only where the caller passes `permit.paste` /
 * `permit.broadcast`: a function that answers null when the person may, or
 * { message, code, params } when they may not (a refusal is sent to that
 * person alone, before anything is typed). A frame of a task the console does
 * not offer is not handled (the Proxmox serial console has neither)
 */
export const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_SCRIPT_LINES = 5000;
const MAX_BROADCAST_LINES = 50;
const TASKS = { 'export-config': 'export', inject: 'inject', paste: 'paste', broadcast: 'broadcast' };

export function createAutomationHandler({
  cli, send, canExport, log, label,
  run = (task, fn) => cli.perform(task, fn),
  cancel = () => cli.cancel(),
  busy = () => cli.running,
  report: broadcast = send,
  permit = {},
}) {
  return function handle(msg) {
    if (msg.type === 'automation-cancel') { cancel(); return true; }
    const task = Object.hasOwn(TASKS, msg.type) ? TASKS[msg.type] : null;
    if (!task || (permit[task] === undefined && (task === 'paste' || task === 'broadcast'))) return false;

    // A broadcast tags its frames, so that the browser tells its own batch from another person's on the same console
    const batch = typeof msg.batch === 'string' && /^[\w-]{1,40}$/.test(msg.batch) ? { batch: msg.batch } : {};
    const report = (state, message, extra = {}) => broadcast({ type: 'automation', task, state, message, ...extra, ...batch });
    const refuse = (message, code, params = {}) => (send({ type: 'automation', task, state: 'error', message, code, params, ...batch }), true);
    if (busy()) return refuse('Another task is still running on this console.', 'automation.busy');
    const verdict = permit[task]?.();
    if (verdict) return refuse(verdict.message, verdict.code, verdict.params);
    if (task === 'export' && !canExport) return refuse('Config export is available on Cisco console devices only.', 'automation.export_unsupported');

    let done;
    if (task === 'export') {
      done = run('export', (c) => c.readRunningConfig((message, p = {}) => report('running', message, p))).then(({ hostname, config, pagingFallback }) => {
        send({ type: 'export-result', filename: exportFilename(hostname), content: config });
        const lines = config.split('\n').length - 1;
        report('done', `Exported ${lines} lines of ${hostname}'s running-config${pagingFallback ? ' (paging could not be disabled; --More-- pages were skipped through)' : ''}`,
          { code: pagingFallback ? 'automation.exported_paging' : 'automation.exported', params: { count: lines, hostname } });
        log.info(`${label}: exported running-config of ${hostname} (${lines} lines)`);
      });
    } else {
      const script = typeof msg.script === 'string' ? msg.script : '';
      if (!script.trim()) return refuse('The script is empty.', 'automation.script_empty');
      if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) return refuse('The script is larger than 256 KB.', 'automation.script_too_large');
      const maxLines = task === 'broadcast' ? MAX_BROADCAST_LINES : MAX_SCRIPT_LINES;
      if (script.split('\n').length > maxLines) return refuse(`The script has more than ${maxLines} lines.`, 'automation.script_too_long', { max: maxLines });
      const o = msg.options || {};
      const options = {
        waitForPrompt: o.waitForPrompt !== false,
        delayMs: clamp(o.delayMs, 0, 5000, 50),
        stopOnError: Boolean(o.stopOnError),
        // A paste is what the person copied, "!" lines included (a banner's text may start with one)
        skipComments: task === 'paste' ? false : o.skipComments !== false,
      };
      done = run(task, (c) => c.sendScript(script, options, (message, p = {}) => report('running', message, p))).then((result) => {
        const { sent, total, errors, slow } = result;
        const parts = [`Sent ${sent} of ${total} lines`];
        const coded = [{ code: 'automation.sent', params: { sent, total, count: total } }];
        if (errors.length) {
          const lineList = errors.map((e) => e.line).join(', ');
          parts.push(`${errors.length} device error${errors.length > 1 ? 's' : ''} (line ${lineList})`);
          coded.push({ code: 'automation.device_errors', params: { count: errors.length, lines: lineList } });
        }
        if (slow.length) {
          parts.push(`no prompt after line ${slow.join(', ')}`);
          coded.push({ code: 'automation.no_prompt_after', params: { lines: slow.join(', '), count: slow.length } });
        }
        if (result.stoppedOnError) {
          parts.push('stopped at the first error');
          coded.push({ code: 'automation.stopped_on_error', params: {} });
        }
        if (result.waitingFor) {
          parts.push(`the device is waiting for an answer: "${result.waitingFor}"`);
          coded.push({ code: 'automation.waiting_for', params: { question: result.waitingFor } });
        }
        report(errors.length || result.waitingFor ? 'warning' : 'done', parts.join('. '), { result, parts: coded });
        log.info(`${label}: injected ${sent}/${total} lines, ${errors.length} errors`);
      });
    }
    done.catch((err) => {
      const coded = err.code ? { code: err.code, params: err.params ?? {} } : {};
      // The console said no before anything ran (control refused, a spectator): only the asker hears it
      if (!err.cancelled && String(err.code).startsWith('consoles.')) return send({ type: 'automation', task, state: 'error', message: err.message, ...coded, ...batch });
      report(err.cancelled ? 'cancelled' : 'error', err.cancelled ? 'Stopped' : err.message, coded);
    });
    return true;
  };
}

function exportFilename(hostname) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  return `${hostname.replace(/[^\w.-]/g, '_')}_running-config_${stamp}.txt`;
}

const clamp = (v, min, max, fallback) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback);
