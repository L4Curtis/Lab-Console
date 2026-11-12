# Signing in to Lab Console

Everything in Lab Console needs a signed-in user: pages, API, live events and
the console WebSockets. There is no mode without sign-in. Two ways in, one
kind of session:

| Who | How | Configured with |
|---|---|---|
| Students and teachers | the identity provider of the school (OpenID Connect) | `OIDC_*` |
| The local administrator | user name + password + 6-digit code | `LOCAL_ADMIN_*` |

The local administrator is mandatory: it is the emergency account, the one
that still works when the identity provider is down or not set up yet. The
platform refuses to start without it. OpenID Connect is optional; without it,
only the local administrator can sign in.

Roles: an account is **admin** when one of its groups is listed in
`OIDC_ADMIN_GROUPS`, otherwise **student**. The local administrator is an
admin. The role is decided at sign-in: a change of groups at the provider, or
of `OIDC_ADMIN_GROUPS`, applies at the person's next sign-in (revoke their
sessions to apply it at once).

## 1. The local administrator

### Create it

```bash
npm run setup-admin                       # asks for a user name and a password (not shown), twice
npm run setup-admin -- --username curtis  # same, with the name given
printf '%s\n' "$PASSWORD" | npm run --silent setup-admin -- --username curtis   # from a script
```

In Docker: `docker compose run --rm lab-console node scripts/setup-admin.js`.

It prints three lines for `.env` and an `otpauth://` URI:

```
LOCAL_ADMIN_USERNAME=curtis
LOCAL_ADMIN_PASSWORD_HASH=scrypt:32768:8:3:…:…
LOCAL_ADMIN_TOTP_SECRET=JBSWY3DPEHPK3PXP…

otpauth://totp/Lab%20Console:curtis?secret=…&issuer=Lab%20Console&algorithm=SHA1&digits=6&period=30
```

Add the URI to an authenticator app (Aegis, 2FAS, Google Authenticator, a
password manager…): turn it into a QR code with any tool you trust offline,
or type the secret by hand (time-based, SHA-1, 6 digits, 30 s). Nothing is
written to disk and the password itself is never printed. The hash and the
secret are as sensitive as the password: keep `.env` readable by the service
only (`chmod 600 .env`).

The password needs at least 12 characters. The hash is scrypt with its cost
in the value (`N`, `r`, `p`), safe to paste in a `.env` or a compose file (no
`$` to expand).

### Sign in

On `/login`, open **Local administrator** (it is open already when no
identity provider is configured) and type the user name, the password and the
code shown by the app, all three together. A refusal never says which one was
wrong.

- A code is valid for its 30-second step and one step either side (clock
  drift). Once accepted, that step cannot be used again, even after a restart
  (`data/auth/local-admin.json` remembers the last one): wait for the next code
  to sign in a second time.
- Attempts are limited: 5 per 15 minutes from one address; after two failures
  on a user name, each new attempt on that name waits twice as long as the
  previous one (1 s, 2 s, 4 s… up to 15 minutes), from any address; and at most
  50 failures per 15 minutes in total. The answer and its timing are the same
  whether or not the name exists. These limits only apply to this form: people
  who sign in through the identity provider never meet them.
- **Known browsers.** The last two limits are shared by everybody, so a
  stranger could keep them on for good. A browser that has signed in
  successfully keeps a `lc_device` cookie (`__Host-lc_device` over https, 180
  days, signed, only valid for that user name). Its attempts are counted on
  that browser alone, 5 per 15 minutes with its own backoff, and the shared
  refusals no longer apply to it. It is not a credential: the name, the
  password and the code are still required. **Sign in once from the browser
  you would use in an emergency**: a browser that never signed in can still be
  kept waiting by someone hammering the form.
- Every attempt whose credentials were checked, successful or not, is in the
  audit trail (`auth.login`, `auth.login.failed`), with the client's address.
  Refusals that cost the sender nothing (a throttled attempt, a provider
  callback that matches no sign-in in progress) are written once per address
  and kind per 15 minutes; the rest are counted, and one
  `auth.login.suppressed` entry per quarter of an hour gives the total and
  the ten busiest addresses. The audit trail cannot be used to fill the disk.

### Change the password, or a lost phone

Run `npm run setup-admin` again, replace the three lines, restart. The old
password and the old code stop working, and so does everything obtained with
them: the local administrator's open sessions end at the restart (each one is
stored with a fingerprint of the credentials it was opened with), and the
known-browser cookies are no longer valid (their key derives from the same
credentials). Changing only the user name has the same effect. This is the
thing to do after a suspected compromise.

## 2. An identity provider (OpenID Connect)

Lab Console uses the authorization code flow with PKCE (S256), `state` and
`nonce`, and checks the ID token's signature against the provider's published
keys. Anything standard works; the recipes below cover the four we expect.

### What every provider needs

| Setting at the provider | Value |
|---|---|
| Client type | confidential (with a secret) or public (no secret: PKCE only) |
| Redirect / callback URL | `${PUBLIC_URL}/auth/callback`, e.g. `https://lab.example.org/auth/callback` |
| Post-logout redirect URL | `${PUBLIC_URL}/login` (if the provider asks) |
| Grant type | authorization code only |
| Scopes | `openid profile email`, plus whatever gives the groups |
| ID token signature | an asymmetric key (RS256, ES256…), never the client secret (HS256) |

And in `.env`:

```bash
PUBLIC_URL=https://lab.example.org        # exactly what users type; https in production
OIDC_ISSUER=https://id.example.org        # the issuer, EXACTLY as the provider shows it (keep or omit the final /)
OIDC_CLIENT_ID=lab-console
OIDC_CLIENT_SECRET=…                      # empty for a public client
OIDC_CLIENT_AUTH_METHOD=client_secret_basic   # or client_secret_post, if the provider wants the secret in the body
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups                  # a claim name, or a dotted path: realm_access.roles
OIDC_ADMIN_GROUPS=lab-admins              # members are administrators
OIDC_ALLOWED_GROUPS=                      # empty: every account may sign in; else only these groups (and the admin ones)
OIDC_PROVIDER_NAME=Pocket ID              # label of the button: "Se connecter avec Pocket ID"
```

The issuer is compared character for character with what the provider
publishes at `<issuer>/.well-known/openid-configuration` (its `issuer` field):
copy it from there if in doubt. The provider is contacted at the first
sign-in, not at start-up, so the platform starts even when the provider is
down; the login page then says so and the local administrator can still sign
in.

**Groups.** Lab Console reads `OIDC_GROUPS_CLAIM` in the ID token; when the
claim is not there (some providers keep the ID token small) it asks the
userinfo endpoint. The claim may be an array or a single string (one group,
or several separated by commas). Group names are compared exactly, case
included. A user in none of `OIDC_ALLOWED_GROUPS` is sent back to the login
page with "Your account is in none of the groups allowed to use Lab Console".

**Sign-out** ends the Lab Console session, then sends the browser to the
provider's end-session endpoint when it advertises one (`end_session_endpoint`
in its discovery document), which brings it back to `/login`. Otherwise
sign-out is local only: the provider's own session stays open.

**Plain http** is refused for the issuer, except on `localhost` (the mock
provider). `OIDC_ALLOW_INSECURE=true` accepts it on a test bench: never with
real accounts, since anyone on the path could then sign in as anyone.

### Pocket ID

1. *Administration → OIDC Clients → Add OIDC client*. Name: Lab Console.
2. *Callback URLs*: `https://lab.example.org/auth/callback`; *Logout callback
   URLs*: `https://lab.example.org/login`.
3. Tick *Public client* for a client without secret (then *PKCE* is
   required), or leave it unticked and copy the secret shown after saving.
4. Optionally restrict the client to some user groups at the provider.
5. Groups: Pocket ID returns the names of the user's groups in the `groups`
   claim when the `groups` scope is requested, so the defaults work.

```bash
OIDC_ISSUER=https://id.example.org
OIDC_CLIENT_ID=<client id shown by Pocket ID>
OIDC_CLIENT_SECRET=<secret, or empty for a public client>
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_PROVIDER_NAME=Pocket ID
```

### Authentik

1. *Applications → Providers → Create → OAuth2/OpenID Provider*.
   - *Client type*: Confidential (with secret) or Public.
   - *Redirect URIs*: strict, `https://lab.example.org/auth/callback`.
   - *Signing key*: pick a certificate (e.g. the self-signed one). Without it
     Authentik signs ID tokens with the client secret (HS256), which Lab
     Console refuses.
   - Scopes: the default `openid`, `email` and `profile` mappings. Authentik's
     default `profile` mapping already includes a `groups` claim.
2. *Applications → Create*, linked to that provider, slug `lab-console`.
3. The issuer is `https://authentik.example.org/application/o/lab-console/`,
   **with** its final slash (it is shown on the provider's page as
   *OpenID Configuration Issuer*).

```bash
OIDC_ISSUER=https://authentik.example.org/application/o/lab-console/
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret, or empty for Public>
OIDC_SCOPES=openid profile email
OIDC_GROUPS_CLAIM=groups
OIDC_PROVIDER_NAME=Authentik
```

### Keycloak

1. In your realm: *Clients → Create client*, type OpenID Connect, client ID
   `lab-console`.
   - *Client authentication*: On for a confidential client (the secret is
     then under *Credentials*), Off for a public one.
   - *Authentication flow*: Standard flow only.
   - *Valid redirect URIs*: `https://lab.example.org/auth/callback`;
     *Valid post logout redirect URIs*: `https://lab.example.org/login`;
     *Web origins*: `https://lab.example.org`.
   - *Advanced → Proof Key for Code Exchange*: S256.
2. Groups. Keycloak puts none in the tokens by default. Create a client
   scope named `groups` (*Client scopes → Create*, type Default), add the
   mapper *By configuration → Group Membership* with token claim name
   `groups`, *Full group path* off, *Add to ID token* and *Add to userinfo*
   on, then add that scope to the client. The default `OIDC_SCOPES` then work.
   To use realm roles instead: `OIDC_GROUPS_CLAIM=realm_access.roles`, with
   the *realm roles* mapper of the `roles` scope added to the ID token or to
   userinfo.
3. The issuer is `https://keycloak.example.org/realms/<realm>`, without a
   final slash.

```bash
OIDC_ISSUER=https://keycloak.example.org/realms/school
OIDC_CLIENT_ID=lab-console
OIDC_CLIENT_SECRET=<secret, or empty for a public client>
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_PROVIDER_NAME=Keycloak
```

### Authelia

In Authelia's configuration (`identity_providers.oidc.clients`):

```yaml
- client_id: lab-console
  client_name: Lab Console
  client_secret: '$pbkdf2-sha512$…'      # authelia crypto hash generate pbkdf2 --random; the clear secret goes in Lab Console
  public: false                          # true (and token_endpoint_auth_method: none) for a public client
  authorization_policy: two_factor
  redirect_uris:
    - https://lab.example.org/auth/callback
  scopes: [openid, profile, email, groups]
  response_types: [code]
  grant_types: [authorization_code]
  require_pkce: true
  pkce_challenge_method: S256
  token_endpoint_auth_method: client_secret_basic
```

Recent Authelia versions keep the ID token small and serve `groups`, `name`
and `email` at the userinfo endpoint: Lab Console asks userinfo by itself
when the ID token lacks them.

```bash
OIDC_ISSUER=https://auth.example.org
OIDC_CLIENT_ID=lab-console
OIDC_CLIENT_SECRET=<the clear secret>
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_PROVIDER_NAME=Authelia
```

## 3. Sessions

- The session is a random 256-bit token in an `HttpOnly`, `SameSite=Lax`
  cookie: `__Host-lc_sid` (with `Secure`) when `PUBLIC_URL` is https, `lc_sid`
  otherwise. The cookie ends with the browser.
- 8 hours without activity (an open console counts as activity), 24 hours at
  most, 10 sessions per person. A new id at every sign-in.
- Sessions survive a restart: `data/auth/sessions.json` keeps them, keyed by
  the SHA-256 of the token; the token itself is never written anywhere.
- When a session ends (sign-out, revocation by an administrator, expiry) the
  consoles and live updates opened with it are closed at once.

## 4. Exposed to the Internet

The sign-in is built to face the Internet directly:

- `TRUSTED_PROXIES` must list **every hop** between the Internet and Lab
  Console. `X-Forwarded-For` is read from the right: each address that is one
  of ours is skipped, and the first one that is not is the client (used by the
  attempt limits and the audit trail). What the client wrote itself further
  left is ignored, and a peer that is not listed is never believed.
  - Behind Nginx Proxy Manager, then Cloudflare: Cloudflare appends the
    visitor's address, NPM appends Cloudflare's. List NPM's address **and**
    Cloudflare's published ranges (<https://www.cloudflare.com/ips/>, IPv4 and
    IPv6), for example
    `TRUSTED_PROXIES=192.168.10.112,173.245.48.0/20,103.21.244.0/22,…,2400:cb00::/32,…`.
    With NPM alone listed, every visitor appears as a Cloudflare edge
    address and they all share one attempt budget. Re-check the list when
    Cloudflare announces a change.
  - The proxies must append to `X-Forwarded-For`, not replace it (NPM and
    nginx's `$proxy_add_x_forwarded_for` do). `CF-Connecting-IP` is not read.
  - The upstream `TRUST_PROXY=true` (believe the header from any peer) let
    any client choose its own address: Lab Console refuses to start while it
    is set. Remove it and fill `TRUSTED_PROXIES`.
- `PUBLIC_URL` must be the https address: it sets the cookie prefix and
  `Secure`, and the callback URL given to the provider.
- The login page and every `/auth/*` answer carry `X-Robots-Tag: noindex` and
  `Cache-Control: no-store`; errors never contain a version or a stack trace.

## 5. Trying it locally

```bash
npm run mock-oidc     # a fake provider on http://127.0.0.1:9100, prints the OIDC_* lines
```

It shows a user picker (three students, one admin) and signs anyone in as
anyone, without a password. It refuses to start with `NODE_ENV=production`,
listens on the loopback interface unless given `--expose`, and is not in the
Docker image. `--misbehave wrongNonce,groupsInUserinfoOnly,groupsAsString`
makes it misbehave on purpose.

## 6. A pre-production stack

`docker-compose.preprod.yml` adds the mock provider to the Docker stack and
points Lab Console at it, so testers sign in as `student1`…`student3` or
`admin` by clicking a name. Anyone who reaches the mock can do the same: use
it only on a stack without real accounts, reachable by the testers only.

1. In the `.env` next to the compose files, besides the usual settings
   (`PUBLIC_URL`, `LOCAL_ADMIN_*`…):

   ```bash
   MOCK_OIDC_ISSUER=http://192.168.10.250:9100   # as BOTH the browsers and the container reach it
   MOCK_OIDC_PUBLISH=192.168.10.250:9100         # where the host publishes the mock (default 127.0.0.1:9100)
   ```

   The issuer must be the same address for the browsers (sent there to pick
   a user) and for the `lab-console` container (discovery, token, keys): the
   host's LAN address and the published port usually serve both.
2. Start both:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.preprod.yml up -d --build
   ```

   The `OIDC_*` values of the override (the mock's client `lab-console` /
   `mock-secret`, admin group `admins`, `OIDC_ALLOW_INSECURE=true` for its
   plain http) win over those of `.env`. The local administrator still works.
3. Check that the container reaches the issuer:
   `docker compose exec lab-console wget -qO- "$MOCK_OIDC_ISSUER/.well-known/openid-configuration"`.
   If not, the sign-in button leads to "provider unavailable".

The production image is unchanged and still has no `dev/`: the mock runs in a
plain `node:22-alpine` container from `dev/mock-oidc.js` mounted read-only,
with `NODE_ENV=development` (it refuses `production`).
