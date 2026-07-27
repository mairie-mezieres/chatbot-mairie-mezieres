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
| **Frontend** (`app-mezieres`) | PWA citoyenne + interface admin (`admin.html`) | GitHub Pages (statique) |
| **Backend** (`chatbot-mairie-mezieres`) | API Express, IA MEL, intégrations, push | Render |
| **Stockage** | Cache, abonnements push, actus, idées, stats | Upstash (Redis, région UE) |
| **Images actus & entreprises** | Photos d'actualités (admin) et logos d'entreprises | Cloudinary |
| **Signalements** | Carte de suivi + **photo en pièce jointe de la carte** | Trello |

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
| 💡 **Idées** | Boîte à idées citoyenne — puces de filtre par statut de résolution (⏳ Sans statut / 🔍 En cours d'étude / ✅ Retenues / ❌ Non retenues / Toutes), avec compteurs |
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
| 🪲 **Logs** | Journaux serveur récents — inclut le **journal d'audit** des actions admin destructrices (lignes `audit` : suppression actu/idée/sondage/photo, purge) |

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

### Sécheresse / Restrictions VigiEau (séparé de la vigilance météo)
| Variable | Rôle |
|----------|------|
| `AUTO_POST_DROUGHT_ALERTS` | `true` pour publier automatiquement sur Facebook quand le niveau sécheresse ≥ Alerte (le push citoyen + l'actu partent dans tous les cas). Défaut `false`. |
| `VIGIEAU_COMMUNE_INSEE` | Code INSEE surveillé sur `api.vigieau.gouv.fr` (défaut `45203`). |
| `VIGIEAU_LAT` / `VIGIEAU_LON` | Coordonnées du point de référence (bourg) pour la requête par géométrie — même chemin que vigieau.gouv.fr pour une adresse. Défaut : `OPEN_METEO_LAT`/`OPEN_METEO_LON`. Voir ADR-0009. |
| `DROUGHT_CHECK_INTERVAL_MS` | Intervalle de vérification (défaut 6 h — la sécheresse évolue lentement). |

### Autres intégrations
| Variable | Rôle |
|----------|------|
| `MISTRAL_API_KEY` | IA française MEL (souveraine, prioritaire) |
| `SENTRY_DSN` | Suivi d'erreurs en production (voir §7) |
| `CLOUDINARY_*` | Images des **actualités** (admin) et **logos d'entreprises** |
| `TRELLO_*` | Signalements / bugs → cartes Trello (**photo en pièce jointe de la carte**) |
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
4. **Les logs ne montrent rien du tout** : Facebook n'a pas envoyé d'événement
   webhook pour ce post. Causes fréquentes : Story, Reel, ou **transfert/partage**
   publié depuis un profil personnel (pas depuis la Page elle-même). Seuls les
   posts **publiés directement sur la Page** avec `#MAT` dans le texte déclenchent
   l'actu. Un partage depuis la Page peut fonctionner si vous ajoutez `#MAT` dans
   le texte d'accompagnement du partage.

> **Logs Render** (onglet 🪲 Logs) — référence rapide :
>
> | Log | Signification |
> |-----|--------------|
> | `📡 Webhook Facebook : feed reçu sans message (item=share)` | Transfert/partage sans légende — ignoré (normal) |
> | `📡 Webhook Facebook : feed reçu sans #MAT (item=photo)` | Photo/post sans `#MAT` dans le texte |
> | `⚠️ Webhook Facebook : signature HMAC invalide` | `FACEBOOK_APP_SECRET` incorrect ou périmé |
> | `❌ Webhook Facebook : FACEBOOK_APP_SECRET manquant` | Variable absente de Render |
> | `📰 Publication #MAT détectée` | Post reconnu, traitement en cours |
> | `💾 Actu FB stockée` | Actualité créée avec succès |
> | `⏭️ Actualité déjà présente` | Doublon détecté (même titre + même photo) |

---

## 5ter. Alertes sécheresse (VigiEau) — séparées de la vigilance météo

### Pourquoi un flux distinct
La **vigilance Météo-France** (orages, canicule…) et les **restrictions sécheresse**
(VigiEau) sont deux choses différentes. Elles sont **volontairement séparées** :
- la vigilance météo occupe le **bandeau de vigilance** en haut de l'app ;
- la sécheresse ne touche **jamais** ce bandeau. Elle se matérialise par une
  **actualité distincte** (badge « source VigiEau ») + la ligne « Restrictions » de
  la section 💧 Eau de l'overlay météo.

### Les 4 niveaux VigiEau (croissants)
| Niveau | Sens | Notifie les habitants ? |
|--------|------|--------------------------|
| 🟡 Vigilance | Aucune interdiction, économies recommandées | **Non** (affiché dans l'app seulement) |
| 🟠 Alerte | Premières restrictions réelles | **Oui** (actu + push, Facebook si activé) |
| 🔴 Alerte renforcée | Restrictions durcies | Oui |
| 🟣 Crise | Usages prioritaires uniquement | Oui |

> Le niveau **Vigilance** est le plus bas : il n'impose aucune interdiction. C'est
> normal de le voir affiché sans se sentir « concerné ». Le seuil de notification est
> volontairement fixé à **Alerte** pour éviter la lassitude.

### Fonctionnement
- Le backend interroge `api.vigieau.gouv.fr` toutes les `DROUGHT_CHECK_INTERVAL_MS`
  (route interne `GET /eau/restrictions/check`, polling lancé par `index.js`).
- **Double requête** (ADR-0009) : l'API est interrogée par **coordonnées du bourg**
  (`VIGIEAU_LAT`/`VIGIEAU_LON` — le chemin utilisé par vigieau.gouv.fr pour une
  adresse) **et** par **code commune** ; le niveau **le plus grave** est retenu.
  Les deux chemins de l'API peuvent diverger (zone AEP « eau potable » absente de
  l'index par commune, constaté le 15/07/2026) — on ne sous-estime jamais.
- Au passage à **Alerte ou plus** (ou changement d'arrêté), il crée une **actualité**
  `source: vigieau`, envoie un **push** aux abonnés actus, et publie sur **Facebook**
  si `AUTO_POST_DROUGHT_ALERTS=true`. Les consignes clés (usages interdits/réduits)
  sont incluses, avec un lien vers `vigieau.gouv.fr`.
- Au **retour sous le seuil**, une actu « fin des restrictions » est publiée.
- **Déduplication** : on ne reposte que si le niveau OU l'arrêté change (Redis
  `mat:vigieau:last` + verrou anti-course `mat:vigieau:claim:*`).
- **Visuels** : chaque niveau a sa carte 1200×630 (`img/secheresse/secheresse-{vigilance,alerte,alerte-renforcee,crise,fin}.png`
  côté app), illustrant l'actu / le push / le post Facebook — comme les visuels de
  vigilance météo. Régénérables via `node scripts/generate-secheresse-cards.js`
  (repo `app-mezieres`). URL de base surchargeable par `DROUGHT_IMG_BASE` (défaut :
  `https://mezieres-lez-clery.fr/img/secheresse`).

### Dépannage
| Symptôme | Piste |
|---|---|
| Niveau 🟡 « indéterminé » dans 🧪 Services | API VigiEau injoignable sur les deux requêtes (coordonnées + commune) — réessai au prochain cycle |
| Niveau plus bas que vigieau.gouv.fr pour une adresse du bourg | Ne devrait plus arriver (double requête, ADR-0009). Vérifier `VIGIEAU_LAT`/`VIGIEAU_LON` (point dans la commune) et comparer avec `GET /eau/restrictions` |
| Pas de post Facebook en Alerte | `AUTO_POST_DROUGHT_ALERTS` ≠ `true` sur Render (le push + l'actu partent quand même) |
| Forcer un test | `GET /eau/restrictions/check?force=1` (recrée l'actu même sans changement) |

---

## 5bis. Notifications push citoyens (signalements / demandes / bugs)

### Comment ça marche

Quand un citoyen soumet un signalement, une demande ou un bug depuis l'app :

1. Le backend génère un UUID (`notifyToken`) et écrit `MAT-REF: {uuid}` dans la description de la carte Trello — c'est le lien carte ↔ citoyen.
2. Le frontend stocke l'UUID en `localStorage` et enregistre l'abonnement push du citoyen via `POST /notify/register-token`.
3. Quand vous **déplacez la carte** dans Trello (changement de statut) ou **ajoutez un commentaire**, le webhook Trello en est notifié et envoie automatiquement un push au citoyen.

> Les deux onglets admin **🚨 Signalements** et **🔔 Push** permettent aussi d'envoyer manuellement un push (via `PATCH /admin/signals/:id`).

### Tableau de routage

| Type de carte | Changement de statut | Commentaire mairie | Ouvre dans l'app |
|---|---|---|---|
| `[Signalement]` | ✅ push | ✅ push | Onglet Signalements |
| `[BUG]` | ✅ push | ✅ push | Onglet Bugs |
| `[Demande]` | ✅ push | ✅ push | Onglet Contact |

> ⚠️ Le push ne fonctionne que si la carte contient `MAT-REF: {uuid}` dans sa description. Les cartes créées **manuellement** dans Trello (sans passer par l'app) ne notifient personne.

### Prérequis

- Variables `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_LIST_ID_SIG`, `TRELLO_LIST_ID_BUG`, `TRELLO_LIST_ID_DEMANDE` définies sur Render.
- Le **webhook Trello** enregistré sur le board (onglet 🧪 Services → bouton « Activer le webhook Trello », ou `POST /admin/trello/register-webhook`).

### Si les notifications ne partent pas

| Symptôme | Piste |
|---|---|
| Aucun push à la création de la carte | `MAT-REF:` absent dans la description → la carte a peut-être été créée manuellement |
| Aucun push au changement de statut | Vérifier que le webhook Trello est actif (onglet 🧪 Services) |
| Aucun push au commentaire | Vérifier que le nom de la carte commence par `[Signalement]`, `[BUG]` ou `[Demande]` |
| Push partait avant, plus maintenant | L'endpoint push du citoyen a expiré ; il se re-synchronisera automatiquement à la prochaine ouverture de l'app |

---

## 6. Le diagnostic des services (onglet 🧪 Services)

Lance un test en direct de chaque brique. Statuts : 🟢 OK · 🟡 attention · 🔴 problème.

| Check | Ce qu'il vérifie |
|-------|------------------|
| 🌲 Serveur API | Le backend répond (la version affichée est lue dans `package.json`) |
| 🟩 **Node.js (runtime)** | Version de Node du serveur face au socle de sécurité (voir §6ter) |
| 🗄️ Redis / Upstash | Lecture/écriture du stockage |
| 🌤️ Open-Meteo | Récupération météo de la commune |
| ⚠️ Vigilance Météo-France | Flux vigilance du département 45 |
| 🚌 Bus Rémi (cache) | Horaires bus (PDF → IA). En cas d'échec, le **dernier bon horaire est conservé** (pas de « en erreur » qui écrase le cache) et un rafraîchissement **périodique automatique** (toutes les 30 min, backoff 1 h après échec) retente sans intervention |
| 📅 Agenda public | Lecture du calendrier Google (iCal) |
| 🗓️ Google Calendar (écriture) | Création/suppression d'un événement test |
| 📌 Trello | Listes bug/signalement/demande accessibles |
| 🤖 Mistral | L'IA française répond |
| 📘 Facebook Page | Token de page valide (sortant) |
| 📡 **Webhook Facebook (entrant)** | Abonnement au `feed` + présence de `FACEBOOK_APP_SECRET` (voir §5) |
| 🚱 **Restrictions sécheresse (VigiEau)** | Niveau sécheresse courant de la commune (voir §5ter) |
| 🔔 Notifications push | Clés VAPID + nombre d'abonnés |

---

## 6ter. Mettre à jour Node.js (check 🟩 « Node.js (runtime) »)

### Pourquoi ce check existe

Render ne recompile **qu'au déploiement**. La variable `NODE_VERSION` du
`render.yaml` vaut `"22"` : à chaque build, Render installe la dernière 22.x
disponible — mais tant qu'aucun déploiement n'a lieu, le serveur continue de
tourner sur la version installée le jour du dernier build. Un correctif de
sécurité Node peut donc sortir sans que le backend en bénéficie, **sans aucun
signe visible**. Le check 🟩 rend cet écart lisible depuis l'admin.

### Ce qu'affiche le check

Il compare `process.version` au socle déclaré dans `lib/node-baseline.js` :

| Couleur | Signification |
|---|---|
| 🟢 Vert | Version ≥ socle de sécurité de la ligne, aucun avis en attente |
| 🟡 Jaune | Version conforme au socle **mais** une publication de sécurité est annoncée sans versions correctives encore connues — ou version illisible |
| 🔴 Rouge | Version antérieure au socle, **ou** ligne Node qui n'est plus maintenue |

### Procédure quand le check est 🔴 ou 🟡

1. **Vérifier les versions correctives** sur <https://nodejs.org/en/security/>
   (la veille hebdomadaire les signale aussi).
2. **Mettre à jour `lib/node-baseline.js`** : reporter la version de chaque ligne
   dans `MIN_SAFE_BY_LINE`, mettre `BASELINE_UPDATED` à la date du jour, et
   remettre `PENDING_ADVISORY` à `null` une fois les versions connues.
3. **Relever le plancher** `engines.node` dans `package.json` (même valeur que
   la ligne 22 du socle).
4. **Redéployer le backend** — c'est l'étape qui installe réellement le nouveau
   Node. Un push sur `main` suffit (`autoDeploy: true`). S'il n'y a rien à
   pousser : Render → service `chatbot-mairie-mezieres` → **Manual Deploy** →
   **Clear build cache & deploy** (le cache de build fige sinon le runtime).
5. **Re-lancer 🧪 Services** et vérifier que 🟩 est repassé au vert.

> ℹ️ Changer de **ligne** Node (22 → 24 LTS par exemple) demande en plus de
> modifier `NODE_VERSION` dans `render.yaml` et `node-version` dans les
> workflows GitHub Actions des deux dépôts.

### Dépendances npm

La CI lance `npm audit --audit-level=high` en **non bloquant** à chaque push.
Les avis `high`+ doivent être traités rapidement ; les avis `moderate` issus de
la chaîne `googleapis` → `googleapis-common` → `gaxios` → `uuid` demandent une
montée majeure de `googleapis` (breaking) et sont suivis à part.

---

## 6bis. Suivi du kit réplication « Partager »

La page `partager.html` de l'app (générateur de prompt pour répliquer MAT dans
une autre commune) remonte deux types d'information au backend :

1. **Compteurs anonymes** (déjà en place) : `partager_visite` (ouverture de la
   page) et `partager_prompt` (clic « Générer mon prompt ») via `/stats/track` —
   visibles dans les stats habituelles.
2. **Profil de la commune intéressée** : à la génération du prompt, le formulaire
   envoie `POST /stats/partager` avec le **nom de la commune**, la **population**,
   le **budget mensuel souhaité** et le **niveau informatique** déclarés (plus
   hébergeur et mode souverain). Le profil n'est envoyé que si le nom de commune
   est renseigné. Données de collectivité, pas de données personnelles ; une
   mention l'indique sur la page.

Stockage : liste Redis `mat:partager:profils` (plafonnée aux 500 dernières
entrées, LPUSH + LTRIM). Consultation :

- **Mail quotidien « MAT stats »** : carte « 🧩 Kit réplication “Partager” » —
  visites/prompts du jour et total, plus le tableau des communes ayant généré un
  prompt dans la journée (commune, habitants, budget, niveau, 🇫🇷 si mode
  souverain).
- **`GET /admin/partager-profils`** (token admin) : liste complète des profils
  collectés, du plus récent au plus ancien.

L'écriture est best-effort (un Redis en 429 ne bloque jamais la génération du
prompt côté habitant) et la route est rate-limitée (10 req/min/IP).

---

## 7. Suivi d'erreurs (Sentry)

Si `SENTRY_DSN` est défini sur Render, les erreurs serveur sont remontées à
Sentry (backend) ; le frontend a son propre suivi. Consultez le tableau de bord
Sentry pour repérer les anomalies en production. Sans `SENTRY_DSN`, le suivi est
simplement désactivé (l'app fonctionne normalement).

---

## 8. Déploiement & intégration continue

- **Frontend** : pousser sur `main` de `app-mezieres` → GitHub Pages
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
| Sécheresse : « Vigilance » affichée mais on ne se sent pas concerné | Normal : la vigilance n'impose aucune interdiction (voir §5ter). Notification seulement à partir d'Alerte |
| Pas d'alerte sécheresse alors qu'il y a des restrictions | Voir §5ter : niveau ≥ Alerte requis ; vérifier 🧪 Services 🚱 et `AUTO_POST_DROUGHT_ALERTS` |
| « Cache bus présent mais en erreur » | Ne devrait plus rester bloqué : le dernier bon horaire est conservé et un refresh périodique (30 min) retente seul. Si l'état persiste plusieurs heures, vérifier le lien du PDF source |
| Aucune notification push reçue (actus/déchets) | Onglet 🔔 Push : abonnés présents ? Clés VAPID définies ? Sur iPhone, l'app doit être **installée** (iOS 16.4+) |
| Citoyen ne reçoit pas de push sur son signalement | Voir §5bis — vérifier webhook Trello actif + `MAT-REF:` présent dans la carte |
| L'admin renvoie « 401 » | `ADMIN_PASSWORD` absent sur Render, ou mauvais mot de passe |
| Une intégration est 🔴 dans Services | La variable d'environnement correspondante manque ou est invalide (voir §4) |
| Le site ne se met pas à jour | Vider le cache / forcer le rafraîchissement ; vérifier que `CACHE` a bien été incrémenté |
| Consommation Redis élevée dans le mail quotidien (milliers de commandes) | Anormal : l'attendu est de quelques centaines/jour (~3–5 % du quota Upstash). Chercher un cron qui interroge Redis à chaque tick — les listes programmées passent par un miroir mémoire (ADR-0007) |
| Un signalement apparaît sur la carte loin de la commune (Afrique, océan…) | Le téléphone du citoyen a renvoyé une position invalide — souvent (0,0), « Null Island ». Corrigé : les points à plus de ~55 km de la commune ne sont plus ni enregistrés ni affichés (ADR-0008) ; le lien reste visible dans la carte Trello |
| Une actu cochée « Facebook » ne semble pas publiée sur la page | Regarder le **récapitulatif** à la publication (ligne 📘 avec lien « voir le post ↗ ») et le **badge 📘** dans la liste des actus (lien vers le post). Un échec sortant apparaît dans 🪲 Logs (module `facebook`). ⚠️ La ligne *webhook* du diagnostic ne teste que le flux **entrant** ; le sortant, c'est la ligne « 📘 Facebook Page » |

---

## 10. Contacts

**Mairie de Mézières-lez-Cléry** — 36 rue du bourg, 45370
📞 02 38 45 61 76 · ✉️ `mairie@mezieres-lez-clery.fr`

Pour signaler une faille de sécurité, voir [`SECURITY.md`](SECURITY.md).
