# ADR-0009 — VigiEau : double requête coordonnées + commune, niveau le plus grave retenu

- **Date** : 15 juillet 2026
- **Statut** : Accepté

## Contexte

Le 15/07/2026, un habitant constate que le site officiel vigieau.gouv.fr affiche
**« alerte renforcée »** pour l'eau potable à son adresse (Mézières-lez-Cléry),
alors que l'app MAT (ligne « Restrictions » de la section 💧 Eau) affiche
**« vigilance »**. L'app sous-estimait donc les restrictions en vigueur.

La cause est dans l'API officielle `api.vigieau.gouv.fr/api/zones`, qui a **deux
chemins de résolution distincts** (code source : `MTES-MCT/vigieau-api`,
`zones.service.ts`) :

- **par coordonnées** (`lon`/`lat`) : recherche géométrique (point dans polygone)
  — c'est le chemin que vigieau.gouv.fr utilise quand un habitant saisit son
  adresse (le frontend `secheresse-front` passe `lon`, `lat` et `commune` pour
  tout type d'adresse autre que « municipality ») ;
- **par commune** (`commune=INSEE` seul) : lecture d'un index commune→zones
  pré-construit à partir des listes de communes attachées aux zones.

Ces deux chemins **peuvent diverger** quand les données amont sont incohérentes :
ici, la zone **AEP** (eau potable, réseau de distribution) en alerte renforcée
couvre géométriquement le bourg mais n'était pas rattachée à la commune 45203
dans l'index — la requête par commune ne renvoyait que des zones en vigilance.
L'app (frontend `mat-eau8.js` et backend `lib/vigieau.js`) interrogeait
uniquement par commune.

## Décision

`fetchVigieauStatus` (backend) et `mat-eau8.js` (frontend) interrogent l'API
**deux fois en parallèle** :

1. `?lon={VIGIEAU_LON}&lat={VIGIEAU_LAT}&commune={INSEE}&profil=particulier`
   — coordonnées du **bourg** (défaut : les coordonnées météo de la commune,
   `OPEN_METEO_LAT`/`OPEN_METEO_LON`, surchargeables par `VIGIEAU_LAT`/`VIGIEAU_LON`) ;
2. `?commune={INSEE}&profil=particulier` — l'ancienne requête, conservée.

et retiennent le **niveau le plus grave** des réponses exploitables. Une requête
en échec (réseau, HTTP, 409 multi-zones, corps invalide) est ignorée si l'autre
est exploitable ; si les deux échouent, le statut reste indéterminé (`level: null`,
aucune action — comportement inchangé).

Le principe existant est renforcé : **ne jamais sous-estimer les restrictions**
(pendant du « jamais de faux “aucune restriction” » déjà en place).

## Alternatives écartées

- **Coordonnées seules** (répliquer exactement le site officiel) : si la géométrie
  d'une zone est incomplète alors que le rattachement commune existe (cas inverse
  du bug), on sous-estimerait à nouveau. La double requête couvre les deux sens
  de divergence pour un coût négligeable (2 appels par cycle de 6 h).
- **Requêtes par type de zone** (`zoneType=SUP/SOU/AEP` × 2 chemins) : 6 appels
  et aucune information de plus que la double requête sans `zoneType`.

## Conséquences

**Positives :**
- Le niveau affiché/notifié correspond au pire de ce que l'API sait, quel que
  soit le chemin de résolution — l'app ne peut plus être « en retard » sur le
  site officiel pour le bourg.
- Le cas 409 (commune multi-zones) devient résoluble : la requête par
  coordonnées, elle, tombe dans une seule zone par type.

**Négatives / compromis acceptés :**
- Le niveau retenu est celui du **bourg** : un habitant d'un écart desservi par
  un autre réseau AEP peut voir un niveau différent pour son adresse exacte sur
  vigieau.gouv.fr (le lien « consignes officielles » reste affiché pour cela).
- Deux appels API au lieu d'un par cycle — négligeable (cycle de 6 h).

**Points de vigilance :**
- Les seuils de notification (ADR-0005) et la séparation d'avec la vigilance
  météo (ADR-0004) sont inchangés.
- Frontend et backend appliquent la **même logique** : toute évolution de l'un
  doit être répercutée sur l'autre (`app-mezieres/js/mat-eau8.js`).
