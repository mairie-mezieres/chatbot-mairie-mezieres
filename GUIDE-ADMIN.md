# Guide d'administration — MAT (Mézières Avec Toi)

Guide à l'usage des **administrateurs de la mairie**. Il décrit l'interface
d'administration, les variables d'environnement, les intégrations (Facebook,
push, agenda…) et le dépannage courant.

> 🔄 **Document vivant** : à mettre à jour à chaque évolution. Dernière révision :
> mai 2026.

---

## 1. Architecture en bref

| Brique | Rôle | Hébergeur |
|--------|------|-----------|
| **Frontend** (`app-mezieres`) | PWA citoyenne + interface admin (`admin.html`) | Cloudflare Pages (statique) |
| **Backend** (`chatbot-mairie-mezieres`) | API Express, IA MEL, intégrations, push | Render |
| **Stockage** | Cache, abonnements push, actus, idées, stats | Upstash (Redis, région UE) |
| **Photos signalements** | Hébergement images | Cloudinary |

Le frontend appelle le backend (`https://chatbot-mairie-mezieres.onrender.com`).
Aucune donnée citoyenne ne transite par un CDN tiers côté application.

---

## 2. Accéder à l'administration

1. Ouvrir **`https://mezieres-lez-clery.fr/admin.html`**.
2. Saisir le **mot de passe admin** (variable `ADMIN_PASSWORD` sur Render).
3. L'interface envoie ce mot de passe au backend dans l'en-tête
   `x-admin-token` pour chaque action. **Il n'est jamais stocké en clair
   ailleurs.**

> 🔐 Changez `ADMIN_PASSWORD` régulièrement et ne le partagez qu'aux personnes
> habilitées. Si `ADMIN_PASSWORD` n'est pas défini, toutes les routes admin
> renvoient `401` (admin désactivé).

---

## 3. Les onglets de l'admin

| Onglet | À quoi ça sert |
|--------|----------------|
| 📊 **Vue générale** | Synthèse : activité, visiteurs, coûts Redis, état global |
| 🔔 **Actualités** | Liste des actus (issues de Facebook `#MAT` ou créées à la main) ; suppression ; publication manuelle |
| 📢 **Info/Alerte** | Bandeau d'information/alerte affiché en haut de l'app |
| 🚨 **Signalements** | Signalements citoyens (remontés vers Trello) |
| 💡 **Idées** | Boîte à idées citoyenne |
| 🗳️ **Sondages** | Création et suivi des sondages |
| 📁 **Documents** | Document « à la une » + documents temporaires |
| 🛠️ **Entreprises** | Annuaire des artisans/entreprises locales |
| 🤖 **IA** | Statistiques d'usage de l'assistante MEL |
| 📱 **Usage app** | Statistiques d'utilisation de la PWA |
| 🔔 **Push** | Abonnés aux notifications + envoi manuel |
| 🗄️ **Redis** | Monitoring du stockage et des coûts |
| 👩‍💼 **MEL** | Configuration de l'assistante (arbre de réponses) |
| 🧪 **Services** | **Diagnostic** de tous les services (voir §6) |
| 🚨 **Migration** | Outils de migration de données |
| 🗑️ **Purge** | Nettoyage des anciennes données (actus, etc.) |
| 🪲 **Logs** | Journaux serveur récents |

---

## 4. Variables d'environnement (Render)

À configurer dans **Render → service `chatbot-mairie-mezieres` → Environment**.
Le fichier [`.env.example`](.env.example) liste tout en détail. Les **essentielles** :

### Indispensables
| Variable | Rôle |
|----------|------|
| `ADMIN_PASSWORD` | Mot de passe de l'interface admin |
| `ANTHROPIC_API_KEY` | IA (extraction PDF horaires bus, etc.) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Stockage Redis |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Notifications push (générer : `npx web-push generate-vapid-keys`) |

### Facebook / actualités
| Variable | Rôle |
|----------|------|
| `PAGE_ACCESS_TOKEN` | Token longue durée de la Page (publication + lecture) |
| `FACEBOOK_PAGE_ID` | Identifiant de la Page |
| **`FACEBOOK_APP_SECRET`** | **Validation des webhooks entrants — sans elle, les posts `#MAT` ne remontent pas (voir §5)** |
| `VERIFY_TOKEN` | Token de vérification du webhook (valeur libre) |

### Autres intégrations
| Variable | Rôle |
|----------|------|
| `MISTRAL_API_KEY` | IA française MEL (souveraine, prioritaire) |
| `SENTRY_DSN` | Suivi d'erreurs en production (voir §7) |
| `CLOUDINARY_*` | Photos des signalements |
| `TRELLO_*` | Signalements / bugs → cartes Trello |
| `GOOGLE_CALENDAR_*` | Agenda public (lecture) et écriture |
| `METEOFRANCE_VIGILANCE_URL` | Vigilance météo |
| `RESEND_*` / `DAILY_STATS_EMAIL` | Rapport de stats quotidien par email |
| `CRON_SECRET` | Protection des routes cron internes |

> ⚠️ **Ne jamais committer de secret.** Tout vit dans Render (et dans `.env`
> en local, ignoré par git). Après modification d'une variable, Render
> redéploie automatiquement (~1-2 min).

---

## 5. Le webhook Facebook (`#MAT`) — comprendre et dépanner

### Comment ça marche
- **Sortant** : créer une actu dans l'admin la **publie** sur la Page Facebook
  (sans `#MAT`, pour éviter qu'elle se ré-ingère elle-même).
- **Entrant** : quand vous publiez **manuellement** un post sur Facebook
  contenant **`#MAT`** dans le texte, Facebook appelle le webhook
  `POST /webhook`, qui crée l'actualité et envoie une notification push.

### Sécurité (important)
Depuis mai 2026, le webhook **valide la signature HMAC** de Facebook :
- il faut que **`FACEBOOK_APP_SECRET`** soit défini (sinon **chaque appel est
  rejeté en silence — code 503, aucun log**) ;
- cette protection empêche un tiers d'injecter de fausses actus / du spam push.

### Dépannage : « un post `#MAT` ne remonte pas »
1. **Onglet 🧪 Services** → ligne **📡 Webhook Facebook (entrant)** :
   - 🔴 *« FACEBOOK_APP_SECRET manquant »* → ajouter la variable sur Render
     (clé secrète de l'app Meta : developers.facebook.com → votre app →
     Paramètres → Général → Clé secrète).
   - 🔴 *« Page NON abonnée au feed »* → ré-abonner (route `GET /setup-webhook`,
     authentifiée par `x-admin-token`). Fréquent après une régénération du
     `PAGE_ACCESS_TOKEN`.
   - 🟢 *« Webhook abonné au feed »* → le webhook fonctionne ; voir ci-dessous.
2. **Le post est bien reçu mais l'actu n'apparaît pas** : le webhook ignore les
   **doublons** (même titre + même photo). Un **repost à l'identique** est donc
   considéré comme déjà présent. Pour republier : modifier la 1ʳᵉ ligne (titre)
   ou la photo.
3. Le `#MAT` doit être dans le **texte** du post (un post photo seule sans
   légende n'est pas détecté).

> Vérité terrain : les **logs Render** (live tail) affichent
> `📰 Publication #MAT détectée` à la réception, puis `💾 Actu FB stockée` ou
> `⏭️ Actualité déjà présente`.

---

## 6. Le diagnostic des services (onglet 🧪 Services)

Lance un test en direct de chaque brique. Statuts : 🟢 OK · 🟡 attention · 🔴 problème.

| Check | Ce qu'il vérifie |
|-------|------------------|
| 🌲 Serveur API | Le backend répond |
| 🗄️ Redis / Upstash | Lecture/écriture du stockage |
| 🌤️ Open-Meteo | Récupération météo de la commune |
| ⚠️ Vigilance Météo-France | Flux vigilance du département 45 |
| 🚌 Bus Rémi (cache) | Horaires bus (PDF → IA). Si « en erreur » : le PDF source était indisponible ; **auto-réparable** au prochain rafraîchissement |
| 📅 Agenda public | Lecture du calendrier Google (iCal) |
| 🗓️ Google Calendar (écriture) | Création/suppression d'un événement test |
| 📌 Trello | Listes bug/signalement/demande accessibles |
| 🤖 Mistral | L'IA française répond |
| 📘 Facebook Page | Token de page valide (sortant) |
| 📡 **Webhook Facebook (entrant)** | Abonnement au `feed` + présence de `FACEBOOK_APP_SECRET` (voir §5) |
| 🔔 Notifications push | Clés VAPID + nombre d'abonnés |

---

## 7. Suivi d'erreurs (Sentry)

Si `SENTRY_DSN` est défini sur Render, les erreurs serveur sont remontées à
Sentry (backend) ; le frontend a son propre suivi. Consultez le tableau de bord
Sentry pour repérer les anomalies en production. Sans `SENTRY_DSN`, le suivi est
simplement désactivé (l'app fonctionne normalement).

---

## 8. Déploiement & intégration continue

- **Frontend** : pousser sur `main` de `app-mezieres` → Cloudflare Pages
  redéploie automatiquement (site statique, aucun build).
- **Backend** : pousser sur `main` de `chatbot-mairie-mezieres` → Render
  redéploie automatiquement.
- **CI** (GitHub Actions) à chaque push / PR :
  - `app-mezieres` : vérification syntaxe + **tests E2E** (Playwright) ;
    audits **Lighthouse** et **EcoIndex** (hebdomadaires + manuels).
  - `chatbot-mairie-mezieres` : vérification syntaxe + tests golden-master.
- **Cache PWA** : après une modif du frontend, la version du Service Worker
  (`const CACHE` dans `service-worker.js`) est incrémentée pour forcer la mise à
  jour chez les utilisateurs.

---

## 9. Dépannage courant (FAQ)

| Symptôme | Piste |
|----------|-------|
| Un post `#MAT` ne remonte pas | Voir §5 (webhook / `FACEBOOK_APP_SECRET` / doublon) |
| « Cache bus présent mais en erreur » | PDF horaires momentanément indisponible ; auto-réparé au prochain accès. Si persistant, vérifier le lien du PDF |
| Aucune notification push reçue | Onglet 🔔 Push : abonnés présents ? Clés VAPID définies ? Sur iPhone, l'app doit être **installée** (iOS 16.4+) |
| L'admin renvoie « 401 » | `ADMIN_PASSWORD` absent sur Render, ou mauvais mot de passe |
| Une intégration est 🔴 dans Services | La variable d'environnement correspondante manque ou est invalide (voir §4) |
| Le site ne se met pas à jour | Vider le cache / forcer le rafraîchissement ; vérifier que `CACHE` a bien été incrémenté |

---

## 10. Contacts

**Mairie de Mézières-lez-Cléry** — 36 rue du bourg, 45370
📞 02 38 45 61 76 · ✉️ `mairie@mezieres-lez-clery.fr`

Pour signaler une faille de sécurité, voir [`SECURITY.md`](SECURITY.md).
