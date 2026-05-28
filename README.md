# MAT — Mézières Avec Toi (backend)

Serveur Node.js/Express du projet **MAT — Mézières Avec Toi**, l'application municipale
de la commune de [Mézières-lez-Cléry](https://mezieres-lez-clery.fr).  
Il expose les APIs consommées par le frontend PWA : chatbot IA, notifications push,
météo, signalements citoyens, agenda, publications Facebook et interface d'administration.

---

## Architecture

| Composant | Rôle |
|-----------|------|
| **Node.js 22 / Express** | Serveur HTTP, routing, middleware |
| **Anthropic Claude** | LLM principal du chatbot (avec prompt caching) |
| **Mistral AI** | LLM alternatif / fallback |
| **Upstash Redis** | Cache en mémoire, souscriptions push web, rate-limiting |
| **Web Push (VAPID)** | Notifications push vers les navigateurs abonnés |
| **Cloudinary** | Hébergement des photos des signalements citoyens |
| **Trello API** | Gestion du workflow des signalements et des bugs |
| **Google Calendar API** | Lecture/écriture de l'agenda municipal |
| **Météo-France Vigilance** | Alertes météo départementales |
| **Open-Meteo** | Prévisions météo (open-source, sans clé) |
| **Facebook Graph API** | Publication automatique d'actualités |
| **Resend** | Envoi des rapports de statistiques quotidiens |
| **OpenAgenda** | Agenda alternatif / enrichissement événements |

---

## Configuration

Copiez `.env.example` en `.env` et renseignez chaque variable :

```bash
cp .env.example .env
```

Variables requises (voir `.env.example` pour la liste complète et les commentaires) :

| Variable | Description |
|----------|-------------|
| `ADMIN_PASSWORD` | Mot de passe de l'interface admin |
| `ANTHROPIC_API_KEY` | Clé API Anthropic (Claude) |
| `UPSTASH_REDIS_REST_URL` | URL REST de la base Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Token d'accès Upstash |
| `VAPID_PUBLIC_KEY` | Clé VAPID publique (Web Push) |
| `VAPID_PRIVATE_KEY` | Clé VAPID privée (Web Push) |
| `PAGE_ACCESS_TOKEN` | Token d'accès longue durée Facebook |
| `FACEBOOK_APP_SECRET` | Secret de l'app Meta (validation webhook) |
| `VERIFY_TOKEN` | Token de vérification webhook Facebook |
| `GOOGLE_CALENDAR_ICAL` | URL iCal publique du calendrier Google |
| `GOOGLE_CALENDAR_ID` | Identifiant du calendrier Google |
| `GOOGLE_SERVICE_ACCOUNT` | JSON du compte de service Google |
| `CLOUDINARY_NAME` / `KEY` / `SECRET` | Identifiants Cloudinary |
| `TRELLO_KEY` / `TOKEN` | Clés API Trello |
| `TRELLO_LIST_ID_BUG` / `SIG` / `DEMANDE` | IDs des listes Trello |
| `METEOFRANCE_VIGILANCE_URL` | URL du flux vigilance Météo-France |
| `METEOFRANCE_API_TOKEN` | Token API Météo-France (si authentifié) |
| `RESEND_API_KEY` | Clé API Resend (emails) |
| `RESEND_FROM` | Adresse expéditrice vérifiée dans Resend |
| `CRON_SECRET` | Secret pour les routes cron internes |

Pour générer une paire de clés VAPID :
```bash
npx web-push generate-vapid-keys
```

---

## Démarrage

```bash
# Installation des dépendances
npm install

# Développement (rechargement automatique)
npm run dev

# Production
npm start
```

Le serveur écoute sur `PORT` (défaut : `3000`).

---

## Déploiement

Le projet est conçu pour être hébergé sur **[Render](https://render.com)** (free tier).  
Configurez les variables d'environnement dans le tableau de bord Render et pointez
le service sur ce dépôt. Le script de démarrage est `npm start`.

---

## Licence

Ce projet est distribué sous licence **MIT**.  
Voir le fichier [LICENSE](LICENSE) pour les détails.

---

*Frontend PWA : [mairie-mezieres/app-mezieres](https://github.com/mairie-mezieres/app-mezieres)*  
*Site officiel : [mezieres-lez-clery.fr](https://mezieres-lez-clery.fr)*
