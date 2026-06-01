/*
 * MAT — Mézières Avec Toi
 * Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
 * Licence MIT — voir LICENSE
 *
 * config.js — Variables d'environnement centralisées.
 * Lecture pure de process.env (aucun effet de bord : les warnings et
 * l'initialisation des clients restent dans index.js).
 */

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
const ADMIN_PASSWORD2       = process.env.ADMIN_PASSWORD2 || "";
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

module.exports = {
  PAGE_ACCESS_TOKEN, VERIFY_TOKEN, ANTHROPIC_API_KEY, GOOGLE_CALENDAR_ICAL,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL, REDIS_URL, REDIS_TOKEN,
  CLOUDINARY_NAME, CLOUDINARY_KEY, CLOUDINARY_SECRET, CLOUDINARY_ENABLED,
  MISTRAL_API_KEY, MISTRAL_MODEL, MISTRAL_URL,
  TRELLO_KEY, TRELLO_TOKEN, TRELLO_LIST_ID_BUG, TRELLO_LIST_ID_SIG, TRELLO_LIST_ID_DEMANDE, TRELLO_NOTIFY,
  UPSTASH_EMAIL, UPSTASH_API_KEY, UPSTASH_REDIS_DB_ID, ADMIN_PASSWORD, ADMIN_PASSWORD2,
  MISTRAL_BILLING_URL, MISTRAL_PRICE_IN, MISTRAL_PRICE_OUT, CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT, EUR_PER_USD,
  METEOFRANCE_VIGILANCE_URL, METEOFRANCE_API_TOKEN, AUTO_POST_WEATHER_ALERTS, AUTO_POST_MIN_LEVEL, AUTO_PUSH_WEATHER_MIN_LEVEL,
  RESEND_API_KEY, DAILY_STATS_EMAIL, CRON_SECRET, FACEBOOK_PAGE_ID,
  OPEN_METEO_LAT, OPEN_METEO_LON, OPEN_METEO_TZ, WEATHER_CHECK_INTERVAL_MS,
};
