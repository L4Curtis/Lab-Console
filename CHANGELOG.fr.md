# Journal des modifications

[English](CHANGELOG.md) · **Français**

## 2.3.0 - 15 novembre 2026

La refonte de la 2.2.0 (barre d'onglets en bas sur téléphone, les cinq
destinations et Plus, les nouveaux composants) s'accompagne maintenant des
**clés d'accès obligatoires pour chaque compte local**. Les étapes de clé
d'accès de l'inscription, de la connexion et des liens de réinitialisation
reprennent le cadre de connexion de la refonte, sur téléphone comme sur PC.
Elle porte aussi les corrections nées de l'usage de la refonte sur téléphone
et sur portable (ci-dessous, « Corrigé »).

### Modifié

- **Chaque compte local se connecte avec une clé d'accès**, étudiants compris
  (seuls les administrateurs issus d'un compte local en avaient besoin). La
  clé est enregistrée pendant l'inscription par invitation, avant toute
  session ; un compte local qui n'en a pas encore (tout compte étudiant créé
  avant cette version) tape son mot de passe à sa connexion suivante, puis en
  enregistre une avant d'arriver dans l'application. Dès qu'il en a une, son
  mot de passe seul n'ouvre plus de session : un clic sur **Se connecter avec
  une clé d'accès**, ou le mot de passe puis la clé. La dernière clé d'un
  compte ne peut pas être supprimée depuis Mon compte. Les comptes SSO et
  l'administrateur du serveur (mot de passe + code) ne changent pas. Pas de
  migration : les comptes sont sollicités à leur connexion suivante, et leurs
  sessions ouvertes vont jusqu'à leur terme.
- **Un lien de réinitialisation remplace aussi les clés d'accès.** L'utiliser
  fixe le nouveau mot de passe, supprime les clés du compte et met fin à ses
  sessions ; la personne enregistre ensuite une nouvelle clé avant la
  première session (un téléphone perdu est la raison habituelle de demander
  un lien).
- **Les comptes locaux demandent https.** Quand `PUBLIC_URL` n'est pas en
  https sur un nom de domaine (ou `http://localhost`), les comptes locaux ne
  peuvent être ni créés ni connectés, et les pages comme l'API le disent
  (`accounts.passkeys_unavailable`) au lieu de se rabattre sur les mots de
  passe ; invitations et liens de réinitialisation y sont refusés.
  L'administrateur du serveur se connecte toujours. Voir
  [AUTH.md](docs/fr/AUTH.md) §2b et [DEPLOY.md](docs/fr/DEPLOY.md)
  (« Comptes locaux et clés d'accès »).
- **Les étapes de clé d'accès ressemblent au reste de la refonte.** Les pages
  de connexion, d'inscription et de lien de réinitialisation gardent leur
  carte sur PC et leur mise en page pleine largeur sur téléphone pour la clé
  d'accès : un titre, une phrase, un grand bouton. Ce qui s'est bien passé
  (compte créé, mot de passe enregistré, attente de validation) est un
  bandeau vert ; un navigateur sans clés d'accès ou un site sans https
  affiche « Clés d'accès indisponibles ici » au lieu de « Ce lien ne
  fonctionne pas ». Admin › Invitations dit pourquoi aucun lien ne peut être
  créé sans https et désactive **Nouvelle invitation**.
- Les requêtes de clé d'accès sont limitées par adresse avec de la place
  pour une classe derrière une seule adresse publique (300 requêtes de
  connexion en un clic et 240 d'étape par minute), et jusqu'à 100 connexions
  d'une même adresse peuvent attendre leur clé en même temps.

### Corrigé

- **Tourner le téléphone garde la console.** Un écran tactile de moins de
  500 px de haut est compact quelle que soit sa largeur : la console garde
  tout l'écran (pas de barre d'onglets, un en-tête, une barre de touches et
  une ligne plus minces), tourner dans un sens puis dans l'autre ou charger
  son adresse à l'horizontale la ramène, et l'écran de la baie n'a pas de
  bandeau de journalisation dans ce cas.
- **Consoles et Réservations s'ouvrent sur la baie de votre équipe**, puis
  la dernière utilisée, puis la première. Le détail d'une baie dit où
  l'équipe est déjà (`you.teamBench`) et ne propose plus d'en prendre une
  autre : le bandeau et l'onglet Baie disent **Aller à B4M** au lieu d'un
  bouton que le serveur refuse.
- **Un téléphone ouvre la baie en liste**, pas un schéma qui sort de
  l'écran ; le schéma reste à un toucher et se mémorise une fois choisi. À
  côté de consoles ouvertes, une colonne de schéma de moins de 400 px montre
  aussi la liste. Le bandeau de journalisation s'affiche une fois par
  navigateur, en une phrase courte sur téléphone.
- **Les touches IOS les plus utiles viennent d'abord** (Tab, ?, Ctrl, ^C, ^Z,
  les flèches de l'historique) et celles d'après le balayage disent un mot
  (Break, Espace, Coller, Clavier). Un seul **Demander la main**, pas deux ;
  le pilote lit « Sans réponse, la main passe à Zoé dans 28 s » sur sa propre
  ligne ; la rangée de pastilles et la ligne « tournez le téléphone » partent
  quand le clavier est ouvert.
- **Admin › Utilisateurs tient sur un portable de 1280 px** : les colonnes de
  connexion s'effacent jusqu'à 1359 px (leur contenu passe sous le nom),
  donc Valider n'est jamais derrière un défilement latéral. Machines et
  switchs, État du labo et Toutes les équipes mettent leurs onglets dans la
  colonne de contenu, à côté de la liste de l'administration, au lieu
  d'empiler deux navigations.
- **Réservations** : les heures déjà passées du jour tiennent sur une ligne,
  l'heure en cours n'est pas proposée (le serveur la refuserait), le début
  est une liste d'heures en 24 h encore libres, et le bouton de semaine dit
  Aujourd'hui.
- **Libérer la baie** est un bouton de danger dans la carte de la baie (c'était
  un grand bouton bleu qui repoussait les onglets), avec une confirmation de
  danger ; les rangées de boutons commencent au bord du contenu de la carte ;
  le mot d'état du bandeau n'est jamais coupé (« Libre », « Prise par vous »).
- **La visite guidée** place sa carte dans la moitié de l'écran où n'est pas
  la cible, entoure le titre à sa première étape et finit sur la page où elle
  a commencé.
- **Accueil et Équipe** : un étudiant invité n'a qu'un bouton bleu (Rejoindre,
  Accepter) ; la liste du labo sur téléphone fait des lignes de 58 px avec un
  chevron. La page de connexion met en premier la méthode que ce navigateur a
  utilisée en dernier, et dit qu'un compte créé par invitation utilise sa clé
  d'accès.
- **Administration** : le journal d'audit dit « Connexion », « Schéma
  refusé »… avec le code dessous, des dates sur une ligne et pas de colonne
  Baie vide ; le refus d'un schéma est une remarque avec une icône et sans
  commande de développeur ; le bouton du formulaire d'invitation est **Créer
  le lien** ; une valeur du labo que personne n'a changée n'a plus de pastille
  « environnement » ; un étudiant lit « Proxmox n'est pas disponible pour le
  moment » au lieu de devoir éditer `.env` ; **Mur de consoles** ne dit plus
  qu'aucune console n'est ouverte quand certaines le sont.
- `npm run check-diagram` affiche les avertissements de l'analyseur (il
  affichait `[object Object]` puis plantait) et sort en 1 sur celui qui
  bloque.

## 2.2.0 - 15 novembre 2026

Une refonte de l'interface pour le téléphone, la tablette et le PC
([UX.md](docs/v2/UX.md)). Les couleurs restent (le bleu console, thèmes clair
et sombre) ; la mise en page, la navigation et les composants sont nouveaux.

- **Navigation.** Cinq destinations : Accueil, Consoles, Équipe, Sauvegardes
  et, pour les administrateurs, Admin. Le reste est dans **Plus** : Machines
  et switchs, État du labo, Aide, Mon compte, les alertes, le thème, la
  langue, la visite guidée et la déconnexion. Sur téléphone c'est une barre
  d'onglets en bas (quatre entrées et Plus), sur PC un rail. Les anciennes
  adresses fonctionnent toujours (`#/overview` mène à « Le labo » de
  l'Accueil).
- **Consoles.** Un en-tête d'une ligne (choix de la baie, recherche, En
  direct, Discussion, un menu Outils) ; le schéma prend la page. Les tuiles
  de console ont un en-tête fin avec les personnes présentes et un menu ⋯ qui
  regroupe toutes les actions. Sur téléphone : une liste des équipements, le
  schéma qui se pince et se déplace, et une console plein écran
  (`#/consoles/<baie>/<équipement>`) avec une barre de touches (Échap, Tab,
  Ctrl, flèches, ?, ^C…) et un mode ligne pour taper des commandes entières.
- **La barre de la baie.** Une ligne qui dit qui tient la baie, avec le seul
  bouton utile à ce moment et le reste dans ⋯ ; sur téléphone, la toucher
  ouvre la baie en feuille.
- **Équipe.** Onglets Mon équipe, **Baie** (nouveau : l'état de la baie, ses
  demandes, ses occupants et son historique), Réservations (un agenda du jour
  sur téléphone) et, pour les administrateurs, Toutes les équipes.
- **Sauvegardes.** Sauvegarder, injecter ou comparer depuis l'en-tête ; une
  carte de progression pour la tâche en cours ; sauvegardes, modèles de TP et
  tâches en listes qui deviennent des cartes sur téléphone.
- **L'Accueil** commence par ce qui vous attend (demandes, invitations, baie
  bientôt libérée) et reprend l'ancienne Vue d'ensemble sous le nom « Le
  labo ».
- **Admin** regroupe ses écrans (Comptes, Labo, Suivi) : une liste à gauche
  sur PC, un sommaire sur téléphone. L'Aide, Mon compte et les pages de
  connexion sont aussi revues pour le téléphone.
- Composants communs : en-tête de page, listes qui deviennent des cartes sur
  téléphone, fenêtres qui deviennent des feuilles en bas de l'écran, menus,
  panneaux latéraux ; cibles tactiles de 44 px, texte de 12 px au moins,
  contraste AA dans les deux thèmes.
- Corrigé : le mot « null » affiché dans l'aperçu d'une injection et dans
  l'en-tête de certaines listes.

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
- Une section dont les données arrivent après que l'utilisateur est passé à
  une autre ne reprend plus l'adresse (Sauvegardes le faisait, quittée vite).

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
