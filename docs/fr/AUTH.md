# Se connecter à Lab Console

[English](../v2/AUTH.md) · **Français**

Tout dans Lab Console exige un utilisateur connecté : pages, API, événements
en direct et WebSockets de console. Il n'existe aucun mode sans connexion.
Trois façons d'entrer, un seul type de session :

| Qui | Comment | Configuré avec |
|---|---|---|
| Étudiants et enseignants | le fournisseur d'identité de l'école (OpenID Connect) | `OIDC_*`, ou l'onglet **Connexion (SSO)** de la section Administration |
| Comptes locaux | nom d'utilisateur + mot de passe, créés par un lien d'invitation ; une clé d'accès pour les administrateurs parmi eux | les onglets **Utilisateurs** et **Invitations** |
| L'administrateur local | nom d'utilisateur + mot de passe + code à 6 chiffres | `LOCAL_ADMIN_*` |

L'administrateur local est obligatoire : c'est le compte de secours, celui qui
fonctionne encore quand le fournisseur d'identité est en panne ou pas encore
configuré. La plateforme refuse de démarrer sans lui. OpenID Connect et les
comptes locaux sont facultatifs ; sans eux, seul l'administrateur local peut
se connecter.

Rôles : un compte SSO est **admin** quand l'un de ses groupes figure parmi les
groupes d'administration (`OIDC_ADMIN_GROUPS` ou l'onglet SSO), sinon
**étudiant**, sauf si un administrateur a imposé un rôle dans l'onglet
Utilisateurs, qui l'emporte. Un compte local a le rôle que son invitation lui a
donné, modifiable dans l'onglet Utilisateurs. L'administrateur local est admin.
Les groupes sont lus à la connexion : un changement de groupes chez le
fournisseur s'applique à la prochaine connexion de la personne (révoquez ses
sessions pour l'appliquer aussitôt). Une modification faite dans l'onglet
Utilisateurs (rôle, désactivation) met fin aussitôt aux sessions et aux
consoles du compte.

## 1. L'administrateur local

### Le créer

```bash
npm run setup-admin                       # demande un nom d'utilisateur et un mot de passe (non affiché), deux fois
npm run setup-admin -- --username curtis  # idem, avec le nom donné
printf '%s\n' "$PASSWORD" | npm run --silent setup-admin -- --username curtis   # depuis un script
```

Dans Docker : `docker compose run --rm lab-console node scripts/setup-admin.js`.

La commande affiche trois lignes pour `.env` et une URI `otpauth://` :

```
LOCAL_ADMIN_USERNAME=curtis
LOCAL_ADMIN_PASSWORD_HASH=scrypt:32768:8:3:…:…
LOCAL_ADMIN_TOTP_SECRET=JBSWY3DPEHPK3PXP…

otpauth://totp/Lab%20Console:curtis?secret=…&issuer=Lab%20Console&algorithm=SHA1&digits=6&period=30
```

Ajoutez l'URI à une application d'authentification (Aegis, 2FAS, Google
Authenticator, un gestionnaire de mots de passe…) : transformez-la en code QR
avec un outil de confiance, hors ligne, ou saisissez le secret à la main
(temporel, SHA-1, 6 chiffres, 30 s). Rien n'est écrit sur le disque et le mot
de passe lui-même n'est jamais affiché. Le hachage et le secret sont aussi
sensibles que le mot de passe : gardez `.env` lisible par le service seul
(`chmod 600 .env`).

Le mot de passe demande au moins 12 caractères. Le hachage est du scrypt dont
le coût est dans la valeur (`N`, `r`, `p`), qu'on peut coller sans risque dans
un `.env` ou un fichier compose (aucun `$` à échapper).

### Se connecter

Sur `/login`, ouvrez **Administrateur local** (il est déjà ouvert quand aucun
fournisseur d'identité n'est configuré) et saisissez le nom d'utilisateur, le
mot de passe et le code affiché par l'application, les trois ensemble. Un refus
ne dit jamais lequel était faux.

- Un code est valable pendant son pas de 30 secondes et un pas de chaque côté
  (dérive d'horloge). Une fois accepté, ce pas ne peut plus servir, même après
  un redémarrage (la base, `data/lab-console.db`, retient le dernier) :
  attendez le code suivant pour vous connecter une seconde fois.
- Les tentatives sont limitées : 5 par 15 minutes depuis une adresse ; après
  deux échecs sur un nom d'utilisateur, chaque nouvelle tentative sur ce nom
  attend deux fois plus que la précédente (1 s, 2 s, 4 s… jusqu'à 15
  minutes), depuis n'importe quelle adresse ; et au-delà de 50 échecs par 15
  minutes au total, un nom qui a lui-même échoué attend que ce nombre
  redescende (un nom sur lequel personne n'a échoué a quand même sa chance :
  des inconnus qui échouent sur des noms inventés ne tiennent jamais à
  l'écart un étudiant qui a le bon mot de passe). La réponse et son délai sont
  les mêmes que le nom existe ou non. Ces limites ne s'appliquent qu'à ce
  formulaire : les personnes qui se connectent par le fournisseur d'identité
  ne les rencontrent jamais.
- **Navigateurs connus.** Les deux dernières limites sont partagées par tout
  le monde : un inconnu pourrait donc les maintenir actives en permanence. Un
  navigateur qui s'est connecté avec succès (avec un mot de passe, par
  l'inscription d'une invitation, ou avec une clé d'accès) garde un cookie
  `lc_device` (`__Host-lc_device` en https, 180 jours, signé, valable
  seulement pour ce nom d'utilisateur). Ses tentatives sont comptées sur ce
  navigateur seul, 5 par 15 minutes avec son propre délai croissant, et les
  refus partagés ne s'y appliquent plus. Ce n'est pas un identifiant : le nom,
  le mot de passe et le code restent exigés. Il reste valable quand le mot de
  passe ou le code est remplacé (voir plus bas) : les propres navigateurs de
  l'administrateur entrent donc encore pendant que quelqu'un martèle le
  formulaire. **Connectez-vous une fois depuis le navigateur que vous
  utiliseriez en urgence** : un navigateur qui ne s'est jamais connecté peut
  encore être mis en attente par quelqu'un qui martèle le formulaire. Les
  cookies sont signés avec une clé aléatoire gardée dans la base ;
  `npm run forget-browsers` puis un redémarrage fait oublier tous les
  navigateurs connus.
- Chaque tentative dont les identifiants ont été vérifiés, réussie ou non, est
  dans le journal d'audit (`auth.login`, `auth.login.failed`), avec l'adresse
  du client. Les refus qui ne coûtent rien à l'expéditeur (une tentative
  retardée, un retour de fournisseur qui ne correspond à aucune connexion en
  cours) sont écrits une fois par adresse et par sorte toutes les 15 minutes ;
  les autres sont comptés, et une entrée `auth.login.suppressed` par quart
  d'heure donne le total et les dix adresses les plus actives. Le journal
  d'audit ne peut pas servir à remplir le disque.

### Changer le mot de passe, ou téléphone perdu

Relancez `npm run setup-admin`, remplacez les trois lignes, redémarrez. L'ancien
mot de passe et l'ancien code cessent de fonctionner, et tout ce qui a été
obtenu avec eux aussi : les sessions ouvertes de l'administrateur local se
terminent au redémarrage (chacune est stockée avec une empreinte des
identifiants qui l'ont ouverte). Changer seulement le nom d'utilisateur a le
même effet. C'est ce qu'il faut faire après une compromission soupçonnée.

Les navigateurs connus le restent après le changement (un cookie de navigateur
connu ne compte que pour le nom d'utilisateur pour lequel il a été émis : un
nouveau nom démarre sans aucun) : les navigateurs depuis lesquels vous vous
étiez déjà connecté passent les refus partagés avec le nouveau mot de passe et
le nouveau code, même si quelqu'un attaque le formulaire à ce moment-là. Pour
les oublier aussi, lancez `npm run forget-browsers` (dans Docker :
`docker compose exec lab-console node scripts/forget-browsers.js`) avant le
redémarrage.

## 2. Un fournisseur d'identité (OpenID Connect)

Lab Console utilise le flux par code d'autorisation avec PKCE (S256), `state`
et `nonce`, et vérifie la signature du jeton d'identité avec les clés publiées
du fournisseur. Tout ce qui est standard fonctionne ; les recettes ci-dessous
couvrent les quatre que nous attendons.

### Ce dont tout fournisseur a besoin

| Réglage chez le fournisseur | Valeur |
|---|---|
| Type de client | confidentiel (avec secret) ou public (sans secret : PKCE seul) |
| URL de redirection / de rappel | `${PUBLIC_URL}/auth/callback`, p. ex. `https://lab.example.org/auth/callback` |
| URL de redirection après déconnexion | `${PUBLIC_URL}/login` (si le fournisseur la demande) |
| Type d'autorisation (grant) | code d'autorisation uniquement |
| Portées (scopes) | `openid profile email`, plus ce qui fournit les groupes |
| Signature du jeton d'identité | une clé asymétrique (RS256, ES256…), jamais le secret du client (HS256) |

Et dans `.env` :

```bash
PUBLIC_URL=https://lab.example.org        # exactement ce que les utilisateurs tapent ; https en production
OIDC_ISSUER=https://id.example.org        # l'émetteur, EXACTEMENT comme le fournisseur l'affiche (gardez ou omettez la / finale)
OIDC_CLIENT_ID=lab-console
OIDC_CLIENT_SECRET=…                      # vide pour un client public
OIDC_CLIENT_AUTH_METHOD=client_secret_basic   # ou client_secret_post, si le fournisseur veut le secret dans le corps
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups                  # un nom de claim, ou un chemin pointé : realm_access.roles
OIDC_ADMIN_GROUPS=lab-admins              # ses membres sont administrateurs
OIDC_ALLOWED_GROUPS=                      # vide : tout compte peut se connecter ; sinon seulement ces groupes (et ceux d'administration)
OIDC_PROVIDER_NAME=Pocket ID              # libellé du bouton : « Se connecter avec Pocket ID »
```

L'émetteur est comparé caractère par caractère à ce que le fournisseur publie
à `<émetteur>/.well-known/openid-configuration` (son champ `issuer`) : copiez-le
de là en cas de doute. Le fournisseur est contacté à la première connexion, pas
au démarrage : la plateforme démarre donc même quand le fournisseur est en
panne ; la page de connexion le dit alors, et l'administrateur local peut
toujours se connecter.

**Groupes.** Lab Console lit `OIDC_GROUPS_CLAIM` dans le jeton d'identité ;
quand le claim n'y est pas (certains fournisseurs gardent le jeton d'identité
petit), il interroge le point d'accès userinfo. Le claim peut être un tableau
ou une simple chaîne (un groupe, ou plusieurs séparés par des virgules). Les
noms de groupe sont comparés exactement, majuscules comprises. Un utilisateur
qui n'est dans aucun des `OIDC_ALLOWED_GROUPS` est renvoyé à la page de
connexion avec « Votre compte n'est dans aucun des groupes autorisés à
utiliser Lab Console ».

**La déconnexion** met fin à la session Lab Console, puis envoie le navigateur
vers le point de fin de session du fournisseur quand il en annonce un
(`end_session_endpoint` dans son document de découverte), qui le ramène à
`/login`. Sinon la déconnexion est locale seulement : la session propre du
fournisseur reste ouverte.

**Le http simple** est refusé pour l'émetteur, sauf sur `localhost` (le faux
fournisseur). `OIDC_ALLOW_INSECURE=true` l'accepte sur un banc d'essai :
jamais avec de vrais comptes, car n'importe qui sur le chemin pourrait alors se
connecter sous n'importe quel nom.

### Pocket ID

1. *Administration → OIDC Clients → Add OIDC client*. Nom : Lab Console.
2. *Callback URLs* : `https://lab.example.org/auth/callback` ; *Logout callback
   URLs* : `https://lab.example.org/login`.
3. Cochez *Public client* pour un client sans secret (*PKCE* est alors
   obligatoire), ou laissez décoché et copiez le secret affiché après
   l'enregistrement.
4. Facultatif : restreindre le client à certains groupes d'utilisateurs chez
   le fournisseur.
5. Groupes : Pocket ID renvoie les noms des groupes de l'utilisateur dans le
   claim `groups` quand la portée `groups` est demandée : les valeurs par
   défaut conviennent.

```bash
OIDC_ISSUER=https://id.example.org
OIDC_CLIENT_ID=<identifiant client affiché par Pocket ID>
OIDC_CLIENT_SECRET=<secret, ou vide pour un client public>
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_PROVIDER_NAME=Pocket ID
```

### Authentik

1. *Applications → Providers → Create → OAuth2/OpenID Provider*.
   - *Client type* : Confidential (avec secret) ou Public.
   - *Redirect URIs* : strict, `https://lab.example.org/auth/callback`.
   - *Signing key* : choisissez un certificat (p. ex. l'auto-signé). Sans lui,
     Authentik signe les jetons d'identité avec le secret du client (HS256),
     que Lab Console refuse.
   - Portées : les mappings par défaut `openid`, `email` et `profile`. Le
     mapping `profile` par défaut d'Authentik inclut déjà un claim `groups`.
2. *Applications → Create*, lié à ce fournisseur, slug `lab-console`.
3. L'émetteur est `https://authentik.example.org/application/o/lab-console/`,
   **avec** sa barre oblique finale (il est affiché sur la page du fournisseur
   sous *OpenID Configuration Issuer*).

```bash
OIDC_ISSUER=https://authentik.example.org/application/o/lab-console/
OIDC_CLIENT_ID=<identifiant client>
OIDC_CLIENT_SECRET=<secret du client, ou vide pour Public>
OIDC_SCOPES=openid profile email
OIDC_GROUPS_CLAIM=groups
OIDC_PROVIDER_NAME=Authentik
```

### Keycloak

1. Dans votre realm : *Clients → Create client*, type OpenID Connect,
   identifiant client `lab-console`.
   - *Client authentication* : On pour un client confidentiel (le secret est
     alors sous *Credentials*), Off pour un client public.
   - *Authentication flow* : Standard flow seulement.
   - *Valid redirect URIs* : `https://lab.example.org/auth/callback` ;
     *Valid post logout redirect URIs* : `https://lab.example.org/login` ;
     *Web origins* : `https://lab.example.org`.
   - *Advanced → Proof Key for Code Exchange* : S256.
2. Groupes. Keycloak n'en met aucun dans les jetons par défaut. Créez une
   portée client nommée `groups` (*Client scopes → Create*, type Default),
   ajoutez le mapper *By configuration → Group Membership* avec le nom de claim
   `groups`, *Full group path* désactivé, *Add to ID token* et *Add to
   userinfo* activés, puis ajoutez cette portée au client. Les `OIDC_SCOPES`
   par défaut conviennent alors. Pour utiliser plutôt les rôles du realm :
   `OIDC_GROUPS_CLAIM=realm_access.roles`, avec le mapper *realm roles* de la
   portée `roles` ajouté au jeton d'identité ou à userinfo.
3. L'émetteur est `https://keycloak.example.org/realms/<realm>`, sans barre
   oblique finale.

```bash
OIDC_ISSUER=https://keycloak.example.org/realms/school
OIDC_CLIENT_ID=lab-console
OIDC_CLIENT_SECRET=<secret, ou vide pour un client public>
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_PROVIDER_NAME=Keycloak
```

### Authelia

Dans la configuration d'Authelia (`identity_providers.oidc.clients`) :

```yaml
- client_id: lab-console
  client_name: Lab Console
  client_secret: '$pbkdf2-sha512$…'      # authelia crypto hash generate pbkdf2 --random ; le secret en clair va dans Lab Console
  public: false                          # true (et token_endpoint_auth_method: none) pour un client public
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

Les versions récentes d'Authelia gardent le jeton d'identité petit et servent
`groups`, `name` et `email` au point d'accès userinfo : Lab Console interroge
userinfo de lui-même quand le jeton d'identité ne les contient pas.

```bash
OIDC_ISSUER=https://auth.example.org
OIDC_CLIENT_ID=lab-console
OIDC_CLIENT_SECRET=<le secret en clair>
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_PROVIDER_NAME=Authelia
```

### Ou depuis les pages d'administration

Sans `OIDC_ISSUER` dans l'environnement, l'onglet **Connexion (SSO)** de la
section Administration règle le fournisseur : nom du bouton, émetteur,
identifiant client, secret du client (en écriture seule : la page dit
seulement s'il y en a un ; un changement d'émetteur ou d'identifiant client
exige le secret du nouveau client, ou « client public » coché, si bien que le
secret enregistré n'est jamais envoyé à un autre fournisseur), portées, claim
des groupes, groupes d'administration, groupes autorisés, activé / désactivé.
Elle affiche l'URL de rappel à donner au fournisseur, **Tester** récupère le
document de découverte, et **Essayer une connexion** va chez le fournisseur et
revient sans ouvrir de session, en montrant les claims reçus et le rôle qu'ils
donnent. L'enregistrement s'applique aussitôt, sans redémarrage ; les sessions
ouvertes ne sont pas touchées.

Les paramètres sont conservés dans la base (`DATA_DIR/lab-console.db`, mode
600, table `settings`, ligne `sso` ; un `data/auth/oidc.json` écrit par une
version antérieure est importé au démarrage). Le secret du client est en clair
dans la base, sauf si `APP_SECRET` (32 caractères au moins, p. ex.
`openssl rand -base64 48`) est défini, auquel cas il est chiffré avec lui ;
changer `APP_SECRET` le rend illisible et la page le redemande. Quand
`OIDC_ISSUER` est défini dans l'environnement, l'environnement l'emporte et
l'onglet est en lecture seule.

La requête de découverte est protégée : https seulement (sauf l'option
non sécurisée), un délai maximal et une limite de taille ; seul l'hôte propre
de l'émetteur peut être sur le réseau local, et aucune redirection ne mène à
une adresse interne.

## 2b. Comptes locaux et clés d'accès

- **Invitations** (onglet Invitations) : un lien valable 1 h, 24 h ou 7 jours,
  pour une personne ou jusqu'à 100, donnant le rôle étudiant (par défaut) ou
  admin. Le lien n'est montré qu'une fois ; seul un hachage de son jeton est
  conservé. Un lien à usage unique donne aussitôt un compte actif ; un lien
  pour plusieurs personnes donne des comptes qui attendent l'approbation d'un
  administrateur (onglet Utilisateurs). Les liens peuvent être retirés.
- **Noms d'utilisateur** : 3 à 32 lettres et chiffres avec des `.`, `-` ou `_`
  isolés entre eux, uniques sans tenir compte de la casse (le nom de
  l'administrateur local et chaque compte de l'annuaire compris, comptes SSO
  aussi : un nouveau compte local ne prend jamais le nom d'utilisateur SSO d'un
  camarade). **Accepté (décision du propriétaire, 13 nov.) :** la page
  d'inscription peut dire qu'un nom choisi est pris. Seule une personne qui
  détient une invitation valable peut le demander (tout nom essayé, celui de
  l'administrateur local compris : un tel nom est refusé aussitôt, exactement
  comme un nom réservé tel que `admin`), et les refus d'inscription sont
  limités à 10 par lien par 15 minutes. **Mots de passe** : 10 caractères au
  moins, pas un mot de passe courant, ne contenant pas le nom d'utilisateur ;
  stockés sous forme de hachages scrypt.
- **Mot de passe oublié** : il n'y a pas d'e-mail. Un administrateur fabrique un
  lien de réinitialisation (onglet Utilisateurs, 1 h ou 24 h, à usage unique) ;
  l'utiliser met fin aux sessions du compte, et à toute connexion commencée
  avec l'ancien mot de passe qui attendait encore sa clé d'accès. Changer le mot
  de passe dans Mon compte, ou effacer les clés d'accès d'un compte, y met fin
  aussi.
- **Les clés d'accès** (passkeys) sont proposées quand `PUBLIC_URL` est en
  https sur un nom de domaine (ou `http://localhost`, pour les tests) : la
  partie utilisatrice (relying party) est l'hôte de `PUBLIC_URL`. Un compte local
  promu admin enregistre une clé d'accès à sa connexion suivante et se connecte
  dès lors avec mot de passe + clé d'accès, ou avec la clé d'accès seule (le
  bouton de clé d'accès de la page de connexion) ; son mot de passe seul
  n'ouvre plus de session. Les étudiants peuvent ajouter des clés d'accès dans
  **Mon compte** et garder leur mot de passe. Les comptes SSO s'en remettent à
  leur fournisseur, et l'administrateur local garde mot de passe + code. Un
  appareil perdu : un administrateur retire les clés d'accès du compte dans
  l'onglet Utilisateurs, et une nouvelle est enregistrée à la connexion
  suivante.
- Le dernier administrateur de l'annuaire ne peut être ni rétrogradé ni
  désactivé.

## 3. Sessions

- La session est un jeton aléatoire de 256 bits dans un cookie `HttpOnly`,
  `SameSite=Lax` : `__Host-lc_sid` (avec `Secure`) quand `PUBLIC_URL` est en
  https, `lc_sid` sinon. Le cookie prend fin avec le navigateur.
- 8 heures sans activité (une console ouverte compte comme activité), 24 heures
  au plus, 10 sessions par personne. Un nouvel identifiant à chaque connexion.
- Les sessions survivent à un redémarrage : la base (`data/lab-console.db`) les
  garde, indexées par le SHA-256 du jeton ; le jeton lui-même n'est écrit nulle
  part.
- Quand une session prend fin (déconnexion, révocation par un administrateur,
  expiration), les consoles et les mises à jour en direct ouvertes avec elle
  sont fermées aussitôt.

## 4. Exposé à Internet

La connexion est conçue pour faire face à Internet directement :

- `TRUSTED_PROXIES` doit lister **chaque saut** entre Internet et Lab Console.
  `X-Forwarded-For` est lu par la droite : chaque adresse qui est l'une des
  nôtres est sautée, et la première qui n'en est pas est le client (utilisé par
  les limites de tentatives et le journal d'audit). Ce que le client a écrit
  lui-même plus à gauche est ignoré, et un pair qui n'est pas listé n'est
  jamais cru.
  - Derrière Nginx Proxy Manager, puis Cloudflare : Cloudflare ajoute l'adresse
    du visiteur, NPM ajoute celle de Cloudflare. Listez l'adresse de NPM **et**
    les plages publiées de Cloudflare (<https://www.cloudflare.com/ips/>, IPv4
    et IPv6), par exemple
    `TRUSTED_PROXIES=192.168.10.112,173.245.48.0/20,103.21.244.0/22,…,2400:cb00::/32,…`.
    Avec NPM seul listé, chaque visiteur apparaît sous une adresse de
    Cloudflare et tous partagent un même budget de tentatives. Revérifiez la
    liste quand Cloudflare annonce un changement.
  - Les proxys doivent ajouter à `X-Forwarded-For`, pas le remplacer (NPM et le
    `$proxy_add_x_forwarded_for` de nginx le font). `CF-Connecting-IP` n'est
    pas lu.
  - Le `TRUST_PROXY=true` d'origine (croire l'en-tête de n'importe quel pair)
    laissait n'importe quel client choisir sa propre adresse : Lab Console
    refuse de démarrer tant qu'il est défini. Retirez-le et remplissez
    `TRUSTED_PROXIES`.
- Si le site est joint sous une autre origine que `PUBLIC_URL` (un proxy, un
  second nom), ajoutez-la à `ALLOWED_ORIGINS` : elle commande le contrôle
  d'origine des WebSockets et des requêtes qui modifient.
- `PUBLIC_URL` doit être l'adresse https : elle fixe le préfixe du cookie et
  `Secure`, et l'URL de rappel donnée au fournisseur.
- La page de connexion et chaque réponse `/auth/*` portent `X-Robots-Tag:
  noindex` et `Cache-Control: no-store` ; les erreurs ne contiennent jamais de
  version ni de trace d'appels.

## 5. L'essayer en local

```bash
npm run mock-oidc     # un faux fournisseur sur http://127.0.0.1:9100, affiche les lignes OIDC_*
```

Il montre un sélecteur d'utilisateur (trois étudiants, un admin) et connecte
n'importe qui sous n'importe quel nom, sans mot de passe. Il refuse de démarrer
avec `NODE_ENV=production`, écoute sur l'interface de boucle locale sauf si on
lui passe `--expose`, et n'est pas dans l'image Docker.
`--misbehave wrongNonce,groupsInUserinfoOnly,groupsAsString` le fait mal se
comporter exprès.

## 6. Une pile de préproduction

`docker-compose.preprod.yml` ajoute le faux fournisseur à la pile Docker et y
pointe Lab Console : les testeurs se connectent comme `student1`…`student3` ou
`admin` en cliquant sur un nom. Quiconque atteint le faux fournisseur peut en
faire autant : ne l'utilisez que sur une pile sans vrais comptes, joignable par
les testeurs seuls.

1. Dans le `.env` à côté des fichiers compose, en plus des réglages habituels
   (`PUBLIC_URL`, `LOCAL_ADMIN_*`…) :

   ```bash
   MOCK_OIDC_ISSUER=http://192.168.10.250:9100   # comme les navigateurs ET le conteneur le joignent
   MOCK_OIDC_PUBLISH=192.168.10.250:9100         # où l'hôte publie le faux fournisseur (par défaut 127.0.0.1:9100)
   ```

   L'émetteur doit être la même adresse pour les navigateurs (envoyés là pour
   choisir un utilisateur) et pour le conteneur `lab-console` (découverte,
   jeton, clés) : l'adresse de l'hôte sur le réseau local et le port publié
   conviennent généralement aux deux.
2. Démarrez les deux :

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.preprod.yml up -d --build
   ```

   Les valeurs `OIDC_*` de la surcharge (le client `lab-console` /
   `mock-secret` du faux fournisseur, groupe d'administration `admins`,
   `OIDC_ALLOW_INSECURE=true` pour son http simple) l'emportent sur celles de
   `.env`. L'administrateur local fonctionne toujours.
3. Vérifiez que le conteneur joint l'émetteur :
   `docker compose exec lab-console wget -qO- "$MOCK_OIDC_ISSUER/.well-known/openid-configuration"`.
   Sinon, le bouton de connexion mène à « fournisseur indisponible ».

L'image de production est inchangée et n'a toujours pas de `dev/` : le faux
fournisseur tourne dans un simple conteneur `node:22-alpine` depuis
`dev/mock-oidc.js` monté en lecture seule, avec `NODE_ENV=development` (il
refuse `production`).
