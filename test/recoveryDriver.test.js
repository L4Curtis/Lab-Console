/**
 * The password recovery procedures (src/lib/drivers/ciscoRecovery.js) on the
 * simulator, one family after the other: a router locked by a console line
 * password (ISR G1) or an enable secret (ISR 4331), the 1841 left at 0x2141,
 * classic Catalysts and the Catalyst 1000 with the Mode button and
 * flash_init, the Catalyst 9300L with SWITCH_IGNORE_STARTUP_CFG; then what
 * goes wrong: a BREAK too late, Mode released too early, recovery disabled,
 * the wrong family, a parked file already there, nobody power-cycling.
 * Every run checks that nothing erases or rewrites the startup-config.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CiscoRecovery, planFrom, FAMILIES, STEPS, PARKED_NAME, scaledRecoveryTimeouts } from '../src/lib/drivers/ciscoRecovery.js';
import { rig, FAST } from './helpers/ios.js';

export const RT = { ...FAST, powerOnMs: 2000, breakEveryMs: 40, breakWindowMs: 1500, bootLoaderMs: 3000, flashInitMs: 2000, monitorMs: 1500 };

/** Nothing a recovery types may erase, save or overwrite a configuration */
const DESTRUCTIVE = /\b(erase|delete|write|copy|format|reload)\b|\bfsck\b/;

/**
 * Run the assistant's steps on `dev` as the module does, the person
 * power-cycling the device (`mode`: holding Mode) when the step asks for it.
 * → { look, plan, results, typed }
 */
async function recover(r, family, { mode = false, person = true, screen = '' } = {}) {
  const rec = new CiscoRecovery(r.cli, { family, timeouts: RT });
  return r.cli.perform('recovery', async () => {
    const look = await rec.look({ screen });
    const plan = planFrom(family, look);
    const results = {};
    const facts = {};
    if (!Array.isArray(plan)) return { look, plan, results };
    for (const step of plan) {
      if (step === 'power_cycle' && person) setTimeout(() => r.dev.powerCycle({ modeButton: mode }), 30);
      const out = await rec.run(step, facts);
      results[step] = out;
      if (!out.ok) break;
      Object.assign(facts, out);
    }
    return { look, plan, results };
  });
}

const typedLines = (r) => r.written().replace(/<BREAK>/g, '').split('\r').map((l) => l.trim()).filter(Boolean);
const allOk = (results) => Object.entries(results).every(([, x]) => x.ok);

test('the families and their steps', () => {
  assert.deepEqual(Object.keys(FAMILIES), ['isr_g1', 'isr4300', 'catalyst', 'c1000', 'c9300l']);
  for (const f of Object.values(FAMILIES)) assert.ok(STEPS[f.method][0] === 'look');
  assert.equal(planFrom('nope', { state: 'user' }).reason, 'recovery.unknown_family');
  assert.deepEqual(planFrom('isr_g1', { state: 'password' }), ['power_cycle', 'confreg', 'boot', 'restore_register']);
  assert.deepEqual(planFrom('isr_g1', { state: 'rommon' }), ['confreg', 'boot', 'restore_register']);
  assert.deepEqual(planFrom('isr_g1', { state: 'dialog' }), ['boot', 'restore_register']);
  assert.deepEqual(planFrom('catalyst', { state: 'bootLoader' }), ['flash_init', 'park_config', 'boot', 'restore_config']);
  assert.deepEqual(planFrom('c9300l', { state: 'silent' }), ['power_cycle', 'ignore_startup', 'boot', 'restore_startup']);
  assert.equal(planFrom('catalyst', { state: 'rommon', line: 'rommon 1 >' }).reason, 'recovery.wrong_family');
  assert.equal(planFrom('isr4300', { state: 'bootLoader', line: 'switch:' }).reason, 'recovery.wrong_family');
  const t = scaledRecoveryTimeouts(0.01);
  assert.equal(t.breakWindowMs, 600);
  assert.equal(t.wakes, 3);
});

test('ISR G1 (2811) locked by a console line password: BREAK, confreg 0x2142, factory prompt, 0x2102 for the next boot', async () => {
  const r = rig({ model: '2811', start: 'linepass', linePassword: 'unknown-pw', hostname: 'R1-2001' });
  try {
    const { look, plan, results } = await recover(r, 'isr_g1');
    assert.equal(look.state, 'password');
    assert.deepEqual(plan, ['power_cycle', 'confreg', 'boot', 'restore_register']);
    assert.ok(allOk(results), JSON.stringify(results, null, 1));
    assert.ok(results.power_cycle.breaks >= 1);
    assert.equal(r.dev.breaks >= 1, true);
    assert.equal(results.boot.host, 'Router');
    assert.equal(results.restore_register.register, '0x2142');
    assert.equal(results.restore_register.next, '0x2102');
    // At a clean privileged prompt; the startup-config untouched, read again at the next boot
    assert.equal(r.dev.mode, '#');
    assert.equal(r.dev.cfg.hostname, 'Router');
    assert.equal(r.dev.confReg, '0x2142');
    assert.equal(r.dev.nextConfReg, '0x2102');
    assert.equal(r.dev.startup.hostname, 'R1-2001');
    assert.ok(r.dev.startup.blocks.find((b) => b.head === 'line con 0').lines.includes('password unknown-pw'));
    const typed = typedLines(r);
    assert.ok(typed.includes('confreg 0x2142') && typed.includes('reset') && typed.includes('config-register 0x2102'), typed.join(' | '));
    assert.ok(!typed.some((l) => DESTRUCTIVE.test(l)), typed.join(' | '));
    assert.ok(!typed.includes('unknown-pw'));
  } finally { r.done(); }
});

test('the 1841 left at 0x2141 at its initial dialog: no power cycle, dialog answered, 0x2102 restored', async () => {
  const r = rig({ model: '1841', confReg: '0x2141', enableSecret: 'lost', hostname: 'R1', start: 'booting' });
  try {
    for (let i = 0; i < 200 && r.dev.state !== 'dialog'; i++) await new Promise((res) => setTimeout(res, 10));
    assert.equal(r.dev.state, 'dialog');
    const { look, plan, results } = await recover(r, 'isr_g1', { person: false });
    assert.equal(look.state, 'dialog');
    assert.deepEqual(plan, ['boot', 'restore_register']);
    assert.ok(allOk(results), JSON.stringify(results, null, 1));
    assert.equal(r.dev.powerCycles, 0);
    assert.equal(r.dev.nextConfReg, '0x2102');
    assert.ok(r.dev.startup.global.some((l) => l.startsWith('enable secret')), 'the startup-config keeps its secret');
  } finally { r.done(); }
});

test('ISR 4331 (IOS XE) locked by an enable secret: BREAK during its long boot, PnP, Router#', async () => {
  const r = rig({ model: 'isr4331', start: 'exec', enableSecret: 'lost-secret', hostname: 'R1-2012' });
  try {
    const { results } = await recover(r, 'isr4300');
    assert.ok(allOk(results), JSON.stringify(results, null, 1));
    assert.equal(r.dev.mode, '#');
    assert.equal(r.dev.cfg.hostname, 'Router');
    assert.equal(r.dev.nextConfReg, '0x2102');
    assert.equal(r.dev.startup.hostname, 'R1-2012');
    assert.ok(!typedLines(r).some((l) => DESTRUCTIVE.test(l)));
  } finally { r.done(); }
});

for (const [model, family] of [['2960', 'catalyst'], ['3560', 'catalyst'], ['3560v2', 'catalyst'], ['c1000', 'c1000']]) {
  test(`${model}: Mode button, flash_init, config.text parked, Switch#, config.text put back`, async () => {
    const r = rig({ model, start: 'linepass', linePassword: 'unknown-pw', hostname: 'S1-2004' });
    try {
      const { plan, results } = await recover(r, family, { mode: true });
      assert.deepEqual(plan, ['power_cycle', 'flash_init', 'park_config', 'boot', 'restore_config']);
      assert.ok(allOk(results), JSON.stringify(results, null, 1));
      assert.equal(results.park_config.parked, true);
      assert.equal(results.restore_config.restored, true);
      assert.equal(r.dev.mode, '#');
      assert.equal(r.dev.cfg.hostname, 'Switch');
      assert.equal(r.dev.parked, null);
      assert.equal(r.dev.startup.hostname, 'S1-2004', 'flash:config.text is back, untouched');
      const typed = typedLines(r);
      assert.ok(typed.includes('flash_init') && typed.includes(`rename flash:config.text flash:${PARKED_NAME}`) && typed.includes(`rename flash:${PARKED_NAME} flash:config.text`), typed.join(' | '));
      assert.ok(!typed.some((l) => DESTRUCTIVE.test(l)), typed.join(' | '));
      assert.equal(r.written().includes('<BREAK>'), false, 'no BREAK on a switch');
    } finally { r.done(); }
  });
}

test('Catalyst 9300L: Mode button, SWITCH_IGNORE_STARTUP_CFG=1, Switch#, startup-config used again next time', async () => {
  const r = rig({ model: 'c9300l', start: 'exec', enableSecret: 'lost', hostname: 'SW1-2005' });
  try {
    const { results } = await recover(r, 'c9300l', { mode: true });
    assert.ok(allOk(results), JSON.stringify(results, null, 1));
    assert.equal(r.dev.cfg.hostname, 'Switch');
    assert.equal(r.dev.mode, '#');
    assert.equal(r.dev.romvars.SWITCH_IGNORE_STARTUP_CFG, '0');
    assert.equal(r.dev.startup.hostname, 'SW1-2005');
    assert.ok(!typedLines(r).some((l) => DESTRUCTIVE.test(l)));
  } finally { r.done(); }
});

test('a router already in ROMMON and a switch already at switch: skip the power cycle', async () => {
  const a = rig({ model: '2801', start: 'rommon' });
  try {
    const { plan, results } = await recover(a, 'isr_g1', { person: false });
    assert.deepEqual(plan, ['confreg', 'boot', 'restore_register']);
    assert.ok(allOk(results), JSON.stringify(results, null, 1));
  } finally { a.done(); }
  const b = rig({ model: '2960', start: 'bootloader' });
  try {
    const { plan, results } = await recover(b, 'catalyst', { person: false });
    assert.deepEqual(plan, ['flash_init', 'park_config', 'boot', 'restore_config']);
    assert.ok(allOk(results), JSON.stringify(results, null, 1));
    assert.equal(results.park_config.parked, true);
  } finally { b.done(); }
});

test('the BREAK never lands: break_missed, to try again; the second power cycle works', async () => {
  const r = rig({ model: '2811', start: 'linepass', linePassword: 'pw' });
  try {
    const rec = new CiscoRecovery(r.cli, { family: 'isr_g1', timeouts: RT });
    await r.cli.perform('recovery', async () => {
      const real = r.cli.breakSignal;
      r.cli.breakSignal = () => {}; // the console server drops it
      setTimeout(() => r.dev.powerCycle(), 30);
      const missed = await rec.interruptBoot();
      assert.equal(missed.reason, 'recovery.break_missed');
      assert.equal(missed.retry, true);
      r.cli.breakSignal = real;
      setTimeout(() => r.dev.powerCycle(), 30);
      const ok = await rec.interruptBoot();
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(r.dev.state, 'rommon');
    });
  } finally { r.done(); }
});

test('Mode released too early: mode_missed, to try again, nothing typed into IOS', async () => {
  const r = rig({ model: '2960', start: 'linepass', linePassword: 'pw' });
  try {
    const rec = new CiscoRecovery(r.cli, { family: 'catalyst', timeouts: RT });
    await r.cli.perform('recovery', async () => {
      setTimeout(() => r.dev.powerCycle({ modeButton: false }), 30);
      const res = await rec.interruptBoot();
      assert.equal(res.reason, 'recovery.mode_missed');
      assert.equal(res.retry, true);
    });
    assert.equal(r.written(), '');
  } finally { r.done(); }
});

test('password recovery disabled on the switch: the factory reset it offers is never answered', async () => {
  const r = rig({ model: '2960', start: 'exec', passwordRecovery: false, enableSecret: 'x', hostname: 'S5' });
  try {
    const rec = new CiscoRecovery(r.cli, { family: 'catalyst', timeouts: RT });
    await r.cli.perform('recovery', async () => {
      setTimeout(() => r.dev.powerCycle({ modeButton: true }), 30);
      const res = await rec.interruptBoot();
      assert.equal(res.reason, 'recovery.recovery_disabled');
      assert.notEqual(res.retry, true);
    });
    assert.equal(r.written(), '');
    assert.equal(r.dev.startup.hostname, 'S5');
    assert.equal(r.dev.state, 'question');
  } finally { r.done(); }
});

test('nobody power-cycles: no_boot_seen; a router seen as a switch: wrong_family', async () => {
  const a = rig({ model: '2811', start: 'exec' });
  try {
    const rec = new CiscoRecovery(a.cli, { family: 'isr_g1', timeouts: { ...RT, powerOnMs: 300 } });
    const res = await a.cli.perform('recovery', () => rec.interruptBoot());
    assert.equal(res.reason, 'recovery.no_boot_seen');
    assert.equal(res.retry, true);
  } finally { a.done(); }
  const b = rig({ model: '2811', start: 'rommon' });
  try {
    const { plan } = await recover(b, 'catalyst', { person: false });
    assert.equal(plan.reason, 'recovery.wrong_family');
    assert.equal(typedLines(b).length, 0, 'only the Enter that showed the prompt');
  } finally { b.done(); }
});

test('a parked config.text left by someone next to config.text: nothing renamed, nothing overwritten', async () => {
  const r = rig({ model: '3560', start: 'bootloader', hostname: 'S1' });
  try {
    r.dev.parked = { name: PARKED_NAME, cfg: structuredClone(r.dev.startup) };
    const { results } = await recover(r, 'catalyst', { person: false });
    assert.equal(results.park_config.reason, 'recovery.parked_exists');
    assert.ok(!typedLines(r).some((l) => /^rename/.test(l)));
    assert.equal(r.dev.startup.hostname, 'S1');
  } finally { r.done(); }
});

test('steps check their screen first: confreg on a device that is not in ROMMON types nothing but an Enter', async () => {
  const r = rig({ model: '2811', start: 'exec' });
  try {
    const rec = new CiscoRecovery(r.cli, { family: 'isr_g1', timeouts: RT });
    const res = await r.cli.perform('recovery', () => rec.setConfreg());
    assert.equal(res.reason, 'recovery.unexpected_screen');
    assert.deepEqual(typedLines(r), []);
  } finally { r.done(); }
});

test('cancelled in the middle of the BREAKs: the step stops with the engine\'s cancellation', async () => {
  const r = rig({ model: '2811', start: 'exec' });
  try {
    const rec = new CiscoRecovery(r.cli, { family: 'isr_g1', timeouts: RT });
    setTimeout(() => r.cli.cancel(), 100);
    await assert.rejects(r.cli.perform('recovery', () => rec.interruptBoot()), (err) => err.cancelled === true);
  } finally { r.done(); }
});
