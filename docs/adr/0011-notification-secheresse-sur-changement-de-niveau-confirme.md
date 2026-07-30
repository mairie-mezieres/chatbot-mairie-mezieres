# ADR-0011 — Sécheresse : notifier sur un changement de NIVEAU, et exiger une lecture complète pour acter une baisse

- **Date** : 30 juillet 2026
- **Statut** : Accepté
- **Remplace** : la déduplication par signature `niveau|arrêté` de l'ADR-0005 (le
  seuil de notification — Alerte — reste inchangé)

## Contexte

Les 29 et 30/07/2026, un habitant reçoit **deux notifications sécheresse à un jour
d'intervalle** (« alerte » puis « crise ») alors que la commune était en **crise**
sans discontinuer — le niveau n'avait jamais bougé.

La déduplication reposait sur `mat:vigieau:last.sig = "{niveau}|{arrêté}"` :
on republiait dès que **la signature** changeait. Trois mécanismes pouvaient la
faire changer sans qu'aucune restriction n'ait évolué :

1. **Lecture partielle.** `fetchVigieauStatus` interroge VigiEau deux fois
   (coordonnées + commune, ADR-0009) et retient le niveau le plus grave des
   réponses **exploitables**. Si la requête qui voyait la crise échoue (timeout,
   5xx), le niveau retombe à celui de l'autre requête — voire à `0` si l'index
   commune→zones renvoie un tableau vide. Le cycle suivant, la requête repasse :
   le niveau « remonte » et une notification repart. Pire, une chute à `0`
   déclenchait une actu « ✅ fin des restrictions » en pleine crise.
2. **Arrêté / zone la plus grave instable.** À gravité égale, la zone retenue
   (et donc l'`arrete.id` de la signature) dépendait de l'ordre de la réponse API
   et de *quelle* requête avait abouti — deux textes de notification identiques
   pour deux signatures différentes.
3. **Redis en hoquet.** `redisGet` renvoie `null` aussi bien pour « clé absente »
   que pour « Upstash 429 / timeout » : un hoquet effaçait la mémoire du dernier
   niveau notifié et relançait la notification.

## Décision

**Ce qui déclenche une notification, c'est un changement de NIVEAU confirmé** — pas
un changement de signature. La décision est isolée dans une fonction **pure**,
`decideDroughtAction` (`lib/vigieau.js`), testable sans réseau ni Redis :

| Situation | Action |
|---|---|
| Niveau **inchangé** (même si l'arrêté change) | **Aucune notification** |
| **Montée** (≥ 2) | Notification **immédiate**, même sur lecture partielle |
| **Baisse** sur lecture **partielle** | Ignorée, et le niveau lu **n'est pas mémorisé** |
| **Baisse** sur lecture **complète** | Notifiée après `DESCENT_CONFIRMATIONS` (2) lectures complètes consécutives |
| Niveau **indéterminé** (`level: null`) | Aucune action, état mémorisé intact |

Deux notions nouvelles rendent la règle applicable :

- **`status.complete`** : toutes les requêtes VigiEau ont abouti. Une lecture
  partielle ne peut que **sous-estimer** le niveau (elle voit moins de zones) —
  elle est donc valable pour **alerter**, jamais pour **rassurer**.
- **Miroir mémoire** de `mat:vigieau:last` et `mat:vigieau:pending`
  (`routes/eau.js`, même principe que l'ADR-0007) : un `redisGet` à `null` ne fait
  plus perdre la mémoire du dernier niveau notifié.

La zone « la plus grave » est en outre départagée de façon **déterministe** à
gravité égale (celle qui porte un arrêté, puis le plus petit `id`).

Le point crucial : tant qu'une baisse n'est pas confirmée, **on ne mémorise pas le
niveau lu** (`memorize: false`). Sinon le retour au niveau réel serait vu comme une
montée — exactement la boucle de notifications constatée.

## Alternatives écartées

- **Se contenter d'allonger le TTL du verrou anti-course** (`mat:vigieau:claim:*`,
  2 h) : ça n'aurait fait qu'espacer les doublons, sans traiter la cause (le niveau
  lu qui oscille) ni le faux « fin des restrictions ».
- **Notifier tout changement d'arrêté** : le texte publié (titre + consignes) est
  identique à niveau égal — l'habitant reçoit deux fois la même chose. Le détail
  par arrêté reste accessible via le lien « consignes officielles » vers
  vigieau.gouv.fr.
- **Exiger une lecture complète aussi pour les montées** : on retarderait une
  alerte réelle d'un cycle (6 h) alors qu'une lecture partielle ne peut pas
  inventer une zone. Inacceptable pour une alerte.

## Conséquences

**Positives :**
- Plus de notification en double à niveau constant, ni de fausse « fin des
  restrictions » causée par une requête VigiEau en échec.
- La décision est couverte par des tests unitaires (`test/vigieau.test.js`),
  y compris le scénario exact du bug (4 → lecture partielle 2 → 4).
- Le diagnostic 🧪 Services signale désormais une **lecture partielle** (statut
  `warn`) au lieu d'afficher un niveau possiblement sous-estimé comme un fait.

**Négatives / compromis acceptés :**
- Une **levée** réelle des restrictions est annoncée avec un cycle de retard
  (2 lectures complètes, soit ~12 h avec `DROUGHT_CHECK_INTERVAL_MS` à 6 h). Une
  fin de sécheresse n'est pas une information urgente ; la ligne « Restrictions »
  de l'app, elle, reste en temps réel.
- Un nouvel arrêté au même niveau ne déclenche plus de notification.

**Points de vigilance :**
- Le seuil de notification (Alerte, ADR-0005) et la séparation d'avec la vigilance
  météo (ADR-0004) sont inchangés.
- `?force=1` court-circuite toujours toute la logique (test manuel).
