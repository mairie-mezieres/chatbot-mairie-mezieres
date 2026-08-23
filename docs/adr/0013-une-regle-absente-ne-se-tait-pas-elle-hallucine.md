# ADR-0013 — Une règle absente ne se tait pas, elle hallucine

- **Date** : 23 août 2026
- **Statut** : Accepté

## Contexte

Le changelog de l'application, version **4.15 (31 mai 2026)**, annonce noir sur blanc :

> **MEL** : règle directe pour les horaires de bruit et de bricolage (arrêté municipal)

L'entrée figure aussi dans l'overlay « Nouveautés » vu par les habitants
(`app-mezieres/index.html`) et dans `CHANGELOG.md`. Trois mois plus tard, un élu pose la
question à MEL et obtient **deux réponses différentes, toutes les deux fausses** :

| Question | Réponse de MEL |
|---|---|
| « Quelles sont les horaires de bruit » | « Je n'ai pas cette information précise dans mon contexte… » |
| « À quelle heure j'ai le droit de faire du bruit ? » | « … les travaux bruyants sont interdits **du lundi au samedi de 22h à 7h**, et **les dimanches et jours fériés toute la journée**… consulter l'**arrêté municipal** en mairie. » |

Vérification faite, **la règle n'a jamais existé** : aucune entrée `bruit` dans
`DIRECT_RULES`, aucun mot-clé dans `KEYWORDS`, aucune branche dans l'arbre de décision
(`app-mezieres/data/mel-tree.json`), aucune fiche dans le guide d'arrivée. Le changelog
décrivait une intention, pas un état du code, et personne ne l'a `grep`.

Deux enseignements, l'un plus grave que l'autre.

**1. Le silence n'est pas le mode d'échec par défaut.** On imagine volontiers qu'une
connaissance manquante produit un « je ne sais pas ». C'est vrai pour une formulation, et
faux pour la suivante : reformulée, la même question a produit une réponse **assurée,
plausible, structurée en puces, avec le bon numéro de mairie** — et des horaires inventés.
Pire, elle les attribuait à un « arrêté municipal » qui n'existe pas. Un habitant n'a
aucun moyen de distinguer cette réponse d'une vraie.

**2. Les horaires sont préfectoraux, pas municipaux.** Mézières-lez-Cléry n'a pas d'arrêté
propre sur le bruit. C'est l'**arrêté préfectoral du Loiret du 1er mars 1999** relatif à
la lutte contre les bruits de voisinage qui s'applique, comme dans toutes les communes du
département. Il autorise les outils bruyants (tondeuse, taille-haie, tronçonneuse,
perceuse, nettoyeur haute pression…) :

- du **lundi au vendredi** de 8h30 à 12h et de **14h30** à 19h30 ;
- le **samedi** de 9h à 12h et de 15h à 19h ;
- le **dimanche et les jours fériés** de 10h à 12h.

La plage de l'après-midi en semaine démarre à **14h30**, pas à 14h — l'écart de trente
minutes entre la mémoire commune et le texte a failli être recopié tel quel.

Ces horaires ne concernent que ces outils. La règle générale, elle, s'applique en
permanence, de jour comme de nuit : aucun bruit ne doit, par sa durée, sa répétition ou
son intensité, porter atteinte à la tranquillité du voisinage.

## Décision

Nous ajoutons la `DIRECT_RULE` `bruit_travaux_horaires` (`lib/mel.js`), qui énonce les
trois plages et nomme l'arrêté préfectoral, et un bloc **BRUITS DE VOISINAGE** dans le
`SYSTEM_PROMPT` pour couvrir les formulations qui passeraient à travers la regex.

Le bloc du prompt ne se contente pas de donner les bons horaires : il **interdit
explicitement** d'en énoncer d'autres et de prêter à la commune un arrêté municipal. Une
connaissance ajoutée sans interdiction laisse le modèle libre de préférer sa propre
version quand la question est posée autrement — c'est précisément ce qui s'est produit.

`test/bruit.test.js` verrouille les deux faces :

- les plages exactes de l'arrêté sont présentes ;
- **les plages hallucinées en production sont absentes** (`22h à 7h`, `toute la journée`,
  `arrêté municipal`) ;
- neuf formulations d'habitants trouvent la règle ;
- cinq questions d'horaires d'un autre sujet (mairie, déchetterie, bus, collecte) ne
  tombent pas dessus ;
- aucune règle placée avant elle dans `DIRECT_RULES` ne la masque.

## Conséquences

**Positives :**
- La question part en réponse directe : instantanée, gratuite, et surtout **sans marge
  d'hallucination**.
- Le test d'absence est aussi important que le test de présence. Vérifier qu'une réponse
  contient le bon horaire ne dit rien du mauvais horaire qu'elle pourrait contenir en
  plus ; ici, les deux mauvaises plages étaient connues, il aurait été absurde de ne pas
  les verrouiller.
- Un topic `bruit` dans `KEYWORDS` fait remonter le sujet dans les statistiques de l'admin.

**Négatives / compromis acceptés :**
- L'information vit maintenant à **deux** endroits (la règle et le prompt système). C'est
  la même classe de double source que les associations ou la fibre. `CLAUDE.md` la
  signale ; les deux doivent bouger ensemble.
- La regex est volontairement large sur les termes qui ne peuvent désigner qu'une
  nuisance sonore (`tapage`, `tondre`, `taille-haie`…) et exige un croisement avec une
  demande d'horaire pour les termes ambigus (`bruit`, `scie`, `bricol`). Sans ce
  croisement, « le bruit de la collecte des poubelles » serait parti sur l'arrêté
  préfectoral.
- Nous n'avons **pas** ajouté de branche à l'arbre de décision ni de fiche au guide
  d'arrivée : cela porterait les horaires à quatre exemplaires. Si la mairie le souhaite,
  l'arbre est éditable depuis l'admin, sans code.

**Points de vigilance pour les futures évolutions :**
- **Un changelog n'est pas une preuve d'existence.** Avant de répondre « c'est déjà fait »
  sur la foi d'une entrée de version, `grep` le code. La règle d'or du `CLAUDE.md`
  (« vérifier qu'une fonctionnalité n'existe pas déjà ») a un symétrique : vérifier
  qu'une fonctionnalité annoncée existe bel et bien.
- Si un jour la commune prend son **propre** arrêté municipal sur le bruit, il primera sur
  l'arrêté préfectoral et les deux endroits ci-dessus devront être repris — l'ADR aussi.
- Ne pas écrire l'URL de l'arrêté sur `loiret.gouv.fr` dans `lib/` : l'arborescence du
  site préfectoral a déjà changé (`/Actions-de-l-Etat/…` → `/Politiques-publiques/…`) et
  le scan `liens-morts.yml` ouvrirait une issue. Nommer le texte et sa date suffit.

---

## Deuxième occurrence — la salle communale (23 août 2026, même journée)

Le même jour, dans la même série de questions de contrôle :

> « Je souhaite louer la salle des fêtes, quel est le tarif pour le 1er week-end
> d'octobre 2026 ? »

Classée « autre », MEL a improvisé. Or **la salle communale n'est plus proposée à la
location** — il n'existe ni tarif, ni calendrier, à aucune date.

Le cas est instructif parce qu'il diffère du premier sur un point : ici, **le fait
existait bel et bien dans le dépôt**. Il était simplement inatteignable.

- Dans `app-mezieres/data/mel-tree.json`, rubrique « Location de matériel » : la phrase
  « en ce qui concerne la salle communale, elle ne pourra plus être louée désormais »
  est la **9ᵉ ligne d'un paragraphe de 200 mots** recopié de l'ancien site WordPress,
  entre les tarifs des barnums et la formule de politesse finale.
- Dans `app-mezieres/js/mat-mel.js`, la **même rubrique** de l'autre copie de l'arbre
  n'en dit **rien du tout**. Les deux copies divergeaient sur un fait, pas sur une
  formulation.
- `data/saviez-vous.json` porte pourtant l'entrée `salle-communale-location`, correcte
  et sourcée — mais c'est un corpus de culture générale, que rien ne relie à MEL.
- Le backend, lui, n'en savait rien du tout : ni `DIRECT_RULES`, ni `SYSTEM_PROMPT`.

**Un fait enfoui n'est pas un fait connu.** Une information vraie, exacte et présente dans
le dépôt ne protège de rien si elle n'est pas là où le code la lit. Trois copies, une
seule portait le fait, et ce n'était pas celle que MEL consulte.

### Ce que nous en faisons

`DIRECT_RULE` `location_salle_materiel` + bloc `SALLE COMMUNALE ET LOCATION DE MATÉRIEL`
dans le `SYSTEM_PROMPT`, sur le même modèle que le bruit : la connaissance **et**
l'interdiction. Ici l'interdiction porte sur les tarifs, les montants de caution et les
disponibilités — et explicitement sur la tournure « en vérifiant les disponibilités »,
qui laisserait croire que la salle est réservable.

Côté app, la rubrique « Location de matériel communal » annonce le fait **en première
phrase**, dans les **deux** copies de l'arbre.

### Le choix de ne PAS recopier les tarifs

Les prix (tables et chaises, barnums 6×8 et 6×12, chèque de caution) vivent dans l'arbre
de décision, que la mairie édite depuis l'admin **sans passer par le code**. Les recopier
dans `lib/mel.js` aurait rendu la réponse plus complète — et créé une double source vouée
à diverger au premier changement de tarif, sans que rien ne le signale. Même piège que les
associations et la fibre, tous deux déjà documentés.

La règle nomme donc le matériel disponible et renvoie à la mairie pour les montants.
`test/location-salle.test.js` vérifie qu'**aucun montant en euros** n'apparaît dans la
réponse : la tentation reviendra, le test la refusera.

### Au passage

La rubrique portait un lien mort — `mezieres-lez-clery.fr/2018/10/24/location-de-materiel/`
— vers l'ancien site WordPress, dont le domaine sert désormais l'application. C'était la
dernière URL de ce type dans `data/` et `js/` ; `data/` n'est pas couvert par le scan
`liens-morts.yml`, ce qui explique qu'elle ait survécu.
