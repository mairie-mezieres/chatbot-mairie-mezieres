# ADR-0017 — Statistiques : un socle qui ne bouge pas, une tranche du jour qui bouge

**Date** : 2026-09-13
**Statut** : accepté

## Contexte

Le tableau de bord surveille un seul chiffre : les **commandes Redis**
(2 155 ce jour-là, 36 185 sur le mois, soit 7,2 % du quota). Tout allait donc
bien, et la question « combien d'utilisateurs puis-je encaisser, avec ou sans
les statistiques ? » semblait devoir se répondre en divisant un quota par un
nombre de commandes par visite.

L'audit a montré que la question était mal posée, pour deux raisons.

**1. Les statistiques ne coûtent presque aucune commande.** `POST /stats/track`
n'écrit qu'en mémoire ; un flush périodique persiste le tout toutes les
5 minutes. Couper les réglages « statistiques détaillées » ne libère donc
**rien** : `routes/stats-public.js` enregistre le visiteur unique *dans tous les
cas*, si bien que le cache est « dirty » à chaque fenêtre de 5 minutes, réglages
ou pas. Le seul coût par visiteur venait d'ailleurs : `GET /carburant` (appelé à
chaque ouverture de l'app) et `GET /sondages` (une lecture Redis par sondage
actif), seules routes publiques sans miroir mémoire.

**2. Ce que les statistiques coûtent, ce sont des octets.** `mat:stats` était
**un seul JSON réécrit intégralement** 288 fois par jour. Sa taille ne dépendait
pas du trafic du moment mais de l'historique accumulé :

- `uniqueUsers.byDay[jour]` conservait **la liste des identifiants d'appareils**,
  jour par jour, et n'était **jamais élaguée** (seul le bouton Purge de l'admin
  le faisait, à la main) — alors que plus personne ne lisait ces listes autrement
  que par leur `.length` ;
- `uniqueUsers.allDevices` gardait à vie un identifiant par appareil, pour n'en
  lire que la longueur ;
- `deviceStats.daySeen` gardait une fiche d'appareil complète (modèle, OS,
  navigateur, écran) **par appareil et par jour, sur 90 jours**, alors que seule
  celle du jour en cours est lue ;
- `deviceStats.monthSeen` faisait la même chose **par mois, sur 24 mois** — soit
  l'union des `daySeen` du mois, pour une déduplication que `uniqueUsers.byMonth`
  assurait déjà trois lignes plus haut.

À 1 Mo de blob, cela fait ~300 Mo par jour et ~10 Go par mois : l'enveloppe de
bande passante gratuite d'Upstash entière, pour une commune de 1 500 habitants.
Le plafond réel n'était donc pas de quelques milliers de visiteurs par jour mais
d'une **trentaine** — et rien dans l'admin ne le montrait, puisque la seule
jauge affichée était celle des commandes.

**3. Une lecture ratée se lisait comme une base vide.** `readStats()` faisait
`(await redisGet("mat:stats")) || {}`. Or `redisGet` renvoie `null` aussi bien
pour « clé absente » que pour « timeout / 429 / réseau ». Un échec de lecture au
démarrage — d'autant plus probable que le blob était gros et le timeout de 8 s —
repartait donc d'un objet vide, que le flush suivant publiait **par-dessus tout
l'historique**, cinq minutes plus tard, sans un mot dans les logs.

## Décision

**1. Deux clés, séparées par leur rythme de changement** (`lib/stats-store.js`) :

| Clé | Contenu | Réécrite |
|---|---|---|
| `mat:stats:courant` | jour + mois en cours, compteurs cumulés | à chaque flush |
| `mat:stats:socle` | tout l'historique clos | quand il change, ou 1 ×/jour |

La signature qui décide de réécrire le socle **exclut les compteurs cumulés** :
sans cela, le trafic de la journée ferait réécrire l'historique entier toutes
les 5 minutes, ce qu'on cherchait précisément à éviter.

**2. L'objet en mémoire ne change pas de forme.** Tout le code appelant
(`readStats`/`writeStats`) est inchangé : seule la persistance est découpée.
Une seule exception, assumée : une période **close** est réduite à son
**compte** (`uniqueUsers.byDay["2026-09-12"] = 2` au lieu d'une liste de deux
identifiants). D'où `nbUniques()`, qui lit indifféremment une liste ou un
nombre, et qu'il faut utiliser partout où l'on écrivait `(… || []).length`.

**3. Rétentions automatiques**, appliquées au chargement et à chaque flush, au
lieu du bouton de purge manuel : 400 jours pour `parJour` et les comptes
journaliers, 90 jours pour les répartitions d'appareils, 24 mois pour le
mensuel, `daySeen` réduit au jour en cours, `monthSeen` supprimé,
`allDevices` plafonné à 20 000 entrées avec un `total` devenu **compteur**
autoritaire (il ne régresse jamais, même si la liste est rognée).

**4. Une lecture ratée ne peut plus être publiée.** `redisGetResult()` distingue
`{ok:false}` (Redis injoignable) de `{value:null}` (clé absente). Tant que la
lecture n'a pas réussi, le service **compte en mémoire mais ne flushe pas**, et
retente toutes les minutes. Si l'écriture du socle échoue, la tranche du jour
n'est pas écrite non plus : on ne sépare jamais un socle périmé d'une tranche à
jour.

**5. Miroirs mémoire** sur les deux dernières routes publiques qui lisaient Redis
à chaque visite : `GET /carburant` et les résultats de sondage.

**6. La route publique `GET /stats` ne publie plus d'identifiants.**
`allDevices` avait bien été retiré « pour RGPD », mais `byDay`, `byMonth` et
`deviceStats.daySeen` exposaient la même chose — l'identifiant d'un appareil,
daté, avec son modèle, son OS et sa taille d'écran — sur une route sans
authentification. Elle ne renvoie plus que des comptes.

## Conséquences

- Bande passante des statistiques divisée par ~20 ; le plafond passe d'environ
  30 à ~10 000 visiteurs par jour, et redevient celui des commandes.
- Les statistiques peuvent **rester activées** : c'était le sens de la question.
- `bandePassanteJourMo` apparaît dans le bloc Redis du tableau de bord : le
  chiffre qui manquait pour voir venir le mur.
- **Ne jamais réintroduire de `.length` sur `byDay`/`byMonth`** : une période
  close y est un nombre, et `?.length` y vaudrait `undefined`, donc `0` — le
  mail annoncerait « aucun visiteur hier ».
- Toute lecture Redis **suivie d'une réécriture** doit passer par
  `redisGetResult` : `redisGet` ne peut pas dire si la clé est vide ou si la
  base est tombée.
- Le miroir mémoire des résultats de sondage doit être invalidé à la suppression
  d'un sondage (`forgetSondageResults`), sinon il survit à la clé Redis.
- Reste ouvert : la carte « Commandes aujourd'hui » compare encore à
  10 000/jour, plafond de l'ancienne formule Upstash (500 000/mois depuis mars
  2025). Le pourcentage journalier est pessimiste ; c'est la carte mensuelle qui
  fait foi.
