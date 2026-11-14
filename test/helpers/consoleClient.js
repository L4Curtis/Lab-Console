/**
 * Test helper: a person's console WebSocket on a real application, with what
 * it received kept for the assertions
 *
 *   const c = connectConsole(app, 'student1', device);          // device: a registry device ({ key, name, target })
 *   const c = await openReady(app, 'student1', device);         // login answered, at the device's prompt
 *   c.type('show clock\r'); await c.see(/R1>show clock/);
 *   c.send({ type: 'paste', script }); await c.frame((f) => f.type === 'automation' && f.state === 'done', 'done');
 *   c.frames, c.text (bytes shown, as latin1), c.close()
 */
import WebSocket from 'ws';

export async function until(fn, what, ms = 6000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function connectConsole(app, who, device, extra = '') {
  const ws = new WebSocket(`${app.wsUrl}/ws/console?device=${encodeURIComponent(device.key)}&cols=80&rows=24${extra}`, { headers: { origin: app.url, ...app.as(who) } });
  const c = { ws, who, device, frames: [], text: '', closed: false };
  ws.on('message', (raw, isBinary) => { if (isBinary) c.text += raw.toString('latin1'); else c.frames.push(JSON.parse(raw.toString())); });
  ws.on('close', () => { c.closed = true; });
  c.send = (msg) => ws.send(JSON.stringify(msg));
  c.type = (data) => c.send({ type: 'input', data });
  c.until = (fn, what, ms = 6000) => until(() => fn(c), `${typeof who === 'string' ? who : who.id}: ${what}`, ms);
  c.see = (re, ms) => c.until((x) => re.test(x.text), `screen ${re}`, ms);
  c.frame = async (pred, what, ms) => { await c.until((x) => x.frames.some(pred), what, ms); return c.frames.filter(pred).at(-1); };
  /** The last automation frame of a task (and batch) in the given states */
  c.outcome = (task, states = ['done', 'warning', 'error', 'cancelled'], batch) => c.frame(
    (f) => f.type === 'automation' && f.task === task && states.includes(f.state) && (batch === undefined || f.batch === batch),
    `${task} finished`, 15_000);
  c.close = () => new Promise((r) => { if (c.closed) return r(); ws.once('close', r); ws.close(); });
  return c;
}

/** Open the console and get past the console server's login, to the device's prompt */
export async function openReady(app, who, device) {
  const c = connectConsole(app, who, device);
  await c.see(/Password: /);
  await c.until((x) => x.frames.some((f) => f.type === 'status' && f.phase === 'login'), 'auto-login');
  c.type('\r');
  await c.see(new RegExp(`${device.name}>$`));
  return c;
}
