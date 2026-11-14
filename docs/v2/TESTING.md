# Writing a browser scenario

Browser tests live in `test/e2e/*.e2e.js` and run with `npm run test:e2e`:
one file at a time, each in its own process, with the system Chromium driven
by `playwright-core`. They all start through `test/e2e/harness.js`. Unit and
API tests (`npm test`) are described in [ARCHITECTURE.md](ARCHITECTURE.md) §11.

## What the harness starts

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness, signInAs, openConsole, typeInConsole, waitForTerminal, signOut } from './harness.js';

const h = useHarness();   // or useHarness({ oidc: false, mockLab: false, env: { … } })
```

`useHarness()` registers a `before()` that starts, all on ephemeral ports:

| piece | option | what you get |
|---|---|---|
| the mock lab (`dev/mock-lab.js`) | `mockLab: true` or startMockLab options (`busyPorts`, `devices`…) | `h.lab.device('10.22.9.211:2013')`: the simulated device behind a console line. Devices are named after the diagram (B4M R1 answers `R1>`); the console server asks for a login, which the application answers by itself |
| the mock identity provider (`dev/mock-oidc.js`) | `oidc: true` | `h.idp.issuer`, `h.idp.signOuts`, `h.idp.misbehave({…})` |
| the application, with a temporary `DATA_DIR` | `env: {…}` | `h.url`, `h.app` (the `startTestApp` object: `deps`, `as()`, `signIn()`…) |
| Chromium, headless | `CHROMIUM_PATH` | `h.newPage({ locale })` |

and an `after()` that closes everything and deletes the data directory. A
failing test, a start-up that breaks half-way and a run cancelled with
Ctrl+C or SIGTERM are all cleaned up; `teardown.e2e.js` proves it. Never call
`chromium.launch` or start a mock yourself in a scenario file.

Top-level `before()` hooks of a file run concurrently. If your file has its
own, start it with `await h.ready`.

## Signing in

- `await signInAs(page, 'alice')`: the real way, through the login page and
  the provider's user picker. People: `alice` (student1), `bilal`, `chloe`
  (students), `ada` (admin, group `admins`); user names work too.
- `await signInAsAdmin(page)`: the local administrator's form, with the TOTP
  code computed from the test secret (`h.adminCode()` hands out a code the
  server has not consumed yet, so two sign-ins in a row work).
- `await h.session(page, 'student1')`: no sign-in page at all; a real session
  opened by the test helper is put in the browser as its cookie. Use it when
  the sign-in is not what the scenario is about.
- `await signOut(page)`: the user menu's button, until `/login`.
- The guided tour opens by itself for a person who never saw it, which every
  fresh test user is, and it would sit over the page. `h.newPage()` therefore
  tells the page (in the browser only) that the tour was already seen; a
  scenario about the tour itself opens `h.newPage({ tour: true })` and uses a
  person no other scenario of the file signed in as (`test/e2e/help.e2e.js`).

## Consoles

```js
test('a student reaches R1', async () => {
  const page = await h.newPage();
  await signInAs(page, 'alice');
  const pane = await openConsole(page, 'B4M', 'R1');   // connected, auto-login done
  await typeInConsole(pane, '');                        // the device wakes up on Enter
  await waitForTerminal(pane, /^R1>$/m);
  await typeInConsole(pane, 'show ip interface brief');
  const text = await waitForTerminal(pane, /^FastEthernet0\/0 /m);
  assert.match(text, /^R1>show ip interface brief$/m);
  await page.context().close();
});
```

`terminalText(pane)` is what the terminal shows on screen, one line per row
(scrolled-out lines are not included: prefer commands with short output).
`waitForTerminal()` throws with the screen's content when the pattern never
appears, which is usually the whole diagnosis.

## Rules

- **Wait on conditions, never on time**: `waitForSelector`, `waitForURL`,
  `waitForFunction`, `waitForTerminal`. No `waitForTimeout`, no `setTimeout`.
  To check that something did *not* happen, wait for the event that would
  have caused it to be handled, then look.
- One page per scenario, closed at the end (`page.context().close()`), so
  cookies and storage do not leak into the next test.
- `page.errors` collects the page's errors and failed scripts; end with
  `assert.deepEqual(page.errors, [])` unless an error is the point.
- Use the visible texts in French (the default locale) or switch with
  `setLanguage(page, 'en')`; both languages must keep working.
- Run `npm run test:e2e` three times in a row before you commit a scenario:
  a test that fails once in three is broken.
- **Publish, then act: wait for the page.** A server push (SSE) and a
  Playwright call travel on different channels. After `events.publish(...)`,
  wait for what the page shows of it (a toast, a badge) before changing the
  page's state (`__away`, a route, a click).
- **Time-driven behaviour of the page**: use `page.clock.install()` and
  `page.clock.fastForward(ms)` instead of sleeping.
- **What only the server refuses**: the page already drops a spectator's keys.
  To test the server, send the frame by hand (`sendInputFrame()`).

## Stress step

A test that passes on an idle machine can still depend on timing. Before you
commit a change to a test, to the simulators in `dev/` or to anything paced,
run the changed file five times while the machine is busy, with two CPU
burners per core:

```sh
for i in $(seq $(( $(nproc) * 2 ))); do node -e 'const e=Date.now()+600000;for(;Date.now()<e;)for(let i=0;i<1e6;i++)Math.sqrt(i)' & done
for i in 1 2 3 4 5; do node --test --test-concurrency=1 test/e2e/<file>.e2e.js || break; done
kill $(jobs -p)
```

Kill the burners when you are done (`pgrep -af 'Math.sqrt'`). A failure here
is a flaw in the test or the simulator unless the server's pacing is wrong:
find out which before touching a timeout.
