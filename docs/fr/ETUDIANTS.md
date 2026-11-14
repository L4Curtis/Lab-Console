# Lab Console : guide pour les étudiants et les enseignants

[English](../STUDENTS.md) · **Français**

Lab Console vous donne dans le navigateur les consoles des routeurs et des
commutateurs du labo. La page **Aide** de l'application dit la même chose, et
une courte visite guidée démarre à votre première connexion (rejouez-la depuis
le menu utilisateur).

## Se connecter

Utilisez le bouton du fournisseur d'identité de votre école. Si votre
enseignant vous a donné un lien d'invitation, ouvrez-le, choisissez un nom et
un mot de passe, puis connectez-vous avec **Compte local**. Une clé d'accès
peut s'ajouter dans **Mon compte** pour se connecter en un clic. Il n'y a pas
d'e-mail : si vous oubliez un mot de passe, demandez un lien de
réinitialisation à un administrateur.

## Consoles

1. Choisissez un labo et une baie, puis cliquez sur un équipement du schéma :
   sa console s'ouvre à côté. Ouvrez-en plusieurs pour travailler côte à côte.
   `Ctrl K` (ou `/`) trouve un équipement dans n'importe quel labo.
2. Une ligne de console est partagée. Si quelqu'un l'a déjà ouverte, vous la
   rejoignez et voyez le même écran ; **une seule personne tape** (le pilote),
   les autres regardent. Demandez le clavier avec le bouton de la tuile : le
   pilote répond, ou il passe au bout de 30 secondes, ou tout de suite si le
   pilote est inactif depuis 2 minutes.
3. Une ligne se ferme 30 secondes après le départ de la dernière personne, ou
   après une heure sans frappe.
4. `Ctrl Maj C` copie, `Ctrl V` colle (un long collage est envoyé ligne par
   ligne pour que l'équipement ne perde pas de caractères). *Envoyer BREAK* est
   un bouton ; `Ctrl+]` n'atteint jamais l'équipement.
5. **Historique** cherche ce qu'une console a affiché. **Exporter la config**
   enregistre la running-config. **Injecter un script** et **envoyer à
   plusieurs consoles** envoient des lignes à vos équipements. La
   **bibliothèque de scripts** garde vos scripts, ceux de votre équipe et les
   scripts publiés.

## Équipes et baies

- Dans **Équipe**, créez une équipe et invitez vos camarades par nom
  d'utilisateur (8 membres au plus, invitations en attente comprises).
- Un membre **prend une baie** pour l'équipe. Tant qu'une équipe la tient,
  seuls ses membres, leurs invités acceptés et les administrateurs ouvrent ou
  pilotent ses consoles ; chacun peut encore regarder une ligne déjà ouverte.
  Une baie inutilisée est libérée après 3 heures (ce réglage peut différer).
- Un enseignant peut verrouiller une baie en donnant un motif. Le
  **calendrier** d'une baie permet à une équipe de réserver des créneaux et
  prévient avant le créneau d'une autre équipe.
- Chaque équipement a une **note** que tout le monde lit sur le schéma et que
  les occupants de la baie écrivent ; chaque baie a un petit **chat** pour ses
  occupants. Les notifications (la cloche) préviennent quand quelqu'un demande
  le clavier, qu'une ligne se libère ou qu'une tâche se termine, seulement
  quand la fenêtre n'est pas au premier plan.

## Sauvegardes, injection et remise à zéro

Les tâches travaillent sur toute la baie, tournent sur le serveur et tout le
monde les voit en direct.

- **Sauvegarde** : running-config, VLAN et VTP de chaque équipement, gardés
  comme une sauvegarde de votre équipe. **Téléchargez le ZIP tout de suite** :
  le serveur n'est pas votre sauvegarde. Les sauvegardes se listent, se lisent,
  se comparent (deux sauvegardes, ou une contre les équipements en direct) et
  se recherchent.
- **Injection** : montre le script exact de chaque équipement, puis relit
  l'équipement et compare.
- **Remise à zéro** : dit ce qui sera effacé et qui est sur les consoles,
  demande de taper le nom de la baie et décompte 10 secondes pendant lesquelles
  chacun peut annuler. Un équipement n'est jamais effacé sans sauvegarde
  vérifiée.
- Les enseignants publient des **modèles de TP** depuis une sauvegarde (ou
  importent un ZIP). Seuls les équipements Cisco IOS / IOS XE sont touchés.
- Quand une baie est libérée, son équipe peut faire une sauvegarde pendant 30
  minutes.

## Vérifications et récupération de mot de passe

- **Vérifications** (bouton au-dessus du schéma) : état des lignes, câblage
  contre le schéma, matrice de ping entre les routeurs, adresses des
  interfaces. Commandes en lecture seule ; une ligne utilisée n'est jamais
  touchée.
- **Récupération de mot de passe** (bouton sur une tuile de console) : une
  procédure guidée pour un équipement verrouillé par un mot de passe inconnu.
  Elle demande quelqu'un sur place pour éteindre et rallumer l'équipement. La
  startup-config est contournée pour un démarrage, jamais effacée. Elle n'a pas
  encore été essayée sur tous les modèles réels, et le dit.

## Accueil, vue d'ensemble et aide

**Accueil** est la page après la connexion : votre équipe, vos invitations,
votre baie avec ses dernières sauvegardes et son activité, vos prochains
créneaux. **Vue d'ensemble** montre une carte en direct par baie. **Aide**
explique chaque section.

## Bonnes habitudes

- Téléchargez vos sauvegardes. Ne comptez pas sur une console restée comme vous
  l'avez laissée.
- Seule l'équipe qui tient une baie en modifie les équipements : demandez
  avant de rejoindre une ligne qui appartient à quelqu'un d'autre.
- Ne tapez jamais dans une console un mot de passe qui compte : ce que les
  équipements affichent (pas ce que vous tapez) est gardé au journal 14 jours
  par défaut, et lu par les personnes qui étaient sur cette console ce jour-là,
  leur équipe et les administrateurs.
- Les mots de passe du labo ne vous sont jamais montrés ; ne les cherchez pas.
