# Lab Console

[English](README.md) · **Français**

Version 2.0.0. Accès par le navigateur au matériel physique du labo d'un cours
de réseaux. Choisissez une baie, cliquez sur un routeur ou un commutateur de
son schéma, et sa console s'ouvre dans un terminal à côté du schéma.
Ouvrez-en plusieurs à la fois pour configurer des équipements côte à côte.

```
Navigateur ──WebSocket──► Lab Console ──SSH (exec)──► serveur de rebond ──telnet──► serveur de consoles ──► équipement
```

## Ce que fait l'application

- **Consoles** : chaque équipement du schéma du labo s'ouvre comme une console
  texte dans le navigateur. Une ligne de console appartient au serveur :
  plusieurs personnes peuvent la rejoindre, une seule tape (le pilote), les
  autres regardent, et le clavier se passe sur demande.
- **Équipes et baies** : les étudiants forment des équipes, prennent une baie,
  invitent des invités et réservent des créneaux. Une baie tenue par une
  équipe n'est pilotée que par ses membres.
- **Tâches de baie** : sauvegarde de tous les équipements d'une baie,
  injection d'un script, remise à la configuration de base, comparaison de
  sauvegardes ; modèles de TP publiés par les enseignants.
- **Vérifications et récupération de mot de passe** : état des lignes,
  câblage, matrice de ping et adresses des interfaces ; récupération guidée
  d'un équipement verrouillé par un mot de passe.
- **Travail en groupe** : une note par équipement, un chat par baie, une
  bibliothèque de scripts, des notifications du navigateur, le journal des
  consoles.
- **Comptes et administration** : connexion unique par votre fournisseur
  d'identité (OpenID Connect), comptes locaux par invitation, clés d'accès,
  administrateur local obligatoire, journal d'audit, sessions, paramètres du
  labo, versions du schéma, annonces, page d'état.
- **Infrastructure** (administrateurs seulement) : commutateurs
  d'administration et machines virtuelles Proxmox, joints par le serveur de
  rebond.
- Tout est en français et en anglais, et la page **Aide** de l'application
  explique chaque section aux étudiants.

## Documentation

| Pour | Français | English |
|---|---|---|
| Étudiants et enseignants | [Guide étudiant](docs/fr/ETUDIANTS.md) | [Student guide](docs/STUDENTS.md) |
| Mise en ligne (reverse proxy, HTTPS, sauvegardes) | [docs/fr/DEPLOY.md](docs/fr/DEPLOY.md) | [docs/DEPLOY.md](docs/DEPLOY.md) |
| Connexion, SSO, administrateur local | [docs/fr/AUTH.md](docs/fr/AUTH.md) | [docs/v2/AUTH.md](docs/v2/AUTH.md) |
| Tous les paramètres | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) (en anglais, générée depuis `.env.example`) | idem |
| Ce qui a changé | [CHANGELOG.fr.md](CHANGELOG.fr.md) | [CHANGELOG.md](CHANGELOG.md) |
| Développeurs | [docs/v2/ARCHITECTURE.md](docs/v2/ARCHITECTURE.md), [SPEC.md](docs/v2/SPEC.md), [TESTING.md](docs/v2/TESTING.md) (en anglais) | |

## Démarrage rapide (Docker)

```bash
cp .env.example .env        # Windows : Copy-Item .env.example .env
# éditez .env : PUBLIC_URL, SSH_* (serveur de rebond) et TELNET_* (connexion au serveur de consoles)
npm run setup-admin         # affiche les trois lignes LOCAL_ADMIN_* : collez-les dans .env
docker compose up -d --build
```

Ouvrez http://localhost:3000 et connectez-vous avec l'administrateur local
(nom, mot de passe et code à 6 chiffres de votre application d'authentification).

L'image Docker tourne avec `NODE_ENV=production`, qui exige
`SSH_HOST_FINGERPRINT` (l'identité du serveur de rebond) : sans elle, aucune
console ne se connecte. Obtenez-la avec
`ssh-keyscan -t ed25519 <serveur de rebond> | ssh-keygen -lf -`. Avant de
mettre l'application sur Internet, lisez [docs/fr/DEPLOY.md](docs/fr/DEPLOY.md).

Sans Docker (Node.js 22.13 ou plus récent) :

```bash
npm ci
npm run setup-admin
npm start
```

### Démarrage rapide avec le labo simulé (Docker)

Pas de labo sous la main ? `docker-compose.mock.yml` lance un faux serveur de
rebond et de faux équipements à côté de l'application :

```bash
cp .env.example .env
npm run setup-admin         # collez les trois lignes LOCAL_ADMIN_* dans .env
# dans .env :  PUBLIC_URL=http://localhost:3000
#              SSH_HOST=mock-lab  SSH_PORT=2222  SSH_USERNAME=lab  SSH_PASSWORD=lab
#              TELNET_USERNAME=  TELNET_PASSWORD=
docker compose -f docker-compose.yml -f docker-compose.mock.yml up -d --build
```

Les commentaires de `docker-compose.mock.yml` donnent les détails. C'est un
outil de démonstration : la clé d'hôte du simulateur change à chaque démarrage,
l'application y tourne donc avec `NODE_ENV=development` (pas d'épinglage de la
clé d'hôte). Jamais avec de vrais comptes. (Ce fichier a été écrit sans moteur
Docker : s'il échoue, lancez les deux programmes sur l'hôte comme décrit
ci-dessous.)

## Configuration

Tout se règle par variables d'environnement, lues dans `.env` :
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) les liste toutes avec leur
valeur par défaut et leur description (en anglais). Elle est générée depuis
les commentaires de `.env.example` (`npm run gen-config-doc` ; un test échoue
si les deux divergent). Les réglages qui comptent d'abord : `PUBLIC_URL`,
`TRUSTED_PROXIES`, `LOCAL_ADMIN_*`, `SSH_*` avec `SSH_HOST_FINGERPRINT`,
`TELNET_*`, `ALLOWED_CONSOLE_HOSTS`, `APP_SECRET`.

## Passer de la v1 à la v2

Lab Console 2 est une autre application pour le même usage : prévoyez une
migration, pas un simple remplacement.

- **La connexion est obligatoire.** La v1 n'en avait pas (elle comptait sur un
  proxy devant). La v2 refuse de démarrer tant que `LOCAL_ADMIN_USERNAME`,
  `LOCAL_ADMIN_PASSWORD_HASH` et `LOCAL_ADMIN_TOTP_SECRET` ne sont pas
  renseignés : lancez `npm run setup-admin` et collez ses trois lignes dans
  `.env`. Le fournisseur d'identité (`OIDC_*`) est facultatif.
  `TRUST_PROXY=true` est refusé au démarrage : remplacez-le par
  `TRUSTED_PROXIES` (listez chaque relais) et renseignez `PUBLIC_URL` (https
  derrière un proxy).
- **Il y a désormais un dossier de données.** La v1 ne conservait rien. La v2
  garde son état dans `DATA_DIR` (`./data` par défaut ; `/data` dans l'image
  Docker, volume nommé `lab-console-data` dans `docker-compose.yml`, le
  système de fichiers racine étant en lecture seule) : la base SQLite
  `lab-console.db` (comptes, équipes, sessions, journal d'audit, réglages,
  tâches, notes…) et des fichiers (sauvegardes, modèles, journaux de
  consoles, versions du schéma). Un dossier monté depuis l'hôte doit être
  accessible en écriture à l'uid 1000. Sauvegardez-le : voir
  [docs/fr/DEPLOY.md](docs/fr/DEPLOY.md).
- **La base est créée au premier démarrage** et migrée toute seule aux
  suivants. Les fichiers des premières versions de la v2 (`auth/*.json`,
  `audit/*.jsonl`) sont importés une fois puis renommés `*.imported`. Il n'y a
  rien à importer depuis la v1.
- **Le schéma.** `diagrams/diagram.drawio` est copié vers
  `DATA_DIR/diagrams/current.drawio` au premier démarrage, et cette copie est
  le schéma actif ensuite : remplacez-le depuis Administration > Schéma
  (aperçu, versions, retour en arrière). Modifier le fichier sur l'hôte ne
  change plus une plateforme en marche.
- **Clé d'hôte du serveur de rebond.** En production (l'image Docker), elle
  doit être épinglée par `SSH_HOST_FINGERPRINT` ou sur la page des paramètres
  du labo, sinon aucune console ne se connecte (`consoles.ssh_unpinned`).
- **Paramètres du labo** (serveur de rebond, connexion aux consoles, consoles
  autorisées) : modifiables depuis l'administration sans redémarrage ;
  renseignez `APP_SECRET` (32 caractères ou plus) pour stocker leurs mots de
  passe chiffrés.
- **Transport du tunnel Proxmox.** Le tunnel vers l'API Proxmox passe toujours
  par le serveur de rebond, avec `PROXMOX_TUNNEL_TRANSPORT=auto` par défaut
  (redirection TCP, puis une commande de relais comme `socat`, `nc` ou bash
  `/dev/tcp` quand le serveur de rebond interdit la redirection ; `forward` et
  `exec` en imposent un). Les machines virtuelles de la section Infra sont
  désormais réservées aux administrateurs ; les commutateurs d'administration
  restent ouverts à tous.
- **Noms et étiquettes.** L'image s'appelle `lab-console:2`. Les réglages de
  la v1 gardent leur sens ; les nouveaux ont une valeur par défaut (voir la
  référence ci-dessus).

## L'essayer sans le labo

`dev/mock-lab.js` lance un faux serveur de rebond SSH dont les équipements
répondent comme des consoles Cisco IOS et IOS XE (`dev/fakeIos.js` : mot de
passe enable, modes de configuration, `show running-config` avec sa
pagination, VLAN, effacement et rechargement avec démarrage et dialogue de
configuration initiale…). Chaque port de console garde son équipement tant que
le faux labo tourne, n'accepte qu'une session à la fois comme un vrai serveur
de consoles, et n'affiche rien avant un appui sur Entrée.

```bash
# dans .env
SSH_HOST=127.0.0.1
SSH_PORT=2222
npm run mock-lab     # terminal 1
npm start            # terminal 2
```

Pour essayer aussi le fournisseur d'identité, `npm run mock-oidc` en démarre
un faux sur `http://127.0.0.1:9100`, avec un sélecteur d'utilisateur (trois
étudiants, un administrateur), et affiche les lignes `OIDC_*` à mettre dans
`.env`. N'importe qui peut s'y connecter sous n'importe quel nom : c'est un
outil de développement, qui refuse de démarrer avec `NODE_ENV=production`.
Une pile Docker de préproduction peut l'utiliser avec
`docker-compose.preprod.yml` (docs/fr/AUTH.md §6).

`MOCK_DOWN_PORTS=2003` simule une console débranchée, `MOCK_BUSY_PORTS=2004`
une ligne tenue en dehors de l'application.
`MOCK_LOGIN_PORTS=2001` simule un serveur de terminaux qui affiche `login:`
aussitôt et raccroche sur un identifiant vide.
`MOCK_MODELS=2001=2811,2002=c9300l` choisit le modèle par port de console
(par défaut : 2811 pour les noms qui commencent par R, 2960 sinon),
`MOCK_STATES=2005=linepass,2006=dialog,2007=rommon,2008=silent` l'état dans
lequel une console démarre, `MOCK_ENABLE_SECRET` un mot de passe enable pour
tous les équipements, `MOCK_TIME_SCALE=0.02` la vitesse de démarrage des
équipements.
Les équipements sont câblés comme le schéma les dessine (CDP, état des lignes
et ping suivent les câbles) ; `MOCK_CABLING=unplug:2016/Fa0/1;move:2016/Fa0/2>Fa0/9`
crée des pannes volontaires pour la vérification du câblage. Pour essayer la
récupération de mot de passe, la personne sur place se joue depuis un shell :
`ssh -p 2222 <user>@127.0.0.1 mock-power 10.22.9.211 2001` éteint et rallume
l'équipement (ajoutez `mode` pour maintenir le bouton Mode d'un commutateur).

## Le schéma

`diagrams/diagram.drawio` est le schéma livré avec la plateforme ; au premier
démarrage il est copié vers `DATA_DIR/diagrams/current.drawio`, qui est le
schéma actif ensuite. Chaque page est un labo. Remplacez le schéma actif
depuis Administration > Schéma (aperçu des changements, versions, retour en
arrière) ; la plateforme le recharge en quelques secondes, sans redémarrage.

Une forme devient un équipement cliquable quand :

1. son étiquette contient la référence de console, comme dans les schémas
   actuels : `R1` sur la première ligne, `.211 - 2001` sur la seconde
   (→ `CONSOLE_NETWORK_PREFIX.211`, port 2001 ; une IP complète comme
   `10.22.9.211 - 2001` fonctionne aussi), ou
2. elle porte des données (draw.io › clic droit › *Modifier les données*) :
   `console_host` et `console_port`. Cela l'emporte sur l'étiquette.

Vérifiez un schéma avant de le déployer :

```bash
npm run check-diagram                     # ou : npm run check-diagram -- autre.drawio
```

La commande liste chaque équipement par labo et signale les lignes de console
utilisées par deux équipements différents (code de sortie 1). Le fichier
actuel en a une : sur **B5H, R4 et S1 pointent tous deux vers
`.212 - 2005`**. Les équipements qui figurent sur plusieurs pages avec le même
nom et la même console (S5, R5) sont traités comme du matériel partagé.

Les noms de page comme `B4H / B4M / B4B` s'affichent en élévation de baie
(baie 4, haut/milieu/bas). Tout autre nommage donne de simples onglets.

## Modèle de sécurité

- **Le navigateur ne choisit jamais où se connecter.** Il envoie une clé
  d'équipement du schéma ; le serveur retrouve l'hôte et le port dans sa
  propre copie du fichier et les confronte à `ALLOWED_CONSOLE_HOSTS` et
  `ALLOWED_PORT_RANGE`.
- **Pas de shell sur le serveur de rebond.** Chaque terminal est un `exec` SSH
  de `telnet <hôte> <port>` ; quand telnet se termine, le canal SSH aussi.
- **Pas d'échappement `telnet>`.** `Ctrl+]` est retiré de la saisie des
  étudiants : le mode commande de telnet (qui peut lancer un shell avec `!`)
  est inatteignable. Le bouton *Envoyer BREAK* est le seul usage côté serveur.
- **Les identifiants restent sur le serveur.** La connexion automatique ne
  répond qu'à la première invite Username/Password d'une ligne, une fois, dans
  les 30 s, et s'arrête dès qu'une invite d'équipement apparaît. Les mots de
  passe `enable` ne sont jamais envoyés.
- **Un clavier par ligne de console.** Une ligne appartient au serveur :
  quiconque ouvre l'équipement la rejoint et voit la même sortie ; une
  personne tape (le pilote), les autres regardent ; le clavier passe sur
  demande (le pilote répond, ou après 30 s, ou aussitôt si le pilote est
  inactif depuis 2 min). Les touches d'un spectateur sont jetées par le
  serveur. Les lignes se ferment 30 s après le départ de la dernière personne
  ou après `IDLE_TIMEOUT_MINUTES` sans saisie ; des limites par utilisateur et
  globales, et une limite de débit sur l'ouverture des consoles, s'appliquent.
- **Journal des consoles.** Ce que les équipements affichent (jamais les
  frappes) est conservé `JOURNAL_RETENTION_DAYS` jours, avec qui tenait le
  clavier, session par session. La lecture couvre toute la journée d'une
  console : seulement les personnes qui y étaient ce jour-là, les équipes qui
  tenaient sa baie ce jour-là et les administrateurs. Plafonné par équipement
  et par jour (`JOURNAL_MAX_KB_PER_DAY`) et au total (`JOURNAL_MAX_TOTAL_MB` :
  les plus anciens jours partent d'abord).
- **La règle de la baie à chaque touche.** Sur une baie tenue par une équipe,
  seuls ses membres, leurs invités acceptés et les administrateurs ouvrent ou
  pilotent ses consoles ; tout le monde peut regarder une ligne déjà ouverte.
  La règle est redemandée à chaque frappe : une baie verrouillée retire le
  clavier immédiatement.
- **Travail en groupe.** Une note partagée par équipement (tout le monde la lit
  sur le schéma, les occupants de la baie et les administrateurs l'écrivent ;
  deux personnes qui enregistrent en même temps en sont averties, rien n'est
  écrasé en silence) ; un petit chat texte par baie pour ses occupants,
  conservé avec l'équipe qui tient la baie (200 messages, débit limité) ; et
  des notifications du navigateur, activées par la cloche du rail, pour une
  demande de clavier, une ligne devenue libre et une tâche terminée,
  affichées seulement quand la fenêtre n'est pas au premier plan.
- **Peu de connexions SSH.** Les lignes de console partagent des connexions
  vers le serveur de rebond, `SSH_CHANNELS_PER_CONNECTION` chacune (restez
  sous le `MaxSessions` de sshd).
- Les WebSockets n'acceptent que l'origine propre à la plateforme
  (`ALLOWED_ORIGINS` en ajoute d'autres : utile quand le site est joint sous
  une autre adresse, par exemple derrière un proxy). L'interface est
  entièrement auto-hébergée sous une Content-Security-Policy stricte.
- Renseignez `SSH_HOST_FINGERPRINT` pour épingler l'identité du serveur de
  rebond (ou saisissez-la dans la page des paramètres du labo). Sous
  `NODE_ENV=production` (l'image Docker), elle est obligatoire : sans elle
  aucune console ne se connecte (`consoles.ssh_unpinned`) et le journal montre
  l'empreinte que voit le serveur ; ailleurs elle est seulement journalisée.

Recommandé sur le serveur de rebond : un compte dédié qui ne peut lancer que
telnet, par exemple avec `ForceCommand` dans `sshd_config` ou un shell
restreint.

**Tout exige un utilisateur connecté** : pages, API, événements en direct et
les trois WebSockets de console. Les personnes se connectent par votre
fournisseur d'identité (OpenID Connect : Pocket ID, Authentik, Keycloak,
Authelia…), et un administrateur local (mot de passe + code à usage unique)
existe toujours pour le cas où le fournisseur est en panne. Il n'existe aucun
mode sans connexion : la plateforme refuse de démarrer tant que `LOCAL_ADMIN_*`
n'est pas renseigné (`npm run setup-admin`). Configuration :
[docs/fr/AUTH.md](docs/fr/AUTH.md).

Derrière un reverse proxy, listez chaque saut dans `TRUSTED_PROXIES` (adresses
IP ou blocs CIDR ; derrière un CDN, ses plages publiées aussi) pour que les
adresses des clients soient lues dans `X-Forwarded-For` ; l'en-tête est ignoré
quand il vient de quelqu'un d'autre. Le `TRUST_PROXY=true` d'origine est
refusé au démarrage. L'état n'est écrit que dans `DATA_DIR` : l'état structuré
(sessions, journal d'audit, paramètres, comptes, équipes, baies,
réservations…) dans une base SQLite, `DATA_DIR/lab-console.db` ; les documents
(journaux de consoles, versions du schéma, sauvegardes de configuration et
modèles de TP) sous forme de fichiers. L'image Docker tourne avec un système
de fichiers racine en lecture seule et un volume sur `/data`. Les fichiers
écrits par les premières versions 2 sont importés dans la base au premier
démarrage et conservés sous le nom `*.imported`.

## Équipes, comptes et administration (v2)

- **Équipes et baies** (section Équipe, barre de baie au-dessus du schéma) :
  un étudiant crée une équipe et invite ses camarades par nom d'utilisateur ;
  un membre prend une baie libre pour l'équipe ; les autres demandent à la
  rejoindre ; les baies inactives sont libérées après `BENCH_IDLE_HOURS` ; les
  administrateurs verrouillent une baie en donnant un motif ; un calendrier de
  réservation par baie prévient avant le créneau d'une autre équipe. Une
  équipe compte au plus `TEAM_MAX_MEMBERS` membres (8 par défaut), invitations
  non répondues comprises.
- **Comptes** : comptes locaux créés par liens d'invitation (à usage unique,
  ou pour plusieurs personnes avec approbation), liens de réinitialisation de
  mot de passe créés par un administrateur, clés d'accès (obligatoires pour
  les administrateurs promus, connexion en un clic), rôles et états pour les
  comptes locaux et SSO, Mon compte, page des paramètres SSO.
- **Administration** : paramètres du labo (serveur de rebond, connexion aux
  consoles, consoles autorisées) appliqués sans redémarrage et reconfirmés
  avant l'enregistrement (mot de passe + code, une clé d'accès, ou une
  nouvelle connexion chez le fournisseur d'identité, qui confirme la session
  pendant 5 minutes) ; import de schéma avec aperçu, versions et retour en
  arrière ; commutateurs d'administration ; sessions ; journal d'audit
  (filtrable par personne, nom ou identifiant) ; bandeau d'annonce. **État du
  labo** pour tout le monde : santé du serveur de rebond, des serveurs de
  consoles, des lignes ouvertes et des connexions SSH partagées, total des
  journaux, et ce qui est enregistré.

## Tâches de baie, outils de console et travail en groupe (v2, vague 3)

- **Sauvegardes** (section Sauvegardes, `#/jobs/<baie>`) : des tâches qui
  couvrent les équipements d'une baie et tournent sur le serveur, suivies en
  direct par tous et annulables. Une **sauvegarde** (running-config, VLAN et
  VTP sur les commutateurs, modèle et version, cinq équipements à la fois) est
  un instantané appartenant à l'équipe qui tenait la baie : liste, lecture,
  différences (deux instantanés, ou un instantané contre les équipements en
  direct), recherche, téléchargement et import en ZIP. Le serveur n'est pas une
  sauvegarde : téléchargez tout de suite le ZIP qu'il propose. Une **injection**
  montre le script exact de chaque équipement avant de démarrer (« réinitialiser
  puis injecter » ou « fusionner »), puis relit l'équipement et compare. Une
  **réinitialisation** dit ce qui est effacé et qui est sur les consoles,
  exige la saisie du nom de la baie et décompte ; un équipement n'est jamais
  effacé sans sauvegarde vérifiée. Les administrateurs publient des **modèles
  de TP** (l'un peut être la configuration de base appliquée après une
  réinitialisation), qu'ils créent à la main, à partir d'une sauvegarde, ou en
  important un ZIP ; le **dossier de TP** est un ZIP d'un instantané et des
  journaux de console de son jour. Seuls Cisco IOS / IOS XE sont touchés.
  Libérer une baie depuis la barre de baie propose à son équipe une sauvegarde
  pendant 30 minutes. Paramètres : `JOB_DEVICES_AT_ONCE`,
  `JOB_COUNTDOWN_SECONDS`, `JOB_IMPORT_MAX_KB`, `JOB_TIME_SCALE`.
- **Outils de console** : un collage de plusieurs lignes est envoyé au rythme
  d'une injection, ligne par ligne ; **envoyer à plusieurs consoles** envoie
  les mêmes lignes à chaque console que la personne pilote et coche ;
  l'**historique** cherche ce qu'une console a affiché (son écran en direct et
  les journées de journal que la personne peut lire) et le télécharge ; une
  **bibliothèque de scripts** avec des étagères personnelle, d'équipe et
  publiée alimente les fenêtres d'injection et d'envoi.
- **Travail en groupe** : une note partagée par équipement, un chat par baie
  pour ses occupants, et des notifications du navigateur, dont « la tâche de
  votre baie est terminée » (voir le modèle de sécurité plus haut).

## Vérifications, récupération de mot de passe, accueil et aide (v2, vague 4)

- **Accueil** (`#/home`, la page après la connexion) : mon équipe, les
  invitations qui m'attendent, notre baie, nos cinq dernières sauvegardes,
  l'activité de la baie depuis que notre équipe l'a prise, nos prochains
  créneaux, le labo en chiffres, l'annonce. **Vue d'ensemble** (`#/overview`) :
  une carte en direct par baie pour tout le monde (équipe, occupants, consoles
  ouvertes et pilotes, tâche en cours, verrou, prochains créneaux, lignes de
  console, avec le dernier état des lignes tant qu'il est récent). Les deux
  sont des vues en lecture seule des services existants.
- **Vérifications** (bouton au-dessus du schéma, occupants et administrateurs) :
  état des lignes (libre, occupée hors application, équipement muet), câblage
  (CDP confronté aux liens du schéma : manquant, mauvais port, inattendu),
  matrice de ping entre les routeurs, et adresses et état des interfaces,
  présentés dans un rapport et sur le schéma. Commandes en lecture seule
  uniquement ; une ligne de console utilisée n'est jamais touchée ; une
  vérification à la fois par baie, jamais pendant une tâche ; le dernier
  résultat de chaque sorte est conservé.
- **Récupération de mot de passe** (un bouton sur la tuile d'une console du
  labo) : une procédure guidée BREAK / ROMMON / registre de configuration (ou
  le chargeur de démarrage du commutateur) pour un équipement verrouillé par
  un mot de passe que personne ne connaît, avec quelqu'un sur place pour
  l'éteindre et le rallumer. La startup-config n'est contournée que pour un
  démarrage, jamais effacée ; tout arrêt remet d'abord l'équipement en état.
  Pas encore essayée sur le matériel réel, et le navigateur le dit.
- **Aide** (`#/help`) : ce que fait chaque section, en français et en anglais,
  et une visite guidée à la première connexion (rejouable depuis le menu
  utilisateur).
- Paramètres : aucun en propre ; les budgets de temps des vérifications et de
  la récupération suivent `JOB_TIME_SCALE`.

## Outils de console (v1.1)

Chaque tuile de console texte a deux boutons de plus dans son en-tête :

| Bouton | Où | Ce qu'il fait |
|---|---|---|
| **Exporter la config** (icône de téléchargement) | équipements du labo et commutateurs d'administration | Enregistre `show running-config` sous `<hostname>_running-config_<date>.txt` |
| **Injecter un script** (icône de script) | équipements du labo, commutateurs d'administration, consoles série de VM | Envoie une liste de commandes, collée ou chargée depuis un fichier `.txt`, ligne par ligne |

Les deux s'exécutent **sur le serveur**, à côté du flux SSH → telnet
(`src/lib/cliAutomation.js`). Les navigateurs ralentissent les minuteurs des
onglets en arrière-plan à environ un par seconde : un rythme tenu par le
navigateur casserait dès que vous changez d'onglet. Pendant qu'une tâche
tourne, la tuile affiche sa progression et un bouton **Arrêter**, et vos
propres frappes sont retenues pour ne pas se mêler aux commandes automatiques.

**Exporter la config** (Cisco) :
1. Appuie sur Entrée pour lire l'invite et le nom d'hôte.
2. Quitte le mode de configuration avec `end` si besoin.
3. S'arrête si l'équipement est en mode utilisateur (`R1>`) et demande de
   faire `enable` d'abord.
4. Envoie `terminal length 0`, puis capture `show running-config` jusqu'au
   retour de `R1#`.
5. Rétablit `terminal length 24`.

Si un équipement ignore `terminal length`, chaque `--More--` reçoit une
espace à la place. Les lignes de syslog qui apparaissent pendant la capture
sont retirées.

**Injecter un script** :
- Une commande par ligne, envoyée comme le ferait un humain soigneux :
  - chaque ligne est tapée par blocs de 32 octets, si bien qu'une longue
    `description` ne déborde jamais le petit tampon d'entrée d'une console ;
  - la ligne suivante attend l'invite de l'équipement, ou une question comme
    `[confirm]` ou `Destination filename [startup-config]?` ;
  - puis un délai configurable (50 ms par défaut).
- Les lignes vides sont envoyées comme Entrée, ce qui permet à un script de
  répondre à ces questions.
- Les blocs `banner motd #…#` de plusieurs lignes sont gérés.
- Les lignes qui commencent par `!` sont ignorées (en option).
- Les erreurs de l'équipement (`% Invalid input…`) sont listées avec leurs
  numéros de ligne dans le script. Le script peut en option s'arrêter à la
  première.

Pour voir pourquoi le rythme compte, lancez le faux labo avec
`MOCK_SLOW_CONSOLE=1`. Il simule un vieil équipement : environ 1 caractère par
ms, un tampon d'entrée de 64 octets, et 40 ms par commande. Les tests
unitaires montrent qu'un simple collage d'un script de 60 lignes perd plus de
1 000 caractères, alors que l'injection rythmée fait passer chaque ligne
intacte.

## Alimentation des VM en masse (v1.1)

Dans **Infra › Machines virtuelles** :
- Cochez des VM, ou la case de l'en-tête pour sélectionner toutes les VM
  affichées (le filtre s'applique).
- **Démarrer la sélection** démarre celles qui sont arrêtées ; **Arrêter la
  sélection** éteint celles qui tournent (arrêt ACPI propre, après
  confirmation).
- Les requêtes partent 4 à la fois, et la progression apparaît dans la liste
  des tâches.
- La sélection survit à l'actualisation automatique.

## Section Infrastructure

L'entrée **Infra** de la barre latérale est ouverte à tout le monde, comme les
consoles du labo.

- **Machines virtuelles** (administrateurs seulement : les autres voient que
  l'onglet est réservé, et l'API et les deux consoles de VM leur répondent
  403) : chaque VM Proxmox, avec :
  - **Démarrer / Arrêter / Forcer l'arrêt** (Arrêter demande à l'invité de
    s'éteindre ; Forcer l'arrêt coupe l'alimentation) ;
  - **Série** (console texte dans xterm.js, pour les VM avec un port série) et
    **VNC** (console graphique) ;
  - l'**étiquette VLAN de net0** : saisissez un numéro et appuyez sur Entrée,
    ou laissez vide pour non étiqueté. L'adresse MAC et les autres options de
    la carte sont conservées ;
  - **Cloner un modèle** : modèle, nom, nœud, VLAN. Un clone complet, avec la
    progression en direct.
- **Commutateurs d'administration** : les commutateurs de
  `config/infrastructure.json`, ou la liste qu'un administrateur a modifiée
  (conservée dans la base). Leurs consoles passent par la même chaîne serveur
  de rebond → telnet que les équipements du labo.

Toutes les consoles partagent un seul espace de travail : un commutateur
d'administration et un écran de VM peuvent être côte à côte, et ils restent
ouverts quand vous changez de section.

### Comment Proxmox est joint : par le serveur de rebond

```
plateforme ──SSH──► serveur de rebond ──direct-tcpip──► 10.22.9.20:8006 (Proxmox)
           connexion(s) partagée(s), un canal léger par socket HTTPS / console
```

- La plateforme garde une connexion SSH partagée vers le serveur de rebond pour
  Proxmox (`src/lib/sshTunnel.js`). Chaque requête HTTPS et chaque WebSocket de
  console est un canal SSH dessus, avec TLS de bout en bout jusqu'à Proxmox à
  l'intérieur.
- Les sockets HTTPS sont maintenues ouvertes, et au plus 6 requêtes d'API
  tournent en même temps : lister 20 VM réutilise une poignée de canaux.
- Si le serveur de rebond coupe la connexion, elle est rouverte au prochain
  appel.

**Deux transports (`PROXMOX_TUNNEL_TRANSPORT`, `auto` par défaut).** La façon
dont le tunnel traverse le serveur de rebond ; les consoles d'équipements ne
sont pas concernées :

- `forward` : un canal `direct-tcpip` (comme `ssh -L`). Le plus léger ; une
  seule connexion porte tout. Exige `AllowTcpForwarding` sur le serveur de
  rebond.
- `exec` : le serveur de rebond lance un relais (`socat`/`nc`/bash `/dev/tcp`)
  qui se connecte à Proxmox, et la plateforme parle TLS sur ses entrées-sorties.
  C'est le **même** mécanisme que celui des consoles d'équipements : il
  fonctionne donc même quand le transfert est désactivé. Chaque relais est un
  canal de *session*, qui compte dans le `MaxSessions` de sshd ; le pool répartit
  les rafales sur quelques connexions.
- `auto` (par défaut) : essaie `forward` et, la première fois que le serveur de
  rebond répond *administratively prohibited / open failed*, passe à `exec`
  pour le reste de l'exécution et le journalise une fois. Un serveur de rebond
  verrouillé est surmonté sans configuration.

Si le transfert est autorisé, restreignez-le à Proxmox :
  ```
  Match User labjump
      PermitOpen 10.22.9.20:8006
  ```
**Dépannage de `open failed` / `administratively prohibited` :** le sshd du
serveur de rebond interdit le transfert TCP pour ce compte
(`AllowTcpForwarding no`, `DisableForwarding`, un `PermitOpen` qui ne
correspond pas, ou `restrict` / `no-port-forwarding` dans `authorized_keys`).
Un `curl -k` lancé *depuis* le rebond fonctionne quand même, car il part de la
machine elle-même. Rétablissez le transfert pour le compte, ou laissez
`PROXMOX_TUNNEL_TRANSPORT=auto` (ou mettez `exec`) et la plateforme relaie par
une commande, qui n'exige que `socat`, `nc`/`ncat` ou bash sur le serveur de
rebond. Après un changement de configuration sshd du rebond, **redémarrez Lab
Console** pour que le tunnel se reconnecte avec la nouvelle politique.
- L'authentification est un **ticket** nom d'utilisateur/mot de passe, renouvelé
  avant l'expiration de 2 heures de Proxmox et à chaque 401. Aucun identifiant,
  ticket ou mot de passe VNC de Proxmox n'atteint le navigateur :
  - pour **VNC**, la plateforme fait elle-même l'échange du mot de passe VNC
    avec Proxmox ;
  - pour **Série**, elle traduit le protocole `termproxy` de Proxmox vers le
    sien.

### Consoles série

Une VM a besoin d'un port série pour **Série** : `qm set <vmid> -serial0 socket`
et, dans un invité Linux, `systemctl enable --now serial-getty@ttyS0`. Ajoutez
le port à vos modèles pour que chaque clone l'ait. **VNC** fonctionne sur
toutes les VM.

### L'essayer sans Proxmox

```bash
npm run mock-lab       # faux serveur de rebond ; redirige aussi 10.22.9.20:8006 vers le faux Proxmox
npm run mock-proxmox   # faux Proxmox sur 127.0.0.1:8006 ; affiche PROXMOX_FINGERPRINT=…
```

Dans `.env`, mettez `PROXMOX_URL=https://10.22.9.20:8006` (oui, l'adresse du
labo) et l'empreinte affichée. Le faux serveur de rebond est le seul chemin
vers cette adresse, exactement comme au labo.

## Organisation du projet

```
src/
  server.js                 point d'entrée HTTP + WebSocket, monte les modules
  config.js                 chargement et validation de .env
  lib/                      journal, concentrateur SSE, sécurité, options SSH + tunnel SSH partagé,
                            automatisation de la CLI (export de config, injection rythmée), paramètres, schémas
  lib/db/                   la base : adaptateur SQLite, migrations, dépôts, import des anciens fichiers
  lib/drivers/ciscoIos.js   procédures Cisco IOS / IOS XE : préparer, identifier, sauvegarder,
                            effacer et recharger, rejouer un script
  lib/drivers/ciscoRecovery.js  procédures de récupération de mot de passe par famille d'équipement
  modules/
    index.js                registre des modules
    auth/                   connexion : sessions, OpenID Connect, administrateur local + TOTP
    consoles/               consoles du labo : lecteur de schéma, registre, salles partagées, journal, pool SSH
    teams/                  équipes, occupation des baies, verrous, réservations
    accounts/               annuaire, invitations, liens de réinitialisation, clés d'accès, paramètres SSO
    admin/                  paramètres du labo, confirmation, santé, annonces
    jobs/                   tâches de baie (sauvegarde, injection, réinitialisation, comparaison), instantanés, modèles de TP
    scripts/                bibliothèque de scripts partagée (personnels, d'équipe, publiés)
    collab/                 notes d'équipement, chat de baie
    checks/                 état des lignes, câblage (CDP), matrice de ping, interfaces (migration 015)
    recovery/               récupération guidée de mot de passe (migration 016)
    overview/               accueil et vue d'ensemble de chaque baie (lecture seule, sans table)
    help/                   visite guidée, page d'aide, avancement de la visite (migration 017)
    proxmox/                client Proxmox (ticket, par le tunnel SSH), service, relais de consoles
public/
  index.html, css/app.css
  js/main.js                coque : barre latérale, routage, thème
  js/core/                  outils DOM, API + événements en direct
  js/modules/consoles/      rendu du schéma, espace de terminaux, sélecteur de labo, recherche
  js/shared/                espace de travail (commun à toutes les sections), volets terminal + VNC, découpage
  js/modules/infra/         section Infrastructure : VM, fenêtre réseau, commutateurs d'administration
  js/modules/jobs/          section Sauvegardes : tâches, instantanés, modèles, couche du schéma
  js/modules/collab/        notes d'équipement, panneau de chat de baie, notifications du navigateur
  js/modules/checks/        fenêtre des vérifications et couches du schéma (pastilles de ligne, câblage, adresses)
  js/modules/recovery/      l'assistant de récupération (bouton de tuile de console) et sa pastille sur le schéma
  js/modules/overview/      sections Accueil et Vue d'ensemble
  js/modules/help/          visite guidée et section Aide
scripts/check-diagram.js    vérificateur de schéma
scripts/gen-config-doc.js   construit docs/CONFIGURATION.md depuis .env.example
docs/                       DEPLOY, STUDENTS, CONFIGURATION (générée), fr/ (français), v2/ (architecture, spec, tests)
dev/mock-lab.js             faux serveur de rebond (telnet, sonde de ligne, redirection de ports) ; importable
dev/fakeIos.js              Cisco IOS / IOS XE simulé (quatre familles, démarrage, effacement, VLAN, console lente,
                            coupure d'alimentation, BREAK, ROMMON et chargeur de démarrage)
dev/mockCabling.js          les câbles du faux labo, tirés des liens du schéma
dev/mock-proxmox.js         faux Proxmox VE (HTTPS, API, consoles série + VNC)
config/infrastructure.json  commutateurs d'administration
test/                       tests unitaires node:test (npm test)
```

## Clavier

| Touches | Action |
|---|---|
| `Ctrl K` ou `/` (hors d'un terminal) | Chercher un équipement dans n'importe quel labo |
| `Tab`, puis `Entrée` sur le schéma | Ouvrir l'équipement ciblé |
| `Ctrl Shift C` dans un terminal | Copier la sélection |
| `Ctrl V` dans un terminal | Coller |
