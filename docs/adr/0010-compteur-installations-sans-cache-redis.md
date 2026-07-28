# ADR-0010 — Compteur public d'installations servi sans cache Redis

**Date** : 2026-07-28
**Statut** : accepté

## Contexte

Deux affichages du même chiffre divergeaient durablement :

- le **mail récapitulatif quotidien** (« Installations PWA (total) ») annonçait
  585 ;
- le **badge de l'app** (« 🏘️ N Macérien(ne)s ont installé MAT ») affichait 323,
  **inchangé depuis plusieurs jours**.

Les deux lisent pourtant la même donnée, `stats.services.installation` (clé Redis
`mat:stats`). L'écart venait du chemin de lecture du badge :

```js
// ancienne version de GET /api/install-count
const cached = await redisGet("mat:install_count_cache");
if (cached !== null && cached !== undefined) return res.json({ count: cached });
// … sinon seulement : lecture de mat:stats + SETEX 24 h
```

La clé de cache faisait autorité **si elle existait**, et n'était ré-écrite (avec
son TTL de 24 h) que sur un *cache miss*. Toute valeur posée dans cette clé sans
expiration — import, migration, correction manuelle depuis la console Upstash —
gelait donc le compteur public **indéfiniment** : le total réel continuait de
monter dans `mat:stats` (mail, tableau de bord), le badge restait figé sur la
valeur écrite une fois pour toutes. Un second cache de 24 h côté navigateur
(`localStorage`) rendait le diagnostic encore plus confus.

Ce cache Redis ne rendait par ailleurs aucun service : `readStats()` sert déjà
depuis le **cache mémoire du serveur** (`lib/store.js`, flush périodique vers
Redis). Lire `mat:install_count_cache` coûtait **une commande Redis par appel**
là où lire `mat:stats` en mémoire en coûte zéro — le cache consommait le quota
Upstash qu'il était censé protéger.

## Décision

`GET /api/install-count` lit **uniquement** `readStats()` :

- source unique partagée avec le mail quotidien et le tableau de bord admin — les
  trois affichages ne peuvent plus diverger ;
- zéro commande Redis en régime permanent (cache mémoire de `lib/store.js`) ;
- la clé `mat:install_count_cache` est **purgée une fois par process** (best
  effort) pour qu'un reliquat sans TTL ne traîne pas en base.

Deux garde-fous accompagnent la décision :

1. **Diagnostic** (onglet 🧪 Services → « 🏘️ Compteur installations ») : affiche
   le total, les installations du jour, et passe en `warn` si
   `mat:install_count_cache` réapparaît (valeur + TTL).
2. **Tests** (`test/routes.test.js`) : le total renvoyé suit `services.installation`
   immédiatement, sans TTL à attendre.

Côté app, le cache `localStorage` du badge est conservé (affichage instantané)
mais passe en **stale-while-revalidate** : la valeur en cache s'affiche tout de
suite, puis un rafraîchissement en arrière-plan (au plus une fois par heure) met
le badge à jour dans la même session.

## Conséquences

- Le badge de l'app suit le total réel, au plus une heure de retard côté client.
- Ne **jamais** ré-introduire un cache Redis « valeur seule » qui fait autorité :
  s'il en faut un, stocker `{ value, ts }` et recalculer quand `ts` est trop
  ancien, pour qu'une clé sans TTL ne puisse pas geler un affichage.
- Une correction manuelle du compteur doit se faire sur `mat:stats`
  (`services.installation`), la seule source de vérité — plus sur une clé de
  cache.
- Le total reste un compteur d'**événements d'installation** : un réinstall ou un
  vidage du stockage du navigateur recompte l'appareil (voir
  `app-mezieres/js/mat-core.js`, drapeau `mat_install_tracked`).
