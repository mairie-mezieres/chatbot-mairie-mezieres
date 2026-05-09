const express   = require("express");
const axios     = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const webpush   = require("web-push");
const cloudinary = require("cloudinary").v2;
const rateLimit = require("express-rate-limit");

// Timeout global sur tous les appels axios sortants (8 s)
axios.defaults.timeout = 8000;

const app = express();
app.use(express.json({ limit: "10mb" }));
app.set('trust proxy', true); // Render est derrière un reverse proxy

// ─── Variables d'environnement ────────────────────────────────
const PAGE_ACCESS_TOKEN    = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN         = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CALENDAR_ICAL = process.env.GOOGLE_CALENDAR_ICAL;
const VAPID_PUBLIC_KEY     = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY    = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL          = "mailto:mairie@mezieres-lez-clery.fr";
const REDIS_URL            = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN          = process.env.UPSTASH_REDIS_REST_TOKEN;

const CLOUDINARY_NAME      = process.env.CLOUDINARY_NAME || "";
const CLOUDINARY_KEY       = process.env.CLOUDINARY_KEY || "";
const CLOUDINARY_SECRET    = process.env.CLOUDINARY_SECRET || "";
const CLOUDINARY_ENABLED   = !!(CLOUDINARY_NAME && CLOUDINARY_KEY && CLOUDINARY_SECRET);

const MISTRAL_API_KEY      = process.env.MISTRAL_API_KEY || "";
const MISTRAL_MODEL        = process.env.MISTRAL_MODEL || "mistral-small-latest";
const MISTRAL_URL          = process.env.MISTRAL_URL || "https://api.mistral.ai/v1/chat/completions";

const TRELLO_KEY              = process.env.TRELLO_KEY || "";
const TRELLO_TOKEN            = process.env.TRELLO_TOKEN || "";

const TRELLO_LIST_ID_BUG      = process.env.TRELLO_LIST_ID_BUG || "";
const TRELLO_LIST_ID_SIG      = process.env.TRELLO_LIST_ID_SIG || "";
const TRELLO_LIST_ID_DEMANDE  = process.env.TRELLO_LIST_ID_DEMANDE || "";

function csvEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

const TRELLO_NOTIFY = {
  bug: {
    listId: TRELLO_LIST_ID_BUG,
    memberIds: csvEnv("TRELLO_NOTIFY_BUG_IDS"),
    usernames: csvEnv("TRELLO_NOTIFY_BUG_USERS"),
  },
  signalement: {
    listId: TRELLO_LIST_ID_SIG,
    memberIds: csvEnv("TRELLO_NOTIFY_SIG_IDS"),
    usernames: csvEnv("TRELLO_NOTIFY_SIG_USERS"),
  },
  demande: {
    listId: TRELLO_LIST_ID_DEMANDE,
    memberIds: csvEnv("TRELLO_NOTIFY_DEMANDE_IDS"),
    usernames: csvEnv("TRELLO_NOTIFY_DEMANDE_USERS"),
  }
};


const UPSTASH_EMAIL         = process.env.UPSTASH_EMAIL || "";
const UPSTASH_API_KEY       = process.env.UPSTASH_API_KEY || "";
const UPSTASH_REDIS_DB_ID   = process.env.UPSTASH_REDIS_DB_ID || "";

const ADMIN_PASSWORD        = process.env.ADMIN_PASSWORD || "";
if (!ADMIN_PASSWORD) {
  console.warn("⚠️  ADMIN_PASSWORD non défini : tous les endpoints /admin seront refusés (401).");
}
const MISTRAL_BILLING_URL   = "https://api.mistral.ai/v1/usage";
// Tarifs Mistral Small (€/1M tokens) — à ajuster si changement
const MISTRAL_PRICE_IN      = 0.10;  // €/1M input tokens
const MISTRAL_PRICE_OUT     = 0.30;  // €/1M output tokens
// Tarifs Claude Haiku 4.5 ($/1M tokens) → converti en €
const CLAUDE_PRICE_IN       = 0.80;  // $/1M input tokens
const CLAUDE_PRICE_OUT      = 4.00;  // $/1M output tokens
const EUR_PER_USD            = 0.92; // taux approximatif

const METEOFRANCE_VIGILANCE_URL = process.env.METEOFRANCE_VIGILANCE_URL || process.env.METEOFRANCE_VIGILANCE || "";
const METEOFRANCE_API_TOKEN     = process.env.METEOFRANCE_API_TOKEN;
const AUTO_POST_WEATHER_ALERTS  = process.env.AUTO_POST_WEATHER_ALERTS === "true";
const AUTO_POST_MIN_LEVEL       = Number(process.env.AUTO_POST_MIN_LEVEL || 3);
const AUTO_PUSH_WEATHER_MIN_LEVEL = Number(process.env.AUTO_PUSH_WEATHER_MIN_LEVEL || 2);
const RESEND_API_KEY            = process.env.RESEND_API_KEY || "";
const DAILY_STATS_EMAIL         = process.env.DAILY_STATS_EMAIL || "fabrice.auffret45@gmail.com";
const CRON_SECRET               = process.env.CRON_SECRET || "";
const FACEBOOK_PAGE_ID          = process.env.FACEBOOK_PAGE_ID;
const OPEN_METEO_LAT            = Number(process.env.OPEN_METEO_LAT || 47.822);
const OPEN_METEO_LON            = Number(process.env.OPEN_METEO_LON || 1.808);
const OPEN_METEO_TZ             = process.env.OPEN_METEO_TZ || "Europe/Paris";
const WEATHER_CHECK_INTERVAL_MS = Number(process.env.WEATHER_CHECK_INTERVAL_MS || 15 * 60 * 1000);