# ADR-0002 — Tokens individuels pour les notifications push citoyens

- **Date** : mai 2024
- **Statut** : Accepté

## Contexte

Les habitants qui soumettent un signalement, une demande ou un bug doivent être notifiés
individuellement (et uniquement eux) quand leur dossier évolue. L'infrastructure Web Push
(VAPID) gère les abonnements par appareil (un objet `PushSubscription` par navigateur).

Deux approches étaient envisageables :

1. **Broadcast** : une seule clé Redis `mat:subs` listant tous les abonnements ; à chaque
   action, on diffuse à tous. Simple mais notifie tous les citoyens pour le dossier de
   l'un d'eux.
2. **Token individuel** : un UUID généré à la soumission, stocké en Redis et dans la
   description de la carte Trello, associé à l'abonnement push de l'appareil.

## Décision

Nous utilisons des **tokens individuels UUID** (`mat:notify:token:{uuid}`, TTL 365 jours
en Redis). À la soumission :

1. Le backend génère un UUID (`notifyToken`), le retourne au frontend, et crée l'entrée
   Redis `{ type, id, sub: null }`.
2. Le frontend stocke l'UUID en `localStorage` et l'envoie au backend via
   `POST /notify/register-token` pour lier `sub` = l'abonnement push actuel.
3. Le marqueur `MAT-REF: {uuid}` est écrit dans la description de la carte Trello.
4. Quand la carte évolue, le backend lit `MAT-REF`, récupère l'entrée Redis, et envoie
   le push uniquement à ce citoyen.

La fonction `_registerPendingNotifyTokens()` (frontend) re-synchronise les tokens en
`localStorage` à chaque renouvellement d'abonnement push.

## Conséquences

**Positives :**
- Seul le citoyen concerné reçoit la notification — pas de spam vers les autres.
- L'UUID est opaque : aucune donnée personnelle n'est exposée dans Trello.
- Résilient : si l'abonnement push expire, le token reste récupérable (voir ADR-0003).

**Négatives / compromis acceptés :**
- Un citoyen qui vide son `localStorage` (ou change de navigateur) perd le lien entre
  sa carte Trello et son nouvel abonnement push — il ne recevra plus de notifications
  pour ce signalement. Limitation documentée et acceptée (cas rare, RGPD-favorable).
- La gestion du TTL (365 j) est un compromis entre durée de vie réelle des signalements
  et occupation Redis.

**Points de vigilance pour les futures évolutions :**
- Ne jamais supprimer l'entrée Redis sur erreur 410 (voir ADR-0003) — utiliser `sub=null`.
- Si un citoyen soumet plusieurs signalements, chacun a son propre UUID indépendant.
  Pas de « compte citoyen » centralisé — intentionnel pour minimiser les données.
