# Politique de sécurité — Backend MAT (Mézières Avec Toi)

Ce dépôt contient le serveur applicatif (API Express, intégrations Trello,
push, IA MEL) de l'application citoyenne de Mézières-lez-Cléry. La commune
prend la sécurité au sérieux ; cette page explique comment signaler une
faille de manière responsable.

## Signaler une vulnérabilité

Si vous découvrez une faille (fuite de données, contournement
d'authentification, injection, SSRF, exposition de secret, etc.) :

1. **Ne la divulguez pas publiquement** tant qu'elle n'est pas corrigée.
2. Contactez la mairie en **divulgation responsable** :
   - ✉️ `mairie@mezieres-lez-clery.fr`
   - 📞 02 38 45 61 76 — Mairie de Mézières-lez-Cléry, 36 rue du bourg, 45370
3. Décrivez le composant concerné, les étapes de reproduction et l'impact.

Nous nous engageons à **accuser réception sous 5 jours ouvrés**.

## Périmètre

- **Backend / API** : ce dépôt (`chatbot-mairie-mezieres`), déployé sur Render.
- **Application / site** : dépôt `app-mezieres`.

Sont **hors périmètre** : les services tiers (Render, Upstash, Trello,
Mistral, Anthropic, Cloudinary, etc.) — à signaler directement à leurs
éditeurs.

## Bonnes pratiques déjà en place

- **Secrets hors dépôt** : toutes les clés et tokens sont lus depuis les
  variables d'environnement (`config.js`), jamais committés.
- **Routes admin authentifiées** (`ADMIN_PASSWORD`) et CORS restreint aux
  origines de confiance pour les routes `/admin`.
- **Rate-limiting** (`express-rate-limit`) sur les routes sensibles
  (enregistrement de token, etc.).
- **En-têtes de sécurité HTTP** : `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`.
- **Limites de taille de corps** strictes par route (anti-DoS mémoire).
- **Timeouts** sur tous les appels sortants (axios) et **arrêt gracieux**.
- **Validation de signature** des webhooks Trello (HMAC-SHA1) quand le
  secret est configuré.
- **Intégration continue** : `node --check` + tests golden-master à chaque
  modification.
- **Suivi d'erreurs** en production (Sentry) pour détecter les anomalies.

## Données personnelles

Les signalements citoyens sont **anonymes** (principe de minimisation).
Voir la rubrique « Vie privée & RGPD » de l'application pour le détail des
données traitées et des sous-traitants.

## Merci

Toute contribution responsable aide à protéger les habitants. Merci.
