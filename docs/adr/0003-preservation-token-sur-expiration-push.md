# ADR-0003 — Conserver le token Redis sur expiration d'endpoint push (410/404)

- **Date** : juin 2026
- **Statut** : Accepté

## Contexte

Quand un navigateur met à jour son Service Worker ou que l'utilisateur réinstalle l'app,
l'abonnement Web Push précédent est invalidé. Le serveur push (FCM pour Chrome, APNs pour
Safari) retourne alors une erreur **410 Gone** ou **404 Not Found** lors de l'envoi.

Comportement initial (bug) : à la réception d'un 410, le backend appelait `redisDel` sur
`mat:notify:token:{uuid}`, supprimant **toute** l'entrée. Conséquence :

1. Quand le citoyen rouvrait l'app, `updateNotifyTokenSub()` ne trouvait plus l'entrée
   et retournait `false` — lien définitivement perdu.
2. Le citoyen ne pouvait plus jamais recevoir de notifications pour ce signalement, même
   avec un abonnement push fonctionnel.

## Décision

Sur erreur 410 ou 404, nous **ne supprimons pas** l'entrée Redis. Nous mettons uniquement
`entry.sub = null` et conservons l'entrée :

```js
// Avant (bug)
await redisDel(_tokenKey(token));

// Après (ADR-0003)
entry.sub = null;
await redisSetex(_tokenKey(token), TOKEN_TTL, entry).catch(() => {});
```

À la prochaine ouverture de l'app, `_registerPendingNotifyTokens()` (frontend) détecte
les tokens localStorage sans `sub` actif, appelle `POST /notify/register-token`, et
`updateNotifyTokenSub()` retrouve l'entrée existante pour la mettre à jour.

## Conséquences

**Positives :**
- La liaison carte Trello ↔ citoyen est récupérable automatiquement sans action de
  l'utilisateur, dès la prochaine ouverture de l'app.
- Aucune donnée perdue en cas de rotation d'endpoint (fréquente sur iOS lors des mises à
  jour du navigateur).

**Négatives / compromis acceptés :**
- Des entrées Redis avec `sub: null` peuvent s'accumuler si le citoyen ne rouvre jamais
  l'app. Le TTL de 365 jours assure leur nettoyage automatique.
- Légèrement plus de mémoire Redis que l'approche « delete on 410 » — négligeable au
  volume d'une commune rurale.

**Points de vigilance pour les futures évolutions :**
- Cette logique est dans `lib/push-notify.js` (`sendPushToToken`). Toute refactorisation
  de la gestion d'erreurs push doit préserver le comportement `sub=null` sur 410/404.
- Ne pas confondre avec les abonnements broadcast (`mat:subs`) qui, eux, peuvent être
  supprimés sur 410 (pas de lien avec une carte Trello).
