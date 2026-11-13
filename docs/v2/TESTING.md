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
