/*
 * Tests golden-master pour config.js
 *
 * Vérifie que la résolution des 45 variables d'environnement (défauts,
 * conversions Number/booléen, chaînes ||, csvEnv → tableaux) reste identique
 * au comportement d'origine, sous deux scénarios :
 *   - env « plein »  (un mix de variables définies)
 *   - env « vide »   (toutes les valeurs par défaut)
 *
 * Les golden ont été capturés sur le bloc d'origine de index.js avant
 * extraction — voir test/golden/config-*.json.
 *
 * Lancer : npm test
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "..", "config.js");
const FULL_ENV = {
  ANTHROPIC_API_KEY: "sk-ant-xxx",
  CLOUDINARY_NAME: "democloud", CLOUDINARY_KEY: "12345", CLOUDINARY_SECRET: "sekret",
  TRELLO_KEY: "tkey", TRELLO_TOKEN: "ttok", TRELLO_LIST_ID_BUG: "bug1",
  TRELLO_NOTIFY_BUG_IDS: "a,b,c", TRELLO_NOTIFY_SIG_USERS: "jdoe",
  AUTO_POST_WEATHER_ALERTS: "true", AUTO_POST_MIN_LEVEL: "4",
  OPEN_METEO_LAT: "48.5", WEATHER_CHECK_INTERVAL_MS: "60000",
  METEOFRANCE_VIGILANCE: "https://fallback.example",
};

// Variables d'env susceptibles d'influencer config.js — à neutraliser pour
// le scénario « vide » afin de ne pas dépendre de l'environnement de la CI.
const CONFIG_ENV_KEYS = [
  "PAGE_ACCESS_TOKEN","VERIFY_TOKEN","ANTHROPIC_API_KEY","GOOGLE_CALENDAR_ICAL",
  "VAPID_PUBLIC_KEY","VAPID_PRIVATE_KEY","UPSTASH_REDIS_REST_URL","UPSTASH_REDIS_REST_TOKEN",
  "CLOUDINARY_NAME","CLOUDINARY_KEY","CLOUDINARY_SECRET","MISTRAL_API_KEY","MISTRAL_MODEL","MISTRAL_URL",
  "TRELLO_KEY","TRELLO_TOKEN","TRELLO_LIST_ID_BUG","TRELLO_LIST_ID_SIG","TRELLO_LIST_ID_DEMANDE",
  "TRELLO_NOTIFY_BUG_IDS","TRELLO_NOTIFY_BUG_USERS","TRELLO_NOTIFY_SIG_IDS","TRELLO_NOTIFY_SIG_USERS",
  "TRELLO_NOTIFY_DEMANDE_IDS","TRELLO_NOTIFY_DEMANDE_USERS",
  "UPSTASH_EMAIL","UPSTASH_API_KEY","UPSTASH_REDIS_DB_ID","ADMIN_PASSWORD","ADMIN_PASSWORD2",
  "METEOFRANCE_VIGILANCE_URL","METEOFRANCE_VIGILANCE","METEOFRANCE_API_TOKEN",
  "AUTO_POST_WEATHER_ALERTS","AUTO_POST_MIN_LEVEL","AUTO_PUSH_WEATHER_MIN_LEVEL",
  "RESEND_API_KEY","DAILY_STATS_EMAIL","CRON_SECRET","FACEBOOK_PAGE_ID",
  "OPEN_METEO_LAT","OPEN_METEO_LON","OPEN_METEO_TZ","WEATHER_CHECK_INTERVAL_MS",
];

function loadConfigWithEnv(envOverrides) {
  // Neutralise toutes les clés connues, applique l'override, recharge config.js.
  const saved = {};
  for (const k of CONFIG_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  delete require.cache[require.resolve(CONFIG_PATH)];
  let cfg;
  try {
    cfg = require(CONFIG_PATH);
  } finally {
    // Restaure l'environnement initial.
    for (const k of CONFIG_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(CONFIG_PATH)];
  }
  // Tri des clés + round-trip JSON pour s'aligner exactement sur la façon dont
  // les golden ont été générés (JSON.stringify omet les clés valant undefined,
  // ex. les variables sans défaut comme ANTHROPIC_API_KEY).
  const sorted = {};
  for (const key of Object.keys(cfg).sort()) sorted[key] = cfg[key];
  return JSON.parse(JSON.stringify(sorted));
}

test("config.js — env plein (golden master)", () => {
  const golden = require("./golden/config-full-env.json");
  const actual = loadConfigWithEnv(FULL_ENV);
  assert.deepEqual(actual, golden);
});

test("config.js — env vide, tous les défauts (golden master)", () => {
  const golden = require("./golden/config-empty-env.json");
  const actual = loadConfigWithEnv({});
  assert.deepEqual(actual, golden);
});
