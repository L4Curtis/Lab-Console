# Deploying Lab Console in production

**English** · [Français](fr/DEPLOY.md)

For an installation that people reach from the Internet, behind a reverse
proxy that terminates HTTPS. Read the [README](../README.md) first for what
the application is, and [AUTH.md](v2/AUTH.md) for the sign-in details.

Lab Console has no authentication in front of it: it is built to face the
Internet directly, which is why nothing is served without a signed-in user.
The checklist below is what makes that safe.

## 0. Checklist

- [ ] `PUBLIC_URL` is the https address users type.
- [ ] `TRUSTED_PROXIES` lists every hop between the Internet and the container.
- [ ] `APP_SECRET` is set (32 characters or more).
- [ ] The local administrator exists (`LOCAL_ADMIN_*`) and you signed in once.
- [ ] `SSH_HOST_FINGERPRINT` pins the jump server.
- [ ] The container's port is reachable by the proxy only.
- [ ] The `lab-console-data` volume and `.env` are backed up, and a restore was tried.

## 1. Prerequisites

- A host with Docker and Docker Compose, able to reach the jump server over SSH
  (and nothing else of the lab network: the lab is reached through it).
- A reverse proxy with a certificate for the public name (nginx, Nginx Proxy
  Manager, Traefik, Caddy…), possibly behind a CDN.
- Optionally an OpenID Connect provider (Pocket ID, Authentik, Keycloak,
  Authelia…). Without one only the local administrator can sign in, plus the
  local accounts you create by invitation.

## 2. Configure `.env`

```bash
cp .env.example .env
chmod 600 .env
npm run setup-admin      # or: docker compose run --rm lab-console node scripts/setup-admin.js
```

`setup-admin` asks for a user name and a password and prints three lines
(`LOCAL_ADMIN_USERNAME`, `LOCAL_ADMIN_PASSWORD_HASH`, `LOCAL_ADMIN_TOTP_SECRET`)
and an `otpauth://` URI to add to your authenticator app. Paste the lines into
`.env`. The application refuses to start without them.

The settings that matter for a public installation (every setting:
[CONFIGURATION.md](CONFIGURATION.md)):

| Setting | What to put |
|---|---|
| `PUBLIC_URL` | `https://lab.example.org`: scheme and host, no path. It makes the session cookie `__Host-` prefixed and `Secure`, sets the callback URL given to the identity provider, the origin the WebSockets accept, the relying party of the passkeys, and turns on HSTS (`Strict-Transport-Security: max-age=31536000; includeSubDomains`) on every response. Use https: with http none of this applies. |
| `TRUSTED_PROXIES` | Every reverse proxy, CDN and load balancer in front of the container, as addresses or CIDR blocks. See below. |
| `ALLOWED_ORIGINS` | Only when the site is also reached under another name; empty otherwise. |
| `APP_SECRET` | At least 32 characters: `openssl rand -base64 48`. It encrypts the secrets saved from the administration pages (the SSO client secret, the jump server and console passwords). Without it they are stored in clear in the database. Keep it with the backup of `.env`: changing or losing it makes those secrets unreadable and they must be typed again. |
| `SSH_HOST_FINGERPRINT` | Required in production: `ssh-keyscan -t ed25519 <jump server> \| ssh-keygen -lf -`. Without it no console connects (`consoles.ssh_unpinned`). It can also be saved on the lab parameters page. |
| `SSH_*`, `TELNET_*`, `ALLOWED_CONSOLE_HOSTS`, `ALLOWED_PORT_RANGE` | The lab. They can be changed later from Administration > Lab parameters, without a restart. |
| `DEFAULT_LOCALE` | `fr` or `en`, for a first visit. |

### TRUSTED_PROXIES

Client addresses (attempt limits, audit trail, rate limits) are read from
`X-Forwarded-For`, from the right: each address that is one of yours is
skipped and the first one that is not is the client. A peer that is not
listed is never believed, so nobody can pick their own address.

- Behind one nginx: its address, e.g. `TRUSTED_PROXIES=192.168.10.112`.
- Behind a proxy and then Cloudflare: the proxy's address **and** Cloudflare's
  published ranges (<https://www.cloudflare.com/ips/>, IPv4 and IPv6), and
  re-check them when Cloudflare announces a change. With only the proxy
  listed every visitor appears with a Cloudflare address and they all share
  one attempt budget.
- Every proxy must **append** to `X-Forwarded-For` (nginx:
  `$proxy_add_x_forwarded_for`), not replace it. `CF-Connecting-IP` is not read.
- The old `TRUST_PROXY=true` is refused at start-up.

## 3. Start the container

```bash
docker compose up -d --build
docker compose logs -f lab-console       # the first start creates the database
```

`docker-compose.yml` runs the image `lab-console:2` with a read-only root
filesystem and a named volume `lab-console-data` on `/data` (the only
writable path: database, snapshots, journals, diagram versions). The image
sets `NODE_ENV=production`.

**Publish the port to the proxy only.** By default Compose publishes
`${PORT:-3000}` on every interface. Bind it to the interface the proxy uses,
for example in a `docker-compose.override.yml`:

```yaml
services:
  lab-console:
    ports: !override
      - "192.168.10.250:3000:3000"
```

(or `127.0.0.1:3000:3000` when the proxy runs on the same host), and let the
host firewall refuse the port from anywhere else. If a client could reach the
container directly, it could send its own `X-Forwarded-For`: it would be
ignored, because only `TRUSTED_PROXIES` are believed, but there is no reason
to leave the door open.

The container has a health check (`GET /api/health` answers `{"ok":true}`);
`docker compose ps` shows its state.

## 4. The reverse proxy

The proxy must pass WebSockets (three of them carry the consoles and the live
updates), keep them open for hours, not buffer, and append `X-Forwarded-For`.
With nginx:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    http2 on;
    server_name lab.example.org;
    # ssl_certificate / ssl_certificate_key …

    client_max_body_size 8m;                  # a diagram import is up to 5 MB, a ZIP import JOB_IMPORT_MAX_KB (2 MB by default)

    location / {
        proxy_pass http://192.168.10.250:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

In Nginx Proxy Manager: tick **Websockets Support** and **Force SSL**, and
add `proxy_read_timeout 3600s;` in the advanced tab. Behind Cloudflare, keep
WebSockets enabled (they are by default). A second login in front of the
application (Cloudflare Access, for example) is not needed, and the
WebSocket and API requests must still reach the application.

Do not rewrite the `Host` or `Origin` headers: the application accepts a
WebSocket or a change only from `PUBLIC_URL` (and `ALLOWED_ORIGINS`).

Check it from outside: `curl -sI https://lab.example.org/login` must answer
200 with `Strict-Transport-Security`, `X-Robots-Tag: noindex` and
`Cache-Control: no-store`, and `curl -s https://lab.example.org/api/modules`
without a session must answer 401, never data.

## 5. First sign-in with the local administrator

1. Open `https://lab.example.org/login`, open **Local account** (the server administrator signs in there) and type
   the user name, the password and the current 6-digit code together.
2. Open **Administration**. Sensitive changes (lab parameters, the SSO
   settings, creating or promoting an administrator) ask you to confirm again
   with the password and a fresh code, with a passkey, or by signing in again
   at the identity provider.
3. **Lab parameters**: check the jump server, the console login and the
   allowed consoles; pin the fingerprint if you did not in `.env`.
4. **Diagram**: replace the shipped diagram by yours (preview, versions, rollback).
5. Create the first teachers' accounts by **Invitations** (links valid 1 h,
   24 h or 7 days, for one person or up to 100 with approval), or configure
   the SSO next.
6. Keep the local administrator as the emergency account. Sign in once from
   the browser you would use in an emergency (it becomes a known browser
   with its own attempt budget, see AUTH.md). Add a passkey to your own
   administrator account if you make one.

## 6. Configuring the SSO from the administration page

Without `OIDC_ISSUER` in the environment, the provider is set from
**Administration > Sign-in (SSO)** and applies at once, without a restart.

1. At the provider, create a client with the callback URL
   `https://lab.example.org/auth/callback` (the page shows it), the
   authorization code grant and the scopes `openid profile email` plus the one
   that gives groups. Recipes for Pocket ID, Authentik, Keycloak and Authelia:
   [AUTH.md](v2/AUTH.md).
2. On the SSO tab fill the button name, the issuer (exactly as the provider
   publishes it), the client id and secret (the secret is write-only: the page
   only says whether one is saved), the groups claim, the **admin groups**
   and, if you want to restrict who may sign in, the **allowed groups**.
3. **Test** fetches the discovery document. **Try a sign-in** goes to the
   provider and back without opening a session and shows the claims received
   and the role they give.
4. Save and confirm. Set `APP_SECRET` beforehand, otherwise the client secret
   is stored in clear in the database.

If `OIDC_ISSUER` is set in `.env`, the environment wins and the tab is read-only.
An SSO account is an administrator when one of its groups is in the admin
groups, unless an administrator forced a role on the Users tab. Groups are read
at sign-in. Making someone an administrator, through the groups or the Users
tab, is a confirmed action.

## 7. What to back up

Everything the application writes is under `/data` in the container (the
`lab-console-data` volume). Besides it, keep `.env` and your own files.

| What | Why | How |
|---|---|---|
| The **database** `lab-console.db` (with its `-wal` and `-shm` files) | accounts, teams, sessions, audit trail, settings, the index of snapshots and jobs, notes, chat, scripts | consistent copy while running: `sqlite3 lab-console.db ".backup /backup/lab-console.db"`; or stop the container and copy the three files. Copying the `.db` alone while it runs may miss what is still in the `-wal` file. |
| The **`data/` files**: `snapshots/`, `templates/`, `journal/`, `diagrams/` | configuration backups of the devices, TP templates, console journals, diagram versions: the database only indexes them | copy the whole directory with the database taken at the same moment (stop the container, or copy files right after the `.backup`) |
| `.env` (mode 600) | the jump server and console credentials, the local administrator, `APP_SECRET` | keep it apart from the data backup; without `APP_SECRET` the encrypted secrets of the database are unreadable |
| `diagrams/` and `config/` of the project folder | the shipped diagram and the admin switches' starting list | in your repository |

With the named volume, an archive taken while the container is stopped is
the simplest:

```bash
docker compose stop lab-console
docker run --rm -v lab-console_lab-console-data:/data:ro -v "$PWD/backup":/backup alpine \
  tar czf /backup/lab-console-data-$(date +%F).tgz -C /data .
docker compose start lab-console
```

(the volume is named `<project folder>_lab-console-data`; check with
`docker volume ls`). To restore: stop, extract into an empty volume (the
files must belong to uid 1000), start. Try a restore once on a spare
machine before you need it.

The journals and snapshots grow: `JOURNAL_RETENTION_DAYS`,
`JOURNAL_MAX_KB_PER_DAY` and `JOURNAL_MAX_TOTAL_MB` bound the journals, and
snapshots are listed in the Sauvegardes section. Students are told to download
the ZIP of a backup right away: the server's copy is not their backup.

## 8. Upgrading and operating

- **Upgrade**: back up, `git pull` (or copy the new release), read the
  CHANGELOG, then `docker compose up -d --build`. The database migrates
  itself at the start. Rolling back to an older image after a migration is
  not supported: restore the backup taken before.
- **Sessions** survive a restart (they are in the database). Changing the
  local administrator's credentials ends its sessions.
- **Logs**: `docker compose logs`. Errors shown to users carry no version or
  stack trace; the detail is in the log. Add a `logging` section to the
  compose file if the host keeps logs without a limit.
- **Health page**: Administration > Lab status shows the jump server, the
  console servers, the open lines and the journals' size.
- **Rotating a secret**: a new local administrator password: `npm run
  setup-admin` again, replace the three lines, restart. A new `APP_SECRET`:
  set it, restart, then type the SSO client secret and the lab passwords
  again.
- **Lock-out**: if nobody can sign in, the local administrator still can
  (password + code). If its phone is lost, run `setup-admin` again.
- **Before the first real class**: the pre-production checks listed in
  [SPEC.md](v2/SPEC.md) (erase and reload on IOS XE, five job lines at once,
  password recovery families, BREAK through the console server) cannot be
  settled with the simulator: do them on the real equipment.
