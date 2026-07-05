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
  `fetch` natif (aucune dépendance). `npm test` = `node --test --test-force-exit` (le force-exit
  est requis car des modules enregistrent des `setInterval` au niveau module).
- Couvrir en priorité les chemins **sans appel réseau sortant réel** (validation HMAC, auth admin,
  santé, CORS, rejets de validation) ou mocker, pour rester déterministe hors-ligne.
- **Validation des entrées** : helpers sans dépendance dans `lib/validate.js`
  (`capStr`, `finiteNum`, `safeId`, `inEnum`, `geoPoint`). Utiliser ces helpers pour plafonner /
  normaliser les entrées citoyennes plutôt que de réécrire `String(x).substring(...)` à la main.

## Journal d'audit admin

- Toute **action admin destructrice** (suppression actu/idée/sondage/photo, purge) doit appeler
  `logAudit(action, detail)` de `lib/logger.js` (même flux que les logs serveur, **sans** la
  limitation de débit). Les entrées apparaissent dans l'onglet 🪲 Logs (module `audit`).

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
