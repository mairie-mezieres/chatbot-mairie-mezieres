# ADR-0006 — `app.js` séparé de `index.js` pour permettre les tests de routes

- **Date** : 28 juin 2026
- **Statut** : Accepté

## Contexte

Le backend n'avait **aucun test de route** : `index.js` construisait l'app Express **et**
appelait `app.listen` + démarrait le polling (météo, sécheresse) et les rappels déchets dans
le même fichier. Impossible d'importer l'app dans un test sans démarrer le serveur et toutes
ses tâches planifiées. Or le code est répliqué vers d'autres communes : une régression sur la
validation HMAC d'un webhook ou sur l'auth admin passe aujourd'hui inaperçue.

## Décision

Nous séparons la **construction de l'app** de son **exécution** :

- `app.js` : middleware, CORS, montage de toutes les routes, helpers + route `/cron/dechets`,
  handler d'erreur Sentry. `module.exports = app` (aucun `listen`, aucun `setInterval`).
- `index.js` : `require('./app')`, puis `app.listen`, polling, planificateur déchets, arrêt
  gracieux, handlers `uncaughtException`/`unhandledRejection`.

Les **tests d'intégration** (`test/routes.test.js`) importent `app.js`, font `app.listen(0)`
et tapent les routes via **`fetch` natif** (Node 22) — **sans dépendance** (pas de supertest),
cohérent avec la philosophie minimaliste du projet. Le script `npm test` utilise
`--test-force-exit` car des modules chargés enregistrent des `setInterval` au niveau module
(store, mel, admin-actus…) qui maintiendraient sinon le runner en vie.

## Conséquences

**Positives :**
- Tests de routes possibles (HMAC webhook, auth admin, santé, CORS) → filet anti-régression.
- Séparation claire « build » / « run » ; `app.js` réutilisable (tests, futurs outils).

**Négatives / compromis acceptés :**
- `--test-force-exit` masque d'éventuelles fuites de timers : acceptable, ce sont des `setInterval`
  de production volontaires. Une amélioration future serait de les `.unref()`.
- Deux fichiers au lieu d'un ; le planificateur déchets (index) et son helper (app) sont séparés.

**Points de vigilance :**
- Toute nouvelle route se monte dans `app.js` (pas `index.js`).
- Les tests ne doivent couvrir que des chemins sans effet réseau sortant réel (ou mocker), pour
  rester déterministes hors-ligne.
