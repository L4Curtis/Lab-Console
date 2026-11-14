# Journal des modifications

[English](CHANGELOG.md) · **Français**

## 2.1.0 - 14 novembre 2026

- **Adresses versionnées pour les fichiers de l'application.** Les pages
  chargent leurs scripts, feuilles de style et dictionnaires depuis
  `/v/<build id>/…`, où le build id est une empreinte de `public/` calculée au
  démarrage. Le navigateur garde ces réponses un an (`private,
  max-age=31536000, immutable`) : un chargement de page coûte une
  revalidation au lieu d'une par fichier, et une mise à jour est prise en
  compte au chargement suivant. Un ancien build id répond 404 ; un onglet
  resté ouvert pendant une mise à jour propose de recharger quand il ouvre une
  nouvelle section. Les adresses sans préfixe fonctionnent toujours,
  revalidées comme avant. Les règles d'accès ne changent pas. Voir
  [DEPLOY.md](docs/fr/DEPLOY.md) (« Cache, et un CDN devant »).
- `npm run dev` redémarre aussi quand un fichier de `public/` change.

## 2.0.0 - 14 novembre 2026

Lab Console 2 réécrit la plateforme autour de la connexion, des équipes et du
travail par baie. Même pile technique (Node.js, Express, modules ES simples,
pas d'étape de build) et même mission : l'accès aux consoles du labo par un
serveur de rebond. Le passage depuis la v1 est décrit dans le README (« Passer
de la v1 à la v2 »).

### Changements incompatibles

- **La connexion est obligatoire.** L'application refuse de démarrer sans
  administrateur local (`LOCAL_ADMIN_USERNAME`, `LOCAL_ADMIN_PASSWORD_HASH`,
  `LOCAL_ADMIN_TOTP_SECRET` ; `npm run setup-admin`). Il n'existe aucun mode
  sans authentification.
- **`PUBLIC_URL` est obligatoire.** `TRUST_PROXY=true` est refusé au démarrage ;
  `TRUSTED_PROXIES` liste chaque relais.
- **L'état vit dans `DATA_DIR`** (base SQLite `lab-console.db` et fichiers pour
  les sauvegardes, modèles, journaux et versions du schéma). L'image Docker
  tourne en lecture seule avec un volume sur `/data` ; étiquette
  `lab-console:2`.
- **La production exige la clé du rebond épinglée** : avec `NODE_ENV=production`
  (l'image Docker), aucune console ne se connecte sans `SSH_HOST_FINGERPRINT`
  ou une empreinte enregistrée sur la page des paramètres du labo
  (`consoles.ssh_unpinned`).
- **Proxmox** (machines virtuelles, les deux WebSockets de console de VM) est
  réservé aux administrateurs. Les commutateurs d'administration restent
  ouverts à tous.
- Le schéma actif est la copie `DATA_DIR/diagrams/current.drawio` ;
  `diagrams/diagram.drawio` ne fait que l'amorcer au premier démarrage.
- Les actions d'administration sensibles demandent une confirmation (voir
  Sécurité).

### Ajouts

- **Comptes** : connexion OpenID Connect (réglages par l'environnement ou la
  page d'administration), comptes locaux par invitation, liens de
  réinitialisation, clés d'accès, rôles, approbation des comptes, Mon compte,
  journal d'audit, liste et révocation des sessions, limites de tentatives et
  navigateurs connus sur le formulaire local.
- **Équipes et baies** : équipes avec invitations (`TEAM_MAX_MEMBERS`), prise et
  libération d'une baie, libération sur inactivité (`BENCH_IDLE_HOURS`),
  verrous avec motif, calendrier de réservation avec limites, invités.
- **Consoles partagées** : une ligne par équipement, tenue par le serveur, un
  pilote et autant de spectateurs que l'on veut, passage du clavier, règle de
  baie reposée à chaque frappe, journal par jour de console (`JOURNAL_*`).
- **Tâches de baie** : sauvegarde, injection, remise à zéro et comparaison sur
  tous les équipements d'une baie, sauvegardes (liste, lecture, différence,
  recherche, téléchargement et import en ZIP), modèles de TP (publication,
  import de ZIP), dossier de TP ; un équipement n'est jamais effacé sans
  sauvegarde vérifiée.
- **Outils de console** : collage multiligne espacé, envoi à plusieurs
  consoles, historique avec recherche et téléchargement, bibliothèque de
  scripts (personnelle, d'équipe, publiée).
- **Travail en groupe** : une note par équipement, un chat par baie,
  notifications du navigateur.
- **Vérifications** : état des lignes, câblage (CDP), matrice de ping, adresses
  des interfaces.
- **Récupération de mot de passe** : un assistant guidé pour plusieurs familles
  d'équipements (pas encore essayé sur tous les modèles réels).
- **Accueil, vue d'ensemble de chaque baie, page d'aide et visite guidée.**
- **Administration** : paramètres du labo appliqués sans redémarrage, import de
  schéma avec aperçu, versions et retour en arrière, commutateurs
  d'administration, bandeau d'annonce, page d'état du labo.
- **Français et anglais** partout, avec un sélecteur de langue.
- **Documentation** : README, guide étudiant, guide de déploiement, référence
  de configuration générée depuis `.env.example` (`npm run gen-config-doc`),
  surcouche Docker du labo simulé (`docker-compose.mock.yml`).
- Un labo simulé avec des équipements Cisco IOS / IOS XE simulés (démarrage,
  effacement, récupération, consoles lentes), des défauts de câblage, un
  fournisseur d'identité simulé et un Proxmox simulé.

### Modifications

- Transport du tunnel Proxmox : `PROXMOX_TUNNEL_TRANSPORT` vaut `auto`
  (redirection TCP, puis commande de relais) par défaut ; `forward` et `exec`
  en imposent un.
- L'interface s'adapte jusqu'à la largeur d'un téléphone (barre de navigation
  en bas), a un lien d'évitement, un titre de page par section et des jetons de
  contraste soignés ; un chargement raté affiche un message avec un bouton
  Réessayer au lieu d'une page vide.
- Une seule typographie française et un seul format de date partout.

### Sécurité

- Connexion : OIDC avec PKCE, `state` et `nonce` ; mots de passe hachés en
  scrypt ; cookie de session `__Host-` Secure en https ; HSTS quand
  `PUBLIC_URL` est en https ; contrôle de l'origine des WebSockets et de chaque
  modification.
- `Ctrl+]` n'atteint plus le mode commande du telnet du rebond par aucun
  chemin : frappes, collages, scripts injectés, diffusions, mots de passe de
  tâches, connexion à la console et Entrée de réveil. Seul le bouton BREAK
  l'envoie, et tout ce qui part vers la ligne pendant ce temps est retenu
  jusqu'à la fin du break. Les scripts et mots de passe de tâches contenant des
  caractères de contrôle sont refusés.
- Corps de requêtes : les corps compressés sont refusés (415) avant lecture ;
  tous les analyseurs viennent d'un seul module ; `body-parser` et `qs` mis à
  jour (`npm audit --omit=dev` ne signale rien).
- Les actions d'administration sensibles demandent une confirmation fraîche
  (mot de passe et code, clé d'accès, ou nouvelle connexion chez le fournisseur
  d'identité) : paramètres du labo, réglages SSO, invitation, promotion ou
  activation d'un administrateur, effacement des clés d'accès d'un
  administrateur.
- Tâches, vérifications et récupération relisent le rôle actuel de la personne
  avant chaque équipement : un compte rétrogradé ou désactivé est arrêté en
  cours de tâche.
- Les échecs de Proxmox répondent une erreur générique au navigateur ; le
  détail reste dans le journal.

### Limites connues

- Pas essayé sur le vrai matériel : l'effacement et le rechargement sur IOS XE
  17, le temps d'une clé RSA 2048 bits sur un vieux routeur, cinq lignes de
  tâche à la fois sur le serveur de consoles, chaque famille de récupération,
  la sortie CDP sur IOS XE 17 et le 9300L, le traitement du BREAK par le
  serveur de consoles.
- La page d'état n'a pas de ligne pour le tunnel Proxmox et
  `/api/proxmox/status` nomme le serveur de rebond de l'environnement, pas
  celui enregistré sur la page du labo ; les erreurs d'API du module Proxmox
  arrivent à l'interface en anglais. Le module Proxmox a été laissé tel quel
  par décision.
- Un administrateur SSO qui confirme depuis l'onglet Utilisateurs ou
  Invitations refait l'action après son retour du fournisseur d'identité.
  Désactiver un administrateur ne demande pas de confirmation (cela ne fait que
  retirer un accès).
- Le fil d'activité affiche une ligne par équipement pour une tâche en masse.
- Des scénarios navigateur manquent pour la page des réglages SSO,
  l'approbation en attente, la page de réinitialisation du mot de passe, Mon
  compte, les fenêtres de comparaison de sauvegardes, la matrice de ping avec
  adresses, les pages d'état et de journal et le panneau en direct (ils sont
  couverts par des tests unitaires et d'intégration).
- Les décisions ouvertes pour le propriétaire sont dans `docs/v2/SPEC.md`
  (offre de sauvegarde après une libération non manuelle, droit du spectateur
  sur le journal).

## 1.1.0

Outils de console (export de la running-config, injection de script) et
alimentation des machines virtuelles en masse.

## 1.0.0

Première version : consoles des équipements du labo depuis un schéma draw.io,
par un serveur de rebond SSH et telnet, et la section Infrastructure
(commutateurs d'administration, machines virtuelles Proxmox).
