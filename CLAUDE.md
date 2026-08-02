# Instructions pour Claude Code — MAT Backend (Mézières Avec Toi)

## 📚 Documentation — aiguillage OBLIGATOIRE (à lire avant d'agir)

Ce fichier est le **seul** document automatiquement chargé à chaque session. Toute la
connaissance détaillée vit dans les fichiers ci-dessous. **Avant de coder, de répondre
à une question d'architecture, ou de créer une fonctionnalité, ouvre le(s) document(s)
correspondant(s)** — ne raisonne pas de mémoire et ne réinvente pas l'existant.

Règle d'or : **vérifier qu'une fonctionnalité n'existe pas déjà (code + UI admin + doc) avant de la construire.**

| Si la tâche touche à… | LIRE d'abord |
|---|---|
| Tableau de bord admin, onglets, **diagnostic 🧪 Services** (§6), env Render (§4), Sentry, FAQ dépannage | `GUIDE-ADMIN.md` |
| **Webhook Facebook `#MAT`** — fonctionnement et dépannage | `GUIDE-ADMIN.md` §5 |
| **Alertes sécheresse VigiEau** (séparées de la vigilance météo) — `lib/vigieau.js`, `routes/eau.js` | `GUIDE-ADMIN.md` §5ter |
| **Kit réplication « Partager »** — profils de communes, mail quotidien, `POST /stats/partager` | `GUIDE-ADMIN.md` §6bis |
| **Compteur d'installations** (badge app, mail, tableau de bord) — source unique `services.installation` | `GUIDE-ADMIN.md` §6ter + `docs/adr/0010-…` |
| Présentation du backend, architecture, routes, démarrage | `README.md` |
| Conformité de l'assistant MEL (AI Act, RGPD, sécurité) | `docs/note-conformite-MEL.md` |
| Sécurité, signalement de vulnérabilité, données personnelles | `SECURITY.md` |
| **Décisions d'architecture** (pourquoi Trello, pourquoi les tokens individuels, pourquoi `sub=null` sur 410…) | `docs/adr/` — un fichier par décision |
| **Côté app / PWA / Service Worker / affichage habitant** | repo `app-mezieres` → son `CLAUDE.md` puis `docs/guide-technique.md` |

> ⚠️ Avant d'ajouter quoi que ce soit au diagnostic `/admin/services/test` ou à
> l'administration, **lis `GUIDE-ADMIN.md`** : beaucoup de checks et de boutons
> (webhook Trello, webhook Facebook, listes Trello, push…) existent déjà.

Quand tu crées une doc durable, ajoute-la à ce tableau pour rester aiguillable.

## Règle de mise à jour de la documentation

**À chaque correction ou évolution du code**, avant de fermer la PR :
1. Identifier quelle(s) doc(s) décrivent la zone touchée (voir tableau ci-dessus).
2. Mettre à jour ces docs dans la **même PR** que le code.
3. Si une décision structurante est prise ou un bug non-évident corrigé → créer un ADR dans `docs/adr/`.

Cas typiques :
- Modification du comportement des push citoyens → `GUIDE-ADMIN.md` §5bis + ce `CLAUDE.md`
- Nouveau check dans le diagnostic Services → `GUIDE-ADMIN.md` §6
- Nouvelle variable d'env → `GUIDE-ADMIN.md` §4
- Décision « pourquoi on ne fait pas X » → ADR

## Notifications push citoyens (signalements / demandes / bugs)

Architecture à connaître avant toute modification des notifications :

- **Token individuel** : `mat:notify:token:{uuid}` en Redis (TTL 365 j), créé à la
  soumission d'un signalement/demande/idée. Champ `sub` = abonnement Web Push.
- **Lien carte ↔ citoyen** : le marqueur `MAT-REF: {uuid}` est écrit dans la
  description de la carte Trello. Sans lui, aucune notification possible.
- **Deux déclencheurs** envoient un push au citoyen :
  1. `PATCH /admin/signals/:id` (tableau de bord admin)
  2. `POST /trello/webhook` (changement de statut OU commentaire directement dans Trello)
- **Trois types de cartes**, routage des push (`lib/push-notify.js`) :

  | Carte | Changement de statut | Commentaire | Ouvre dans l'app |
  |---|---|---|---|
  | `[Signalement]` | `sendSignalStatusPush` | `sendSignalCommentPush` | `#signalements` |
  | `[BUG]` | `sendSignalStatusPush` | `sendBugCommentPush` | `#bugs` |
  | `[Demande]` | `sendDemandeStatusPush` | `sendDemandeCommentPush` | `#contact` |

- **Webhook Trello** : géré dans `routes/trello-webhook.js`. Enregistrement idempotent
  via `POST /admin/trello/register-webhook` ; liste via `GET /admin/trello/webhooks`.
  L'admin a déjà une UI dédiée (bouton « Activer le webhook Trello » + « Vérifier l'état »).
- **Résilience endpoint** : sur réponse 410/404 (endpoint expiré), on **ne supprime pas**
  le token — on met seulement `entry.sub = null`. Le frontend le re-lie au prochain
  chargement via `_registerPendingNotifyTokens()`.

## Structure & tests

- **`app.js`** construit l'app Express (middleware + montage des routes + route `/cron/dechets`).
  **`index.js`** ne fait que l'exécuter (`app.listen`, polling météo/sécheresse, rappels déchets,
  arrêt gracieux). → Toute **nouvelle route se monte dans `app.js`**, pas `index.js`. Voir ADR-0006.
- **Tests de routes** : `test/routes.test.js` importe `app.js`, fait `app.listen(0)` et tape via
  `fetch` natif (aucune dépendance). `npm test` = `bash scripts/run-tests.sh` : chaque fichier
  est exécuté **directement** (`node test/xxx.test.js`, mode standalone de `node:test`) — PAS
  via le runner `node --test`, dont l'IPC parent/enfant plante aléatoirement sur Node 22.23.x
  en CI (« Unable to deserialize cloned data »), avec ou sans `--test-force-exit`.
  ⚠️ Tout nouveau `setInterval` de niveau module DOIT être `.unref?.()` (store, mel,
  admin-actus, admin-email et logger le sont) — sinon les fichiers de test ne rendent plus la
  main. Nouveau fichier de test : le nommer `test/*.test.js`, il est ramassé par le script.
- Couvrir en priorité les chemins **sans appel réseau sortant réel** (validation HMAC, auth admin,
  santé, CORS, rejets de validation) ou mocker, pour rester déterministe hors-ligne.
- **Validation des entrées** : helpers sans dépendance dans `lib/validate.js`
  (`capStr`, `finiteNum`, `safeId`, `inEnum`, `geoPoint`). Utiliser ces helpers pour plafonner /
  normaliser les entrées citoyennes plutôt que de réécrire `String(x).substring(...)` à la main.

## Journal d'audit admin

- Toute **action admin destructrice** (suppression actu/idée/sondage/photo, purge) doit appeler
  `logAudit(action, detail)` de `lib/logger.js` (même flux que les logs serveur, **sans** la
  limitation de débit). Les entrées apparaissent dans l'onglet 🪲 Logs (module `audit`).

## Démarches administratives (MEL)

- Le mécanisme maison pour les démarches courantes est **`DIRECT_RULES`** (`lib/mel.js`) :
  réponse complète **instantanée, sans appel IA**, déclenchée par regex sur la question
  normalisée (`normalizeQuestion` = minuscules, **sans accents**, sans ponctuation).
  Déjà couverts : CNI, passeport, état civil, **élections (inscription + procuration)**,
  **recensement citoyen**, **PACS**, **arrivée dans la commune (nouvel habitant, changement
  d'adresse, compteurs eau/énergie, inscription scolaire)**, clôtures/abris/piscine,
  déchets, santé, OPAH, SPANC…
- ⚠️ **Le joker `.` ne suffit pas comme séparateur.** `normalizeQuestion` remplace toute
  ponctuation par une **espace** : « carte d'identité » devient `carte d identite`, soit
  **trois** caractères entre les deux mots. Un motif écrit `carte.identit` ne matche donc
  pas la formulation la plus naturelle. Écrire `carte.{0,4}identit`. Trois règles étaient
  muettes pour cette raison (CNI/pièce d'identité, maison de santé, centre de loisirs).
- ⚠️ **Écrire les liens en `https://` complet, et jamais collés à une ponctuation.**
  L'app ne rend cliquable que `https?://…` et `www.…` (`_renderDirectAnswer`,
  `app-mezieres/js/mat-mel.js`) : un domaine nu comme `exemple.fr` s'affiche mais ne
  s'ouvre pas. Et comme le motif d'URL est `[^\s<>]+`, toute ponctuation collée derrière
  est **avalée dans le href** — `(sur https://exemple.fr)` produit un lien vers
  `https://exemple.fr)`, cassé. Faire suivre l'URL d'une espace (tiret cadratin plutôt
  que parenthèse ou point). Verrouillé pour toutes les règles par un test de propriété
  dans `test/guide-arrivee.test.js`.
- ⚠️ Inutile de lister les variantes **accentuées** dans un `test` de `DIRECT_RULES` : la
  question est déjà dé-accentuée. `maison de santé` ou `crèche` dans une alternation sont
  du code mort — seule la forme sans accent peut matcher.
- **L'ordre du tableau est la priorité** : la première règle dont `test` renvoie vrai gagne.
  Le bloc « arrivée dans la commune » est placé après l'état civil (une question précise
  garde la main) et avant `cantine`/`centre_loisirs`, et sa règle parapluie
  `nouvel_habitant` vient en dernier du bloc. Ces contraintes sont verrouillées par des
  tests d'ordre dans `test/guide-arrivee.test.js`.
- MEL n'a PAS service-public.gouv.fr dans ses `SOURCES` : si elle « ne sait pas » sur une
  démarche courante, **ajouter une DIRECT_RULE** (+ mots-clés dans `KEYWORDS.demarches`
  pour les stats/pages sources) — pas de relâcher les garde-fous anti-hallucination,
  et pas de mécanisme parallèle (leçon : une PR a créé un doublon « fiches contexte »
  avant de découvrir DIRECT_RULES — règle d'or : vérifier l'existant).
- L'**arbre de décision** (admin → onglet 👩 MEL) est le 3e canal : parcours guidé
  cliquable, éditable par la mairie sans code.
  Tests : `test/demarches.test.js`, `test/guide-arrivee.test.js`.

> 📦 Le **guide d'arrivée des nouveaux habitants** est une page de l'app (repo
> `app-mezieres`, `js/mat-guide-arrivee.js`) : contenu embarqué en statique, consultable
> hors-ligne, **aucune route ni clé Redis côté backend**. Le backend n'intervient que par
> les `DIRECT_RULES` ci-dessus, pour que MEL sache répondre à la même question en langage
> naturel. Les deux doivent rester cohérents.

## Liens des réponses — vérification automatique

- Les adresses citées dans les réponses vieillissent sans prévenir. Le workflow
  `.github/workflows/liens-morts.yml` (lundi 07h30 UTC + `workflow_dispatch`) scanne
  `lib/`, `routes/` et la doc avec lychee, et **ouvre une issue** `liens-morts` si
  quelque chose casse. Le pendant existe dans `app-mezieres` pour les `.html` et `js/`.
- Origine : la règle `fibre` annonçait `valdeloire-fibre.fr`, un domaine qui **n'existe
  pas** (échec DNS), et la règle CNI renvoyait vers le site d'une seule commune. Rien ne
  le détectait — le scan de `app-mezieres` ne couvrait que ses pages HTML.
- ⚠️ **Opérateur fibre = Lysséo** (`https://lysseo.fr`), pas « Val de Loire Fibre » : ce
  dernier dessert l'Indre-et-Loire et le Loir-et-Cher, pas le Loiret. L'arbre de décision
  de MEL (`app-mezieres/js/mat-mel.js`) le disait déjà — c'était une **double source
  divergente**, la même classe de problème que pour les associations.

## Associations (grounding MEL)

- MEL ne doit JAMAIS inventer d'association : la liste officielle est la constante `ASSOCIATIONS`
  de `lib/mel.js`, injectée dans son contexte pour le topic `associations` + garde-fou dans le
  prompt système (règle 7).
- ⚠️ **Double source à garder en phase** : `lib/mel.js` `ASSOCIATIONS` (connaissance de MEL) et
  `app-mezieres/js/mat-associations.js` (affichage habitant). Les **catégories** (sport, animation…)
  viennent de la mairie et ne se déduisent pas des descriptions. (Évolution possible : un
  `data/associations.json` partagé pour supprimer la double source.)

## Robustesse Redis

- Toujours tolérer un Redis en mode dégradé (429 Upstash) : voir `_isRedis429` et les
  `.catch(() => {})` sur les écritures non critiques. Ne jamais faire dépendre une
  réponse HTTP d'une écriture Redis best-effort.
- **Quota (10 000 commandes/jour, plan gratuit)** : aucun cron fréquent ne doit
  interroger Redis à chaque tick. Pattern à suivre : cache mémoire mis à jour par les
  routes d'écriture + re-synchro Redis périodique (voir `readScheduled`/`writeScheduled`
  dans `routes/admin-actus.js`, le buffer stats de `lib/store.js`, et l'ADR-0007).
  La consommation attendue est de quelques centaines de commandes/jour — si le mail
  quotidien annonce des milliers, chercher un polling Redis dans un `setInterval`.

## ⛔ Édition de fichiers — règles non négociables

**Incident du 1ᵉʳ août 2026 (dépôt `app-mezieres`, même classe d'erreur possible ici) :**
un fichier de documentation est passé de 41 Ko à 85 Mo et a été poussé sur `main` sans
que personne ne le voie. Une substitution par script dont le motif matchait la **chaîne
vide** a inséré son bloc de remplacement entre *chaque caractère* du fichier — 39 508
copies, contenu réel entièrement détruit. Détecté seulement 2 versions plus tard.
Voir `app-mezieres/docs/adr/0009-edition-de-fichiers-verifier-avant-de-commiter.md`.

Ce qui a permis le désastre : le fichier n'a jamais été rouvert après modification, et
`git add -A` ne dit rien de la taille de ce qu'il ajoute.

**Règles :**

1. **Utiliser l'outil `Edit`** pour modifier un fichier existant. Il échoue proprement
   si le motif est absent ou ambigu — un script de substitution, non.
2. **Ne jamais** faire de `re.sub` / `sed` / `.replace()` sur un fichier entier via un
   script sans avoir vérifié que le motif ne peut pas matcher la chaîne vide
   (`*`, `?`, `{0,n}`, alternance avec branche vide…).
3. **Après toute édition automatisée, vérifier avant de commiter** :
   ```bash
   ls -la <fichier> && wc -l <fichier>
   git diff --stat --cached
   ```
   Une variation de taille sans rapport avec l'ampleur du changement = STOP.
4. Ne pas se fier au succès d'un script pour conclure que le résultat est correct :
   **relire le fichier**.
