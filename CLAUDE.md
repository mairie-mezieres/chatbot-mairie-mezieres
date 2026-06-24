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
| Présentation du backend, architecture, routes, démarrage | `README.md` |
| Conformité de l'assistant MEL (AI Act, RGPD, sécurité) | `docs/note-conformite-MEL.md` |
| Sécurité, signalement de vulnérabilité, données personnelles | `SECURITY.md` |
| **Décisions d'architecture** (pourquoi Trello, pourquoi les tokens individuels, pourquoi `sub=null` sur 410…) | `docs/adr/` — un fichier par décision |
| **Côté app / PWA / Service Worker / affichage habitant** | repo `app-mezieres` → son `CLAUDE.md` puis `docs/guide-technique.md` |

> ⚠️ Avant d'ajouter quoi que ce soit au diagnostic `/admin/services/test` ou à
> l'administration, **lis `GUIDE-ADMIN.md`** : beaucoup de checks et de boutons
> (webhook Trello, webhook Facebook, listes Trello, push…) existent déjà.

Quand tu crées une doc durable, ajoute-la à ce tableau pour rester aiguillable.

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

## Robustesse Redis

- Toujours tolérer un Redis en mode dégradé (429 Upstash) : voir `_isRedis429` et les
  `.catch(() => {})` sur les écritures non critiques. Ne jamais faire dépendre une
  réponse HTTP d'une écriture Redis best-effort.
