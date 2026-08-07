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
| 📁 **Documents** | Document « à la une » + documents temporaires + **documents du PLUi-H-D** (voir §6quater) |
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
- Au passage à **Alerte ou plus**, il crée une **actualité** `source: vigieau`,
  envoie un **push** aux abonnés actus, et publie sur **Facebook** si
  `AUTO_POST_DROUGHT_ALERTS=true`. Les consignes clés (usages interdits/réduits)
  sont incluses, avec un lien vers `vigieau.gouv.fr`.
- Au **retour sous le seuil**, une actu « fin des restrictions » est publiée.

#### Quand une notification part — et quand elle ne part pas (ADR-0011)
Ce qui déclenche une notification est un **changement de niveau confirmé**, jamais
un simple changement d'arrêté (le texte publié serait identique) :

| Situation | Notification ? |
|---|---|
| Niveau **inchangé** (même si l'arrêté change) | ❌ Non |
| **Montée** (Alerte ou plus) | ✅ Oui, tout de suite |
| **Baisse** vue par une **lecture partielle** (une des deux requêtes VigiEau en échec) | ❌ Non — et le niveau lu est ignoré |
| **Baisse** confirmée par **2 lectures complètes** consécutives | ✅ Oui (fin des restrictions, ou actu du nouveau niveau) |
| Niveau **indéterminé** (API injoignable) | ❌ Non, rien n'est modifié |

> ⚠️ Une **lecture partielle** ne peut que **sous-estimer** le niveau (elle voit
> moins de zones). Elle est donc bonne pour **alerter**, jamais pour **rassurer** :
> c'est ce qui a causé le double envoi « alerte » puis « crise » des 29–30/07/2026
> alors que la commune n'avait pas quitté le niveau crise.
>
> Conséquence assumée : une **levée** réelle est annoncée avec un cycle de retard
> (~12 h avec un cycle de 6 h). La ligne « Restrictions » de l'app, elle, reste
> en temps réel.

- **État mémorisé** : Redis `mat:vigieau:last` (dernier niveau notifié) +
  `mat:vigieau:pending` (baisse en cours de confirmation) + verrou anti-course
  `mat:vigieau:claim:*`. Les deux premières clés ont un **miroir mémoire** : un
  hoquet Redis (429 Upstash) ne fait plus repartir une notification déjà envoyée.
- **Visuels** : chaque niveau a sa carte 1200×630 (`img/secheresse/secheresse-{vigilance,alerte,alerte-renforcee,crise,fin}.png`
  côté app), illustrant l'actu / le push / le post Facebook — comme les visuels de
  vigilance météo. Régénérables via `node scripts/generate-secheresse-cards.js`
  (repo `app-mezieres`). URL de base surchargeable par `DROUGHT_IMG_BASE` (défaut :
  `https://mezieres-lez-clery.fr/img/secheresse`).

### Dépannage
| Symptôme | Piste |
|---|---|
| Niveau 🟡 « indéterminé » dans 🧪 Services | API VigiEau injoignable sur les deux requêtes (coordonnées + commune) — réessai au prochain cycle |
| 🟡 « lecture partielle » dans 🧪 Services | Une seule des deux requêtes VigiEau a abouti : le niveau affiché peut être sous-estimé. Aucune baisse n'est actée dans cet état (ADR-0011) — réessai au prochain cycle |
| Deux notifications sécheresse pour le même niveau | Ne devrait plus arriver (ADR-0011) : seul un changement de niveau notifie. Si ça se reproduit, regarder les logs `🚱 VigiEau` — la ligne indique la raison retenue (`unchanged`, `escalation`, `descent-incomplete`, `descent-pending`…) |
| « Fin des restrictions » annoncée alors que la sécheresse continue | Ne devrait plus arriver : une baisse exige 2 lectures complètes consécutives (ADR-0011) |
| La levée des restrictions tarde à être annoncée | Normal : ~12 h (2 cycles) le temps de confirmer, pour ne pas annoncer une fausse levée |
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
| 🌲 Serveur API | Le backend répond |
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
| 🏘️ **Compteur installations** | Total d'installations PWA + celles du jour — le **même chiffre** que le mail quotidien et le badge de l'app (voir §6ter) |

---

## 6ter. Le compteur d'installations (badge de l'app)

Un seul chiffre, trois affichages, **une seule source** : `services.installation`
dans `mat:stats`.

| Où | Ce qui est affiché |
|----|--------------------|
| Mail quotidien | « Installations PWA (total) » (+ celles du jour) |
| Tableau de bord admin | `totalInstalls` |
| App habitant (badge d'accueil) | `GET /api/install-count` → « 🏘️ N Macérien(ne)s ont installé MAT » |

Ce que ça compte : un **événement d'installation** par navigateur/appareil
(installation Android/Chrome ou 1er lancement en mode « app » sur iOS). Réinstaller
ou vider le stockage du navigateur recompte l'appareil ; le chiffre est donc un
ordre de grandeur, pas un nombre d'habitants distincts.

**Si le badge de l'app diverge du mail** :

1. Onglet 🧪 Services → ligne **🏘️ Compteur installations**. Statut 🟡 avec
   « ancienne clé de cache encore présente » = une valeur figée traîne dans
   `mat:install_count_cache` (elle est purgée automatiquement au premier appel de
   `/api/install-count` après redémarrage — c'était la cause de l'écart
   585 / 323 de juillet 2026, cf. ADR-0010).
2. Sinon c'est l'app de l'habitant qui tourne encore sur une version précédente :
   le badge revalide sa valeur à chaque ouverture, mais le Service Worker sert la
   page en cache et applique la nouvelle version au lancement suivant. Fermer
   complètement l'app puis la rouvrir suffit.

### Corriger le total (doublons d'un ancien import)

Onglet **🗑️ Purge** → carte **🏘️ Compteur d'installations** : saisir le nouveau
total, « Corriger ». L'ancienne et la nouvelle valeur sont tracées dans 🪲 Logs.

En ligne de commande, même effet :

```bash
curl -X POST https://chatbot-mairie-mezieres.onrender.com/admin/stats/installations \
  -H "Content-Type: application/json" -H "x-admin-token: $ADMIN_PASSWORD" \
  -d '{"total": 361}'
# → {"ok":true,"previous":585,"total":361}
```

⚠️ **Ne jamais écrire `mat:stats` directement dans Redis** (console Upstash,
script) : le serveur garde les stats en **cache mémoire** et les réécrit au flush
suivant (≤ 5 min), ce qui écraserait la correction. Elle doit passer par le
process en cours, donc par la route ci-dessus. Le badge des habitants suit à leur
prochaine ouverture de l'app ; le mail, dès l'envoi suivant.

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

## 6quater. Documents du PLUi-H-D (onglet 📁 Documents)

La page « Grand dossier PLUi-H-D » de l'app affiche une liste de documents
officiels. Cette liste **s'administre depuis le tableau de bord** : onglet
**📁 Documents**, section « Documents du PLUi-H-D », en bas de l'onglet.

### Ajouter un document

Trois champs, puis **une** des deux options :

| Champ | Remarque |
|---|---|
| **Titre** | Ce que verront les habitants (ex. « Enquête publique — dossier complet ») |
| **Date du document** | Sert au tri (le plus récent en haut) **et** au déclenchement de la pastille « Nouveau » |
| **Option 1 — fichier PDF** | Le fichier est hébergé par l'application (Cloudinary). **4 Mo maximum** |
| **Option 2 — lien** | Adresse `https://` d'un document déjà en ligne (Drive, site de la CCTVL…). Aucune limite de taille |

> ⚠️ **Pourquoi 4 Mo ?** Le backend plafonne les envois à 6 Mo, et un fichier
> encodé pour le transport gonfle d'environ un tiers. Les gros documents
> d'urbanisme (diagnostic, PADD avec cartes) dépassent souvent ce seuil : pour
> ceux-là, déposez le fichier sur Drive ou sur le site de la CCTVL et **collez le
> lien**. L'écran refuse le fichier avant tout envoi et affiche la marche à
> suivre, plutôt que de laisser échouer la requête.

### Effet côté habitant

Dès qu'un document est ajouté, une pastille rouge **« Nouveau »** s'allume sur le
bandeau « Grand dossier » de l'accueil et sur l'entrée du menu en version
ordinateur — **sans attendre** que l'habitant ouvre la page. Elle s'éteint une
fois la page consultée. La clé de fraîcheur est *date du document le plus récent
+ nombre de documents* : elle rebascule donc à chaque ajout.

Les documents déjà reçus sont conservés localement sur l'appareil : la page reste
consultable **hors connexion**.

### Supprimer un document

Le bouton « Supprimer » de la ligne retire l'entrée **et** le fichier hébergé
s'il avait été envoyé depuis cet écran (un document ajouté par lien ne touche
évidemment pas à la cible du lien). L'action est tracée dans le **journal
d'audit** (onglet 🪲 Logs).

### Routes

| Route | Auth | Rôle |
|---|---|---|
| `GET /docs/plui` | non | Liste publique, lue par l'app |
| `POST /admin/docs/plui` | token admin | Ajout (`{titre, date, url}` ou `{titre, date, fileB64}`) |
| `DELETE /admin/docs/plui/:id` | token admin | Suppression (+ fichier Cloudinary) |

Stockage : clé Redis `mat:docs:plui`, avec le miroir mémoire habituel de
`lib/store.js`. Si Cloudinary n'est pas configuré (`CLOUDINARY_*` absentes),
l'envoi de fichier répond 503 avec un message invitant à utiliser un lien —
l'ajout par lien, lui, continue de fonctionner.

### ⚠️ Si un document envoyé affiche « HTTP ERROR 401 »

Cloudinary bloque **par défaut** la livraison des PDF (« types de médias
restreints »). Le fichier s'envoie sans erreur, apparaît dans la liste, et
répond 401 quand on clique dessus.

C'est traité dans le code : l'URL est **signée** à chaque lecture de
`GET /docs/plui` (`pluiDocUrl()` dans `lib/cloudinary.js`), et une URL signée
est délivrée même quand le type est restreint. Rien à faire côté console.

Si malgré tout un 401 persiste, le réglage de secours est dans la console
Cloudinary → **Settings → Security → Restricted media types** : retirer `PDF` de
la liste. Vérifier au passage que la clé `CLOUDINARY_SECRET` de Render est bien
celle du compte — une signature calculée avec une mauvaise clé produit
exactement la même erreur 401.

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
| Le badge « X Macérien(ne)s ont installé MAT » ne bouge plus / diffère du mail | Voir §6ter : ligne 🏘️ du diagnostic. Un cache Redis figé faisait autorité sur le badge (ADR-0010) ; le compteur lit désormais directement `services.installation` |
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
