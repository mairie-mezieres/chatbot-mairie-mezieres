# ADR-0005 — Seuil de notification sécheresse fixé à « Alerte » (pas « Vigilance »)

- **Date** : 27 juin 2026
- **Statut** : Accepté

## Contexte

VigiEau définit 4 niveaux croissants : **vigilance**, **alerte**, **alerte renforcée**,
**crise**. Le niveau **vigilance** est le plus bas : il **n'impose aucune interdiction**,
il appelle seulement à économiser l'eau. Les niveaux **alerte** et plus imposent des
restrictions réelles (arrosage, lavage de voiture, remplissage de piscine…).

Une commune peut rester en « vigilance » plusieurs semaines chaque été. Notifier les
habitants (push + Facebook) dès la vigilance produirait beaucoup d'alertes sans action
concrète associée → lassitude, et risque que les vraies restrictions (alerte+) passent
inaperçues.

## Décision

Nous notifions (actualité + push + Facebook) **à partir du niveau « Alerte » (2) et au-dessus**,
ainsi qu'au **retour sous ce seuil** (« fin des restrictions »).

Le niveau **vigilance** reste **affiché** dans l'app (ligne « Restrictions » de la section
Eau), avec une mention explicite « pas d'interdiction, économies recommandées », mais ne
déclenche aucune notification.

Le seuil est codé via la logique de `routes/eau.js` (`status.level >= 2`). Les variables
d'environnement contrôlent uniquement l'activation Facebook (`AUTO_POST_DROUGHT_ALERTS`) et
la fréquence (`DROUGHT_CHECK_INTERVAL_MS`).

## Conséquences

**Positives :**
- Les notifications correspondent à un changement actionnable (restrictions réelles).
- Moins de bruit → meilleure attention quand une vraie alerte arrive.
- Cohérent avec la sémantique officielle VigiEau.

**Négatives / compromis acceptés :**
- Un habitant très soucieux de l'eau n'est pas notifié en vigilance ; il doit ouvrir l'app
  pour la voir. Acceptable : la vigilance n'impose rien.

**Points de vigilance pour les futures évolutions :**
- Si un jour on veut rendre le seuil configurable, l'exposer en variable d'env (ex.
  `DROUGHT_NOTIFY_MIN_LEVEL`) plutôt qu'en dur, sur le modèle de `AUTO_PUSH_WEATHER_MIN_LEVEL`.
