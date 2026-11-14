# Déployer Lab Console en production

[English](../DEPLOY.md) · **Français**

Pour une installation que l'on atteint depuis Internet, derrière un reverse
proxy qui termine le HTTPS. Lisez d'abord le [README](../../README.fr.md) pour
savoir ce qu'est l'application, et [AUTH.md](AUTH.md) pour le détail de la
connexion.

Lab Console n'a aucune authentification devant elle : elle est faite pour
affronter Internet directement, et c'est pourquoi rien n'est servi sans
utilisateur connecté. La liste ci-dessous est ce qui rend cela sûr.

## 0. Liste de contrôle

- [ ] `PUBLIC_URL` est l'adresse https que tapent les utilisateurs.
- [ ] `TRUSTED_PROXIES` liste chaque relais entre Internet et le conteneur.
- [ ] `APP_SECRET` est défini (32 caractères ou plus).
- [ ] L'administrateur local existe (`LOCAL_ADMIN_*`) et vous vous êtes connecté une fois.
- [ ] `SSH_HOST_FINGERPRINT` épingle le serveur de rebond.
- [ ] Le port du conteneur n'est joignable que par le proxy.
- [ ] Le volume `lab-console-data` et `.env` sont sauvegardés, et une restauration a été essayée.

## 1. Prérequis

- Un hôte avec Docker et Docker Compose, qui joint le serveur de rebond en SSH
  (et rien d'autre du réseau du labo : le labo se joint par lui).
- Un reverse proxy avec un certificat pour le nom public (nginx, Nginx Proxy
  Manager, Traefik, Caddy…), éventuellement derrière un CDN.
- Facultatif : un fournisseur OpenID Connect (Pocket ID, Authentik, Keycloak,
  Authelia…). Sans lui, seuls l'administrateur local et les comptes locaux
  créés par invitation peuvent se connecter.

## 2. Configurer `.env`

```bash
cp .env.example .env
chmod 600 .env
npm run setup-admin      # ou : docker compose run --rm lab-console node scripts/setup-admin.js
```

`setup-admin` demande un nom et un mot de passe, puis affiche trois lignes
(`LOCAL_ADMIN_USERNAME`, `LOCAL_ADMIN_PASSWORD_HASH`, `LOCAL_ADMIN_TOTP_SECRET`)
et une URI `otpauth://` à ajouter à votre application d'authentification.
Collez les lignes dans `.env` : l'application refuse de démarrer sans elles.

Les réglages qui comptent pour une installation publique (tous les réglages :
[CONFIGURATION.md](../CONFIGURATION.md), en anglais) :

| Réglage | Valeur |
|---|---|
| `PUBLIC_URL` | `https://lab.example.org` : schéma et hôte, sans chemin. Il donne au cookie de session le préfixe `__Host-` et `Secure`, fixe l'URL de retour donnée au fournisseur d'identité, l'origine acceptée par les WebSockets et l'identité des clés d'accès, et active HSTS (`Strict-Transport-Security: max-age=31536000; includeSubDomains`) sur chaque réponse. Utilisez https : en http, rien de cela ne s'applique. |
| `TRUSTED_PROXIES` | Chaque reverse proxy, CDN et répartiteur devant le conteneur, en adresses ou blocs CIDR. Voir plus bas. |
| `ALLOWED_ORIGINS` | Seulement si le site est aussi joint sous un autre nom ; vide sinon. |
| `APP_SECRET` | 32 caractères au moins : `openssl rand -base64 48`. Il chiffre les secrets enregistrés depuis les pages d'administration (secret client SSO, mots de passe du rebond et des consoles). Sans lui, ils sont stockés en clair dans la base. Gardez-le avec la sauvegarde de `.env` : le changer ou le perdre rend ces secrets illisibles, il faut alors les ressaisir. |
| `SSH_HOST_FINGERPRINT` | Obligatoire en production : `ssh-keyscan -t ed25519 <serveur de rebond> \| ssh-keygen -lf -`. Sans elle aucune console ne se connecte (`consoles.ssh_unpinned`). Elle peut aussi être enregistrée sur la page des paramètres du labo. |
| `SSH_*`, `TELNET_*`, `ALLOWED_CONSOLE_HOSTS`, `ALLOWED_PORT_RANGE` | Le labo. Modifiables ensuite depuis Administration > Paramètres du labo, sans redémarrage. |
| `DEFAULT_LOCALE` | `fr` ou `en`, pour une première visite. |

### TRUSTED_PROXIES

L'adresse du client (limites de tentatives, journal d'audit, limites de
débit) est lue dans `X-Forwarded-For`, en partant de la droite : chaque
adresse qui est l'une des vôtres est sautée, la première qui n'en est pas est
le client. Un pair qui n'est pas listé n'est jamais cru : personne ne peut
choisir son adresse.

- Derrière un seul nginx : son adresse, par exemple `TRUSTED_PROXIES=192.168.10.112`.
- Derrière un proxy puis Cloudflare : l'adresse du proxy **et** les plages
  publiées par Cloudflare (<https://www.cloudflare.com/ips/>, IPv4 et IPv6) ;
  revérifiez-les quand Cloudflare annonce un changement. Avec le seul proxy
  listé, tous les visiteurs apparaissent avec une adresse Cloudflare et se
  partagent un seul budget de tentatives.
- Chaque proxy doit **ajouter** à `X-Forwarded-For` (nginx :
  `$proxy_add_x_forwarded_for`), pas le remplacer. `CF-Connecting-IP` n'est pas lu.
- L'ancien `TRUST_PROXY=true` est refusé au démarrage.

## 3. Démarrer le conteneur

```bash
docker compose up -d --build
docker compose logs -f lab-console       # le premier démarrage crée la base
```

`docker-compose.yml` lance l'image `lab-console:2` avec un système de fichiers
racine en lecture seule et un volume nommé `lab-console-data` sur `/data` (le
seul chemin inscriptible : base, sauvegardes, journaux, versions du schéma).
L'image fixe `NODE_ENV=production`.

**Ne publiez le port que vers le proxy.** Par défaut Compose publie
`${PORT:-3000}` sur toutes les interfaces. Liez-le à l'interface que le proxy
utilise, par exemple dans un `docker-compose.override.yml` :

```yaml
services:
  lab-console:
    ports: !override
      - "192.168.10.250:3000:3000"
```

(ou `127.0.0.1:3000:3000` si le proxy tourne sur le même hôte), et laissez le
pare-feu de l'hôte refuser ce port depuis ailleurs. Si un client atteignait
directement le conteneur, son propre `X-Forwarded-For` serait ignoré (seuls
les `TRUSTED_PROXIES` sont crus), mais il n'y a aucune raison de laisser la
porte ouverte.

Le conteneur a un contrôle de santé (`GET /api/health` répond `{"ok":true}`) ;
`docker compose ps` en montre l'état.

## 4. Le reverse proxy

Le proxy doit laisser passer les WebSockets (trois d'entre eux portent les
consoles et les mises à jour en direct), les garder ouverts des heures, ne pas
mettre en tampon, et ajouter à `X-Forwarded-For`. Avec nginx :

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    http2 on;
    server_name lab.example.org;
    # ssl_certificate / ssl_certificate_key …

    client_max_body_size 8m;                  # import de schéma jusqu'à 5 Mo, import de ZIP JOB_IMPORT_MAX_KB (2 Mo par défaut)

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

Dans Nginx Proxy Manager : cochez **Websockets Support** et **Force SSL**, et
ajoutez `proxy_read_timeout 3600s;` dans l'onglet avancé. Derrière Cloudflare,
gardez les WebSockets activés (ils le sont par défaut). Une seconde connexion
devant l'application (Cloudflare Access par exemple) n'est pas nécessaire, et
les requêtes WebSocket et API doivent toujours atteindre l'application.

Ne réécrivez ni l'en-tête `Host` ni `Origin` : l'application n'accepte une
WebSocket ou une modification que depuis `PUBLIC_URL` (et `ALLOWED_ORIGINS`).

Vérifiez depuis l'extérieur : `curl -sI https://lab.example.org/login` doit
répondre 200 avec `Strict-Transport-Security`, `X-Robots-Tag: noindex` et
`Cache-Control: no-store`, et `curl -s https://lab.example.org/api/modules` sans
session doit répondre 401, jamais des données.

## 5. Première connexion avec l'administrateur local

1. Ouvrez `https://lab.example.org/login`, ouvrez **Compte local** (l'administrateur du serveur s'y connecte) et
   tapez ensemble le nom, le mot de passe et le code à 6 chiffres actuel.
2. Ouvrez **Administration**. Les changements sensibles (paramètres du labo,
   réglages SSO, création ou promotion d'un administrateur) demandent une
   confirmation : mot de passe et code frais, clé d'accès, ou nouvelle
   connexion chez le fournisseur d'identité.
3. **Paramètres du labo** : vérifiez le serveur de rebond, la connexion aux
   consoles et les consoles autorisées ; épinglez l'empreinte si vous ne
   l'avez pas fait dans `.env`.
4. **Schéma** : remplacez le schéma livré par le vôtre (aperçu, versions,
   retour en arrière).
5. Créez les premiers comptes d'enseignants par **Invitations** (liens valables
   1 h, 24 h ou 7 jours, pour une personne ou jusqu'à 100 avec approbation), ou
   configurez d'abord le SSO.
6. Gardez l'administrateur local comme compte de secours. Connectez-vous une
   fois depuis le navigateur que vous utiliseriez en urgence (il devient un
   navigateur connu avec son propre budget de tentatives, voir AUTH.md).

## 6. Configurer le SSO depuis la page d'administration

Sans `OIDC_ISSUER` dans l'environnement, le fournisseur se règle dans
**Administration > Connexion (SSO)** et s'applique aussitôt, sans redémarrage.

1. Chez le fournisseur, créez un client avec l'URL de retour
   `https://lab.example.org/auth/callback` (la page l'affiche), le flux code
   d'autorisation et les scopes `openid profile email` plus celui qui donne les
   groupes. Recettes pour Pocket ID, Authentik, Keycloak et Authelia :
   [AUTH.md](AUTH.md).
2. Dans l'onglet SSO, renseignez le nom du bouton, l'émetteur (exactement tel
   que le fournisseur le publie), l'identifiant et le secret du client (le
   secret ne se relit pas : la page dit seulement s'il est enregistré), la
   revendication des groupes, les **groupes administrateurs** et, pour
   restreindre qui peut se connecter, les **groupes autorisés**.
3. **Tester** récupère le document de découverte. **Essayer une connexion**
   va chez le fournisseur et revient sans ouvrir de session, et montre les
   revendications reçues et le rôle qu'elles donnent.
4. Enregistrez et confirmez. Définissez `APP_SECRET` avant, sinon le secret du
   client est stocké en clair dans la base.

Si `OIDC_ISSUER` est défini dans `.env`, l'environnement l'emporte et l'onglet
est en lecture seule. Un compte SSO est administrateur quand l'un de ses
groupes est dans les groupes administrateurs, sauf si un administrateur a
imposé un rôle dans l'onglet Utilisateurs. Les groupes sont lus à la
connexion. Rendre quelqu'un administrateur, par les groupes ou par l'onglet
Utilisateurs, est une action confirmée.

## 7. Que sauvegarder

Tout ce que l'application écrit est sous `/data` dans le conteneur (le volume
`lab-console-data`). En plus : `.env` et vos propres fichiers.

| Quoi | Pourquoi | Comment |
|---|---|---|
| La **base** `lab-console.db` (avec ses fichiers `-wal` et `-shm`) | comptes, équipes, sessions, journal d'audit, réglages, index des sauvegardes et des tâches, notes, chat, scripts | copie cohérente en marche : `sqlite3 lab-console.db ".backup /sauvegarde/lab-console.db"` ; ou arrêtez le conteneur et copiez les trois fichiers. Copier le seul `.db` en marche peut manquer ce qui est encore dans le `-wal`. |
| Les **fichiers de `data/`** : `snapshots/`, `templates/`, `journal/`, `diagrams/` | sauvegardes de configuration des équipements, modèles de TP, journaux de consoles, versions du schéma : la base ne fait que les indexer | copiez tout le dossier, pris au même moment que la base (arrêt du conteneur, ou copie juste après le `.backup`) |
| `.env` (mode 600) | identifiants du rebond et des consoles, administrateur local, `APP_SECRET` | gardez-le à part de la sauvegarde des données ; sans `APP_SECRET`, les secrets chiffrés de la base sont illisibles |
| `diagrams/` et `config/` du dossier du projet | le schéma livré et la liste de départ des commutateurs d'administration | dans votre dépôt |

Avec le volume nommé, le plus simple est une archive prise conteneur arrêté :

```bash
docker compose stop lab-console
docker run --rm -v lab-console_lab-console-data:/data:ro -v "$PWD/backup":/backup alpine \
  tar czf /backup/lab-console-data-$(date +%F).tgz -C /data .
docker compose start lab-console
```

(le volume s'appelle `<dossier du projet>_lab-console-data` ; vérifiez avec
`docker volume ls`). Pour restaurer : arrêtez, extrayez dans un volume vide
(les fichiers doivent appartenir à l'uid 1000), démarrez. Essayez une
restauration une fois sur une machine de rechange avant d'en avoir besoin.

Les journaux et sauvegardes grossissent : `JOURNAL_RETENTION_DAYS`,
`JOURNAL_MAX_KB_PER_DAY` et `JOURNAL_MAX_TOTAL_MB` bornent les journaux, et les
sauvegardes se listent dans la section Sauvegardes. On dit aux étudiants de
télécharger tout de suite le ZIP d'une sauvegarde : la copie du serveur n'est
pas leur sauvegarde.

## 8. Mettre à jour et exploiter

- **Mise à jour** : sauvegardez, `git pull` (ou copiez la nouvelle version),
  lisez le CHANGELOG, puis `docker compose up -d --build`. La base migre
  toute seule au démarrage. Revenir à une image plus ancienne après une
  migration n'est pas pris en charge : restaurez la sauvegarde d'avant.
- **Sessions** : elles survivent à un redémarrage (elles sont dans la base).
  Changer les identifiants de l'administrateur local met fin à ses sessions.
- **Journaux** : `docker compose logs`. Les erreurs montrées aux utilisateurs
  ne contiennent ni version ni trace ; le détail est dans le journal. Ajoutez
  une section `logging` au compose si l'hôte garde les journaux sans limite.
- **Page d'état** : Administration > État du labo montre le serveur de rebond,
  les serveurs de consoles, les lignes ouvertes et la taille des journaux.
- **Changer un secret** : nouveau mot de passe de l'administrateur local :
  `npm run setup-admin` de nouveau, remplacez les trois lignes, redémarrez.
  Nouvel `APP_SECRET` : définissez-le, redémarrez, puis ressaisissez le secret
  du client SSO et les mots de passe du labo.
- **Verrouillage** : si plus personne ne peut se connecter, l'administrateur
  local le peut encore (mot de passe + code). Téléphone perdu : relancez
  `setup-admin`.
- **Avant le premier vrai cours** : les vérifications de pré-production
  listées dans [SPEC.md](../v2/SPEC.md) (effacement et rechargement sur IOS XE,
  cinq lignes de tâche à la fois, familles de récupération de mot de passe,
  BREAK à travers le serveur de consoles) ne se règlent pas avec le
  simulateur : faites-les sur le vrai matériel.
