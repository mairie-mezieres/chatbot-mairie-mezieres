# ADR-0007 — Miroir mémoire pour les listes programmées (quota Redis)

**Date** : 2026-07-05
**Statut** : accepté

## Contexte

Le mail de statistiques quotidien a révélé ~2 700 commandes Redis/jour (27 % du
quota gratuit Upstash de 10 000) pour ~30 visiteurs. Le diagnostic a montré que
~95 % de cette consommation venait de **deux crons à la minute** dans
`routes/admin-actus.js` :

- cron des **notifications push programmées** → `GET mat:push:scheduled` chaque minute ;
- cron des **publications d'actus programmées** → `GET mat:actus:scheduled` chaque minute.

Soit ~2 880 GET/jour de plancher, alors que ces listes sont vides l'immense
majorité du temps. Le tick à la minute est pourtant légitime : une publication
programmée à 18h00 doit partir à 18h00.

## Décision

Les deux crons lisent un **miroir mémoire** des listes (`readScheduled` /
`writeScheduled` dans `routes/admin-actus.js`, bâtis sur `memGet`/`memSet` de
`lib/store.js`) :

- les routes admin qui créent/annulent une programmation mettent à jour le
  miroir **immédiatement** (et écrivent Redis) — la précision à la minute est
  conservée ;
- le miroir expire toutes les **10 minutes** (`SCHED_MEM_TTL`) : la relecture
  Redis périodique couvre un redémarrage Render ou une écriture perdue ;
- l'instance Render est unique : pas de désynchronisation multi-instance possible.

Consommation résiduelle : ~290 GET/jour (2 clés × 1 relecture/10 min) au lieu
de ~2 880.

## Conséquences

- La consommation Redis quotidienne totale retombe à quelques centaines de
  commandes (~3–5 % du quota), dominée par le trafic réel.
- Si l'app passait un jour en multi-instance, ce miroir devrait être revu
  (chaque instance enverrait les programmations dues selon sa copie locale).
- Effet secondaire vertueux : les routes de programmation fonctionnent
  hors-ligne (sans Redis), ce qui les rend testables en CI —
  voir `test/scheduled-mirror.test.js`.
- Règle générale (voir `CLAUDE.md` § Robustesse Redis) : **aucun cron fréquent
  ne doit interroger Redis à chaque tick** ; toujours passer par un cache
  mémoire avec re-synchro périodique.
