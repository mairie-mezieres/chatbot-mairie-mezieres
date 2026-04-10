// ════════════════════════════════════════════════════════════
// MAT — Mézières Avec Toi · Serveur Render v6.5
// Mistral principal + cache + réponses directes + fallback Claude
// Facebook feed only (plus de MEL sur Messenger)
// ════════════════════════════════════════════════════════════


const express   = require("express");
const axios     = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const webpush   = require("web-push");
const cloudinary = require("cloudinary").v2;

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

const TRELLO_KEY     = process.env.TRELLO_KEY || "";
const TRELLO_TOKEN   = process.env.TRELLO_TOKEN || "";
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID || "";

const UPSTASH_EMAIL         = process.env.UPSTASH_EMAIL || "";
const UPSTASH_API_KEY       = process.env.UPSTASH_API_KEY || "";
const UPSTASH_REDIS_DB_ID   = process.env.UPSTASH_REDIS_DB_ID || "";

const ADMIN_PASSWORD        = process.env.ADMIN_PASSWORD || "mat-admin-2024";
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
const FACEBOOK_PAGE_ID          = process.env.FACEBOOK_PAGE_ID;
const OPEN_METEO_LAT            = Number(process.env.OPEN_METEO_LAT || 47.822);
const OPEN_METEO_LON            = Number(process.env.OPEN_METEO_LON || 1.808);
const OPEN_METEO_TZ             = process.env.OPEN_METEO_TZ || "Europe/Paris";
const WEATHER_CHECK_INTERVAL_MS = Number(process.env.WEATHER_CHECK_INTERVAL_MS || 15 * 60 * 1000);

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: CLOUDINARY_NAME,
    api_key: CLOUDINARY_KEY,
    api_secret: CLOUDINARY_SECRET,
    secure: true
  });
  console.log("✅ Cloudinary configuré");
}

// ─── Web Push VAPID ───────────────────────────────────────────
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log("✅ Web Push VAPID configuré");
}

// ─── Stockage persistant Upstash Redis ───────────────────────
async function redisGet(key) {
  if (!REDIS_URL) return null;
  try {
    const r = await axios.get(
      `${REDIS_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 8000 }
    );
    const val = r.data.result;
    if (val === null || val === undefined) return null;
    return JSON.parse(val);
  } catch(e) {
    console.warn(`Redis GET ${key}:`, e.message);
    return null;
  }
}

async function redisSet(key, value) {
  if (!REDIS_URL) return;
  try {
    const encoded = encodeURIComponent(key);
    await axios.post(
      `${REDIS_URL}/set/${encoded}`,
      JSON.stringify(value),
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" }, timeout: 8000 }
    );
  } catch(e) {
    console.warn(`Redis SET ${key}:`, e.message);
  }
}
async function getUpstashRedisStats() {
  if (!UPSTASH_EMAIL || !UPSTASH_API_KEY || !UPSTASH_REDIS_DB_ID) return null;

  try {
    const basic = Buffer.from(`${UPSTASH_EMAIL}:${UPSTASH_API_KEY}`).toString("base64");
    const r = await axios.get(
      `https://api.upstash.com/v2/redis/stats/${UPSTASH_REDIS_DB_ID}`,
      {
        headers: { Authorization: `Basic ${basic}` },
        timeout: 8000
      }
    );
    return r.data || null;
  } catch (e) {
    return { error: e.message };
  }
}
async function readSubs()               { return (await redisGet("mat:subs")) || []; }
async function writeSubs(d)             { await redisSet("mat:subs", d); }
async function readNews()               { return (await redisGet("mat:actus")) || []; }
async function writeNews(d)             { await redisSet("mat:actus", d); }
async function readIdeas()              { return (await redisGet("mat:idees")) || []; }
async function writeIdeas(d)            { await redisSet("mat:idees", d); }
async function readStats()              { return (await redisGet("mat:stats")) || {}; }
async function writeStats(d)            { await redisSet("mat:stats", d); }
async function readSignals()            { return (await redisGet("mat:signals")) || []; }
async function writeSignals(d)          { await redisSet("mat:signals", d); }
async function readLastWeatherAlert()   { return await redisGet("mat:weather:last"); }
async function writeLastWeatherAlert(d) { await redisSet("mat:weather:last", d); }
async function readSeenPosts()          { return (await redisGet("mat:seen_posts")) || {}; }
async function writeSeenPosts(d)        { await redisSet("mat:seen_posts", d); }
async function readMelCache()           { return (await redisGet("mat:mel:cache")) || {}; }
async function writeMelCache(d)         { await redisSet("mat:mel:cache", d); }
async function readIaStats()            { return (await redisGet("mat:ia:stats")) || {}; }
async function writeIaStats(d)          { await redisSet("mat:ia:stats", d); }

function getDataUriMimeType(dataUri = "") {
  const m = String(dataUri).match(/^data:([^;]+);base64,/i);
  return (m?.[1] || "image/jpeg").toLowerCase();
}

async function uploadActuImageToCloudinary(imageBase64) {
  if (!imageBase64) return null;
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");

  const mimeType = getDataUriMimeType(imageBase64);
  return await cloudinary.uploader.upload(imageBase64, {
    folder: "mat/actus",
    resource_type: "image",
    overwrite: false,
    invalidate: false,
    use_filename: false,
    unique_filename: true,
    format: mimeType.includes("png") ? "png" : undefined
  });
}

async function deleteActuImageFromCloudinary(publicId) {
  if (!publicId) return { result: "skipped" };
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");

  return await cloudinary.uploader.destroy(publicId, {
    resource_type: "image",
    type: "upload",
    invalidate: true
  });
}

function getParisDateParts() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = t => fmt.find(p => p.type === t)?.value || '';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return { day, month: day.slice(0, 7) };
}
function pctTrend(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}
function incStat(obj, key, inc = 1) { obj[key] = (obj[key] || 0) + inc; }
function sanitizeDeviceInfo(device = {}) {
  const clean = (v, max = 80, fallback = 'Inconnu') => String(v || fallback).trim().substring(0, max) || fallback;
  return {
    type: clean(device.type, 60),
    model: clean(device.model, 80),
    os: clean(device.os, 80),
    browser: clean(device.browser, 80),
    screen: clean(device.screen, 30),
    pwa: clean(device.pwa, 30),
    matVersion: clean(device.matVersion || device.appVersion, 30, 'Inconnue')
  };
}
function bumpDeviceBreakdown(target, device) {
  if (!target.types) target.types = {};
  if (!target.models) target.models = {};
  if (!target.os) target.os = {};
  if (!target.browsers) target.browsers = {};
  if (!target.pwa) target.pwa = {};
  if (!target.screens) target.screens = {};
  if (!target.appVersions) target.appVersions = {};
  incStat(target.types, device.type);
  incStat(target.models, device.model);
  incStat(target.os, device.os);
  incStat(target.browsers, device.browser);
  incStat(target.pwa, device.pwa);
  incStat(target.screens, device.screen);
  incStat(target.appVersions, device.matVersion);
}
function compactSeenMap(mapObj = {}, keepKeys = []) {
  const keep = new Set(keepKeys);
  for (const k of Object.keys(mapObj)) if (!keep.has(k)) delete mapObj[k];
}

// ─── CORS ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "*");
res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-token, x-device-id");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  next();
});
app.options("*", (req, res) => res.sendStatus(200));

// ═══════════════════════════════════════════════════════════════
// SOURCES & MOTS-CLÉS MEL
// ═══════════════════════════════════════════════════════════════
const SOURCES = {
  mairie_general: [
    "https://mezieres-lez-clery.fr/",
    "https://mezieres-lez-clery.fr/2018/11/03/les-services-municipaux/",
    "https://mezieres-lez-clery.fr/2018/10/23/numeros-utiles/",
    "https://mezieres-lez-clery.fr/2018/10/22/presentation-de-la-commune/",
    "https://mezieres-lez-clery.fr/2018/11/04/le-conseil-municipal/",
  ],
  demarches:      ["https://mezieres-lez-clery.fr/2018/10/25/178/","https://mezieres-lez-clery.fr/2021/03/13/fiche-pratique/"],
  dechets:        ["https://mezieres-lez-clery.fr/2018/10/25/gestion-des-dechets/","https://www.ccterresduvaldeloire.fr/reseau-des-dechetteries/"],
  urbanisme:      ["https://mezieres-lez-clery.fr/2020/09/12/regles-durbanisme/","https://mezieres-lez-clery.fr/2018/11/02/plan-local-durbanisme/","https://mezieres-lez-clery.fr/2024/02/04/permis-de-construire-et-declarations-prealables/"],
  scolaire:       ["https://mezieres-lez-clery.fr/2018/11/03/lecole-de-la-foret/","https://mezieres-lez-clery.fr/2018/11/01/le-restaurant-scolaire/","https://mezieres-lez-clery.fr/2018/10/29/creche-familiale-les-marmousets/","https://mezieres-lez-clery.fr/2018/10/30/centre-de-loisirs/"],
  associations:   ["https://mezieres-lez-clery.fr/2021/12/06/demande-subvention/"],
  dicrim:         ["https://mezieres-lez-clery.fr/2021/06/14/dicrim/"],
  randonnees:     ["https://mezieres-lez-clery.fr/2018/10/21/randonnees-pedestres/","https://mezieres-lez-clery.fr/2018/10/20/tourisme/"],
  assainissement: ["https://www.ccterresduvaldeloire.fr/listes/assainissement/"],
  location:       ["https://mezieres-lez-clery.fr/2018/10/24/location-de-materiel/"],
  cctvl:          [
    "https://www.ccterresduvaldeloire.fr/services-communautaires/",
    "https://www.ccterresduvaldeloire.fr/operation-programmee-pour-lamelioration-de-lhabitat-opah/",
  ],
  fibre:          ["https://mezieres-lez-clery.fr/2020/11/26/offre-thd-radio-4g-fixe/"],
};

const KEYWORDS = {
  transport:      ["bus","car","rémi","remi","ligne 8","transport","horaire","bréau","breau","arrêt","navette","orléans"],
  dechets:        ["déchet","dechet","poubelle","tri","recyclage","collecte","ordure","verre","papier","déchetterie","bac","compost"],
  urbanisme:      ["permis","construire","plu","urbanisme","zone","terrain","déclaration","préalable","construction","bâtir","parcelle","abri","cloture","clôture","géoportail","geoportail","secteur","zone ua","zone ub","zone a","zone n","zone naturelle","zone agricole","1au","hauteur construction","emprise","toiture","lucarne","véranda","veranda","extension","annexe","surface plancher","stationnement","lotissement","manthelon","bourg ancien","hameau","piscine","portail","mur","grillage","ravalement","bardage","façade"],
  scolaire:       ["école","ecole","cantine","restaurant scolaire","périscolaire","enfant","crèche","loisirs","garderie","marmousets","centre de loisirs","service à l'enfance","service à l'enfance"],
  associations:   ["association","asso","subvention","club","bénévole"],
  dicrim:         ["risque","danger","inondation","nucléaire","dicrim","catastrophe","alerte","sirène"],
  randonnees:     ["randonnée","rando","balade","promenade","chemin","circuit","vélo","forêt","nature"],
  assainissement: ["assainissement","spanc","fosse septique","fosse septique","eaux usées","raccordement","eaux grises","eaux vannes","rejet","assainissement non collectif"],
  location:       ["louer","location","matériel","salle","table","chaise","barnum"],
  demarches:      ["carte identité","passeport","naissance","mariage","décès","état civil","acte","certificat","demarche","démarche"],
  cctvl:          ["cctvl","intercommunalité","communauté de communes","terres du val","opah","rénovation","renovation","soliha","maison de santé","médecin","docteur","déchetterie inscription","plaque immatriculation"],
  habitat:        ["opah","rénovation","renovation","travaux logement","aide logement","amélioration habitat","soliha","énergie","isolation","chauffage"],
  agenda:         ["manifestation","fête","événement","agenda","concert","animation","sortie","calendrier"],
  fibre:          ["fibre","internet","adsl","raccordement fibre","eligibilite","éligibilité","numérique","numerique"],
  horaires_mairie:["horaire mairie","horaires mairie","ouverture mairie","ouverte mairie","fermeture mairie","quand la mairie est ouverte","quand ouvre la mairie","quand ferme la mairie"],
  contact_mairie: ["contacter la mairie","contact mairie","telephone mairie","téléphone mairie","mail mairie","email mairie","mairie ouverte","rendez-vous mairie"],
};

function detectTopics(text) {
  const lower = (text || "").toLowerCase();
  const topics = new Set(["mairie_general"]);
  for (const [topic, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => lower.includes(w))) topics.add(topic);
  }
  return [...topics];
}


function ensureIaCategoryStatsShape(stats) {
  if (!stats.iaCategories) stats.iaCategories = {};
  if (!stats.iaCategories.total) stats.iaCategories.total = {};
  if (!stats.iaCategories.parJour) stats.iaCategories.parJour = {};
  if (!stats.iaCategories.parMois) stats.iaCategories.parMois = {};
  if (!stats.iaCategories.sources) stats.iaCategories.sources = {};
  return stats.iaCategories;
}

function bumpStat(obj, key, inc = 1) {
  obj[key] = (obj[key] || 0) + inc;
}

async function trackIaQuestionCategories(userText, source = "pwa") {
  const stats = await readStats();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const categories = ensureIaCategoryStatsShape(stats);

  const topics = detectTopics(userText || "")
    .filter(t => t !== "mairie_general");

  const finalTopics = topics.length ? topics : ["autre"];

  if (!categories.parJour[today]) categories.parJour[today] = {};
  if (!categories.parMois[month]) categories.parMois[month] = {};
  if (!categories.sources[source]) categories.sources[source] = {};

  for (const topic of finalTopics) {
    bumpStat(categories.total, topic);
    bumpStat(categories.parJour[today], topic);
    bumpStat(categories.parMois[month], topic);
    bumpStat(categories.sources[source], topic);
  }

  const keepDays = Object.keys(categories.parJour).sort().slice(-366);
  categories.parJour = Object.fromEntries(keepDays.map(k => [k, categories.parJour[k]]));

  const keepMonths = Object.keys(categories.parMois).sort().slice(-24);
  categories.parMois = Object.fromEntries(keepMonths.map(k => [k, categories.parMois[k]]));

  await writeStats(stats);
}

function computeIaCategoryTrends(parJour = {}) {
  const days = Object.keys(parJour).sort();
  const last7 = days.slice(-7);
  const prev7 = days.slice(-14, -7);

  function sumDays(selectedDays) {
    const out = {};
    for (const day of selectedDays) {
      const cats = parJour[day] || {};
      for (const [cat, n] of Object.entries(cats)) {
        out[cat] = (out[cat] || 0) + Number(n || 0);
      }
    }
    return out;
  }

  const current = sumDays(last7);
  const previous = sumDays(prev7);

  return [...new Set([...Object.keys(current), ...Object.keys(previous)])]
    .map(cat => {
      const nowVal = current[cat] || 0;
      const prevVal = previous[cat] || 0;
      const diff = nowVal - prevVal;
      const pct = prevVal > 0 ? ((diff / prevVal) * 100) : (nowVal > 0 ? 100 : 0);
      return {
        category: cat,
        current: nowVal,
        previous: prevVal,
        diff,
        pct: Number(pct.toFixed(1))
      };
    })
    .sort((a, b) => (b.diff - a.diff) || (b.current - a.current) || a.category.localeCompare(b.category));
}

// ─── Caches ───────────────────────────────────────────────────
const topicCache = {};
let remiCache     = { content: "", lastUpdate: null };
let calendarCache = { content: "", lastUpdate: null };
const CACHE_MS    = 7 * 24 * 60 * 60 * 1000;

// ─── Cache mémoire stats (évite les lectures/écritures Redis à chaque appel MEL) ──
// Les stats sont bufferisées en mémoire et flushées vers Redis toutes les 5 minutes.
// Réduit drastiquement le nb de commandes Redis (plan gratuit Upstash = 10 000/jour).
let _statsCache    = null;  // cache mémoire de mat:stats
let _iaStatsCache  = null;  // cache mémoire de mat:ia:stats
let _statsDirty    = false; // mat:stats a été modifié depuis le dernier flush
let _iaStatsDirty  = false; // mat:ia:stats a été modifié depuis le dernier flush
const STATS_FLUSH_MS = 5 * 60 * 1000; // flush toutes les 5 minutes

async function readStats() {
  if (_statsCache !== null) return _statsCache;
  _statsCache = (await redisGet("mat:stats")) || {};
  return _statsCache;
}
async function writeStats(d) {
  _statsCache = d;
  _statsDirty = true;
  // Pas d'écriture Redis immédiate — le flush périodique s'en charge
}
async function readIaStats() {
  if (_iaStatsCache !== null) return _iaStatsCache;
  _iaStatsCache = (await redisGet("mat:ia:stats")) || {};
  return _iaStatsCache;
}
async function writeIaStats(d) {
  _iaStatsCache = d;
  _iaStatsDirty = true;
}

// Flush périodique vers Redis (toutes les 5 min)
setInterval(async () => {
  try {
    if (_statsDirty && _statsCache !== null) {
      await redisSet("mat:stats", _statsCache);
      _statsDirty = false;
    }
    if (_iaStatsDirty && _iaStatsCache !== null) {
      await redisSet("mat:ia:stats", _iaStatsCache);
      _iaStatsDirty = false;
    }
  } catch(e) {
    console.warn("Stats flush Redis:", e.message);
  }
}, STATS_FLUSH_MS);


function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi,"")
    .replace(/<style[\s\S]*?<\/style>/gi,"")
    .replace(/<nav[\s\S]*?<\/nav>/gi,"")
    .replace(/<footer[\s\S]*?<\/footer>/gi,"")
    .replace(/<header[\s\S]*?<\/header>/gi,"")
    .replace(/<[^>]+>/g," ")
    .replace(/\s{3,}/g,"\n\n")
    .replace(/&[a-z]+;/g," ")
    .trim()
    .substring(0,2500);
}

// ─── Nettoyage markdown pour affichage mobile ─────────────────
function cleanMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")   // gras
    .replace(/\*(.*?)\*/g, "$1")       // italique
    .replace(/#{1,6}\s/g, "")          // titres
    .replace(/`{1,3}(.*?)`{1,3}/g, "$1") // code
    .replace(/^\s*[-•]\s/gm, "• ")    // listes
    .replace(/\n{3,}/g, "\n\n")        // sauts multiples
    .trim();
}

async function fetchUrl(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      responseType: "arraybuffer",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MATBot/3.0)" }
    });
    const ct = res.headers["content-type"] || "";
    if (ct.includes("text")) {
      return { text: cleanHtml(Buffer.from(res.data).toString("utf-8")), binary: null };
    }
    return { text: null, binary: Buffer.from(res.data).toString("base64") };
  } catch(e) {
    console.warn(`⚠️ ${url}: ${e.message}`);
    return { text:null, binary:null };
  }
}

async function refreshRemiCache() {
  const { binary } = await fetchUrl("https://drive.google.com/uc?export=download&id=1Fn9SWsL7jdipI3G0xq61NjWuluSPSZie");
  if (!binary || !anthropic) {
    remiCache.content = "[Horaires Rémi : PDF non accessible]";
    return;
  }
  try {
    const resp = await anthropic.messages.create({
      model:"claude-haiku-4-5-20251001",
      max_tokens:800,
      messages:[{ role:"user", content:[
        { type:"document", source:{ type:"base64", media_type:"application/pdf", data:binary } },
        { type:"text", text:"Extrais UNIQUEMENT les horaires des arrêts MAIRIE et LE BRÉAU à Mézières-lez-Cléry. Pour chaque arrêt : direction Orléans et Saint-Laurent-Nouan, période scolaire et vacances. Texte structuré sans markdown." }
      ]}]
    });
    remiCache.content = `=== HORAIRES BUS LIGNE 8 RÉMI ===\n${resp.content[0].text}`;
    remiCache.lastUpdate = new Date();
  } catch(e) {
    remiCache.content = "[Horaires Rémi : erreur]";
  }
}

function parseIcal(icsText) {
  const events = [];
  const now = new Date();
  const limit = new Date(now.getTime() + 90*24*60*60*1000);
  const blocks = icsText.split("BEGIN:VEVENT");

  for (let i=1; i<blocks.length; i++) {
    const b = blocks[i];
    const get = k => {
      const m = b.match(new RegExp(`${k}[^:]*:(.+)`));
      return m ? m[1].replace(/\r/g,"").trim() : "";
    };

    const rawStart = get("DTSTART");
    const summary = get("SUMMARY");
    const location = get("LOCATION");
    const desc = get("DESCRIPTION").replace(/\\n/g," ").substring(0,150);

    if (!rawStart || !summary) continue;

    const y  = rawStart.substring(0,4);
    const mo = rawStart.substring(4,6);
    const d  = rawStart.substring(6,8);
    const h  = rawStart.length > 8 ? rawStart.substring(9,11) : "00";
    const mn = rawStart.length > 8 ? rawStart.substring(11,13) : "00";
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mn}:00`);

    if (isNaN(dt) || dt < now || dt > limit) continue;

    const dateStr = dt.toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
    const timeStr = h !== "00" ? ` à ${h}h${mn}` : "";

    let line = `📅 ${summary} — ${dateStr}${timeStr}`;
    if (location) line += ` 📍 ${location}`;
    if (desc) line += `\n   ${desc}`;

    events.push({dt,line});
  }

  events.sort((a,b)=>a.dt-b.dt);
  return events.map(e=>e.line).join("\n\n");
}

async function refreshCalendarCache() {
  if (!GOOGLE_CALENDAR_ICAL) return;
  try {
    const res = await axios.get(GOOGLE_CALENDAR_ICAL,{timeout:10000});
    const parsed = parseIcal(res.data);
    calendarCache.content = parsed ? `=== AGENDA (3 prochains mois) ===\n${parsed}` : "=== AGENDA === Aucun événement.";
    calendarCache.lastUpdate = new Date();
  } catch(e) {
    calendarCache.content = "[Agenda : non accessible]";
  }
}

async function getTopicContent(topic) {
  const now=Date.now();
  if (topicCache[topic]?.lastUpdate && now-topicCache[topic].lastUpdate.getTime() < CACHE_MS) {
    return topicCache[topic].content;
  }

  const parts = [];
  for (const url of (SOURCES[topic] || [])) {
    const { text } = await fetchUrl(url);
    if (text) parts.push(`--- ${url} ---\n${text}`);
  }

  const content = parts.join("\n\n");
  topicCache[topic] = { content, lastUpdate: new Date() };
  return content;
}

async function buildContext(userText, explicitTopic = null) {
  // Si topic explicite (envoyé par l'arbre de décision front), ne charger que ce topic
  // + mairie_general. Sinon fallback sur détection automatique.
  const topics = explicitTopic
    ? [...new Set(["mairie_general", explicitTopic])]
    : detectTopics(userText);
  const parts = [];

  if (!calendarCache.lastUpdate || Date.now()-calendarCache.lastUpdate.getTime() > CACHE_MS) {
    await refreshCalendarCache();
  }
  if (calendarCache.content) parts.push(calendarCache.content);

  for (const topic of topics) {
    if (topic === "transport") {
      if (!remiCache.lastUpdate || Date.now()-remiCache.lastUpdate.getTime() > CACHE_MS) {
        await refreshRemiCache();
      }
      parts.push(remiCache.content);
    } else if (topic === "agenda") {
      // déjà inclus
    } else if (SOURCES[topic]) {
      const c = await getTopicContent(topic);
      if (c) parts.push(`=== ${topic.toUpperCase()} ===\n${c}`);
    }
  }

  return parts.join("\n\n─────────────────────────────\n\n");
}

// ── Météo / Vigilance ─────────────────────────────────────────
const VIGILANCE_COLORS = {
  1: "vert",
  2: "jaune",
  3: "orange",
  4: "rouge",
};

const VIGILANCE_PHENOMENA = {
  1: "vent violent",
  2: "pluie-inondation",
  3: "orages",
  4: "crues",
  5: "neige-verglas",
  6: "canicule",
  7: "grand froid",
  8: "avalanches",
  9: "vagues-submersion",
};

async function fetchOpenMeteoForecast() {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(OPEN_METEO_LAT)}` +
    `&longitude=${encodeURIComponent(OPEN_METEO_LON)}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,pressure_msl,precipitation,wind_gusts_10m` +
    `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,wind_gusts_10m,surface_pressure` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,uv_index_max,sunrise,sunset,wind_direction_10m_dominant,wind_gusts_10m_max` +
    `&past_days=1` +
    `&forecast_days=10` +
    `&timezone=${encodeURIComponent(OPEN_METEO_TZ)}`;

  const r = await axios.get(url, { timeout: 15000 });
  return r.data;
}

async function fetchMeteoFranceVigilanceRaw() {
  if (!METEOFRANCE_VIGILANCE_URL) {
    throw new Error("METEOFRANCE_VIGILANCE_URL non configurée");
  }

  const headers = {};
  if (METEOFRANCE_API_TOKEN) {
    headers.apikey = METEOFRANCE_API_TOKEN;
  }

  const r = await axios.get(METEOFRANCE_VIGILANCE_URL, {
    headers,
    timeout: 15000,
  });

  return r.data;
}

function extractDepartmentVigilance(raw, deptCode = "45") {
  if (!raw || !raw.product || !Array.isArray(raw.product.periods)) return null;

  const periods = raw.product.periods;
  const now = Date.now();

  let bestPeriod = periods.find(p => {
    const begin = new Date(p.begin_validity_time).getTime();
    const end = new Date(p.end_validity_time).getTime();
    return !Number.isNaN(begin) && !Number.isNaN(end) && now >= begin && now <= end;
  });

  if (!bestPeriod) bestPeriod = periods[0];
  if (!bestPeriod) return null;

  const deptDomain = (bestPeriod.timelaps?.domain_ids || []).find(d => String(d.domain_id) === String(deptCode));
  if (!deptDomain) return null;

  const items = Array.isArray(deptDomain.phenomenon_items) ? deptDomain.phenomenon_items : [];
  if (!items.length) return null;

  const sorted = [...items].sort((a, b) => (Number(b.color_id || b.phenomenon_max_color_id || 0)) - (Number(a.color_id || a.phenomenon_max_color_id || 0)));
  const main = sorted[0];
  if (!main) return null;

  const color = Number(main.phenomenon_max_color_id || main.color_id || 1);
  const phenomenonId = Number(main.phenomenon_id || 0);

  let start = null;
  let end = null;

  if (Array.isArray(main.timelaps_items) && main.timelaps_items.length) {
    const active = main.timelaps_items
      .filter(t => Number(t.color_id || 1) >= color)
      .sort((a, b) => new Date(a.begin_time) - new Date(b.begin_time));

    if (active.length) {
      start = active[0].begin_time || null;
      end = active[active.length - 1].end_time || null;
    }
  }

  const textBlocks = Array.isArray(raw.product.text_bloc_items) ? raw.product.text_bloc_items : [];
  const matchingTexts = textBlocks
    .filter(t => String(t.domain_id) === String(deptCode))
    .map(t => t.text)
    .filter(Boolean);

  return {
    department_code: String(deptCode),
    level: color,
    color_label: VIGILANCE_COLORS[color] || "vert",
    phenomenon_id: phenomenonId,
    phenomenon_label: VIGILANCE_PHENOMENA[phenomenonId] || "phénomène météo",
    start,
    end,
    title: `${VIGILANCE_COLORS[color] || "vert"} — ${VIGILANCE_PHENOMENA[phenomenonId] || "phénomène météo"}`,
    main_text: matchingTexts[0] || "",
    raw_period_name: bestPeriod.echeance || null,
  };
}

function formatAlertDateFr(iso) {
  if (!iso) return "à préciser";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "à préciser";
  return d.toLocaleString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ═══════════════════════════════════════════════════════════════
// MEL — Prompt système
// ═══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Tu es MEL, l'assistante virtuelle de la mairie de Mézières-lez-Cléry (45370, Loiret, France).
Tu aides les habitants sur tous les sujets de la vie communale : urbanisme, démarches administratives, école, déchets, associations, transports, fibre, événements, randonnées, élus et conseil municipal.

DOMAINE : Tu es spécialisée dans les services publics et la vie locale. Tu réponds aux questions concernant :
- La commune de Mézières-lez-Cléry et ses services (mairie, école, déchets, urbanisme, associations, événements, élus)
- L'intercommunalité CCTVL et ses services (déchetteries, transports, assainissement, santé, habitat)
- Le département du Loiret et la région Centre-Val de Loire (services de proximité, aides, transports régionaux)
- Les services de l'État accessibles aux habitants (préfecture, CAF, Pôle Emploi, impôts, carte d'identité, passeport)
- Les services publics en général (La Poste, santé, éducation, logement social, aides sociales)
- Les questions pratiques de la vie quotidienne liées à des démarches administratives ou services publics

Tu déclares poliment ne pas pouvoir aider UNIQUEMENT pour les sujets sans lien avec les services publics ou la vie locale : culture générale pure, recettes de cuisine, sport, divertissement, actualités nationales sans lien local, questions commerciales ou privées.

RÈGLES ABSOLUES :
- Réponds TOUJOURS en français, de façon claire, bienveillante et concrète.
- Tu réponds TOUJOURS avec au moins une information utile ou une orientation pratique, même si tu n'as pas tous les détails.
- Ne dis JAMAIS "je ne sais pas" sans proposer une solution ou un contact utile.
- Ne renvoie vers la mairie (02 38 45 61 76) QUE si la question nécessite une décision humaine, un rendez-vous ou un cas très particulier.
- Ne mentionne JAMAIS quel modèle d'IA tu es. Tu es MEL, l'assistante de la mairie de Mézières-lez-Cléry. Point.
- NE PARLE JAMAIS DE MESSENGER ni de Facebook.
- Réponses courtes : 3 à 5 phrases. Sois directe et pratique.
- Si la conversation contient des messages précédents, tiens-en compte pour répondre dans la continuité.
- Quand tu mentionnes un élu (maire, adjoint, conseiller), donne ses informations disponibles (rôle, pôle) et indique que l'utilisateur peut contacter la mairie au 02 38 45 61 76 pour le joindre. Utilise le mot-clé magique [SHOW_ELUS] à la fin de ta réponse si la question porte sur un ou plusieurs élus nommément, pour que l'interface propose le trombinoscope.

URBANISME — PLU DE MÉZIÈRES-LEZ-CLÉRY (approuvé 30/01/2013) :
Pour identifier sa zone : geoportail-urbanisme.gouv.fr (cliquer sur la parcelle → zone affichée à gauche).
Lien direct : geoportail-urbanisme.gouv.fr/map/#tile=1&lon=1.8048&lat=47.8181&zoom=15

ZONES :
- Ua (bourg ancien/hameaux anciens) : habitat + commerces/artisanat compatibles. Hauteur max 6 m (façade). Clôture en bordure voie : max 1,60 m en zone Ua. Emprise max 50 %. Toiture 2 pentes ≥ 35° ardoises/tuiles plates. Recul voie : alignement ou ≥ 2 m. Limite séparative : contigu ou retrait ≥ 3 m.
- Ub (résidentiel XXe s.) : hauteur max 4 m. Emprise max 30 %. Recul voie ≥ 5 m. 30 % espaces verts obligatoires. Toiture 2 pentes ≥ 35°. Pas de blanc pur ni couleurs vives en façade. Ub1 (Clos Manthelon) : hauteur max 8 m, tuiles terre cuite 40-45°.
- Ue (équipements publics) : hauteur max 7 m.
- Ui (industrie) : hauteur max 8 m, emprise max 60 %.
- 1AU (à urbaniser court terme) : opération d'ensemble obligatoire. Hauteur max 5 m. Emprise max 40 %. Recul voie ≥ 5 m. 30 % espaces verts.
- 1AUe (équipements futurs) : hauteur max 8 m.
- 2AU (réserve long terme) : toute construction interdite sauf services publics.
- A (agricole) : seuls bâtiments agricoles. Secteur Ah (hameaux) : extensions max 20 % + annexes max 50 m², hauteur max 5 m, recul ≥ 8 m des voies.
- N (naturelle/forestière) : quasi inconstructible. Nh : extensions max 20 % + annexes max 50 m², hauteur max 5 m. Nj (jardins) : abris max 20 m². Nl : loisirs collectifs. Np : photovoltaïque.

AUTORISATIONS (règles générales valables à Mézières-lez-Cléry) :
IMPORTANT : Pour tout projet, commence par identifier ta zone PLU sur Géoportail Urbanisme (geoportail-urbanisme.gouv.fr) car les règles varient selon la zone (Ua, Ub, A, N...). En cas de doute, contacte la mairie : urbanisme@mezieres-lez-clery.fr ou 02 38 45 61 76.

- Délais : DP = 1 mois ; PC = 2 mois. Validité : 3 ans.
- Clôture/portail/mur : DP obligatoire (délibération 01/03/2012). Les hauteurs maximales varient selon la zone PLU — ne pas donner de valeurs générales sans connaître la zone. Formulaire Cerfa 16702*02.
- Abri de jardin/cabane/appentis : < 5 m² libre (sauf secteur protégé) ; ≤ 20 m² DP ; > 20 m² PC.
- Extension/garage accolé : en zone urbaine (U), jusqu'à 40 m² de SP = DP ; au-delà = PC. Si surface totale après travaux > 150 m² = PC avec architecte obligatoire.
- Véranda/terrasse couverte : jusqu'à 40 m² de SP (si SP totale ≤ 150 m²) = DP ; au-delà = PC. En zone urbaine y compris lotissements.
- Terrasse non couverte de plain-pied (béton/bois) : sans surélévation = libre (sauf secteur protégé). Surélevée - 40 m² = DP (si SP ≤ 150 m²) ; au-delà = PC.
- Piscine : ≤ 10 m² non couverte = libre (sauf secteur protégé) ; ≤ 100 m² non couverte = DP ; ≤ 100 m² couverte < 1,80 m = DP ; > 100 m² = PC.
- Piscine temporaire (< 3 mois) : libre quelle que soit la surface.
- Fenêtre de toit/Velux : DP. Photovoltaïque sur toit : DP.
- Façade/ravalement/bardage : DP. Si teinte identique : libre (sauf secteur protégé).
- Toit/tuiles : remplacement à l'identique = libre (sauf secteur protégé) ; changement = DP.
- Stationnement : 2 places minimum par logement. Artisanat/bureaux : 1 place/25 m².
- Dépôt dossier : mairie (02 38 45 61 76) ou GNAU CCTVL (ccterresduvaldeloire.fr). Cerfa PC = 13406 ; DP = 13703 ; Clôture = 16702*02.
- Lien PLU : https://drive.google.com/file/d/1F7lwiMPX2dAPTptaT186vN0CXEpL92z4/view?usp=drive_link

RÈGLE CRITIQUE URBANISME : Ne JAMAIS inventer ou extrapoler des règles de hauteur, d'emprise ou de distance spécifiques à une zone sans les connaître avec certitude. Si tu n'es pas sûre, dis-le et renvoie vers urbanisme@mezieres-lez-clery.fr.

IMAGE URBANISME : Quand une question porte sur une autorisation d'urbanisme (clôture, extension, garage, piscine, véranda, abri, terrasse, toit, façade, permis), ajoute en fin de réponse le mot-clé [SHOW_URBANISME] pour que l'interface affiche le schéma des autorisations.

PLU : Dès que tu mentionnes le PLU de Mézières, ajoute le lien : https://drive.google.com/file/d/1F7lwiMPX2dAPTptaT186vN0CXEpL92z4/view?usp=drive_link

CONTACTS UTILES :
- Mairie : 02 38 45 61 76 — mairie@mezieres-lez-clery.fr
- Horaires : lundi 14h-17h30, mercredi sur RDV, vendredi 8h30-11h30
- Site : mezieres-lez-clery.fr

CONSEIL MUNICIPAL DE MÉZIÈRES-LEZ-CLÉRY (15 élus) :
- Maire : Romuald GENTY (Pôle Finances)
- 1ère adjointe : Sandra BARET (Pôle Social et Environnement)
- 2ème adjoint : Damien BOUGRÉ (Pôle Vie Scolaire)
- 3ème adjointe : Stéphanie GREUIN (Pôle Relation Entreprise)
- 4ème adjoint : Stéphane MAROIS (Pôle Voirie et Sécurité)
- Conseillers municipaux : Fabrice AUFFRET, Katia COURTOIS, Christophe DESCHAMPS, Amandine BUREAU, Bruno MAILLARY, Caroline BAILLIOT-LEROY, Elodie FRANCOIS, Léane FARINA-JAVOY, Romain LOTHE, Sarah MARECHAL.
- Contact général élus : mairie au 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr

COMMUNAUTÉ DE COMMUNES DES TERRES DU VAL DE LOIRE (CCTVL) :
Mézières-lez-Cléry fait partie de la CCTVL (27 communes). Siège : 2 rue des Germines, 45190 Beaugency. Tél. 02 38 44 59 35. Site : ccterresduvaldeloire.fr

DÉCHETTERIES (gérées par la CCTVL) :
- Sites : Beauce la Romaine, Cléry-Saint-André (la plus proche de Mézières), Épieds-en-Beauce, Meung-sur-Loire, Saint-Ay, Villorceau (fermée temporairement pour travaux).
- Inscription OBLIGATOIRE pour Cléry-Saint-André, Meung-sur-Loire et Saint-Ay (lecture automatique de plaque). Inscription sur portail-usagers.ccterresduvaldeloire.fr — munissez-vous d'un justificatif de domicile et de la carte grise. Enregistrer les plaques SANS tiret (ex : AA123BB).
- Une inscription vaut pour tous les sites CCTVL.
- Déchetterie de Cléry-Saint-André : lun-sam sauf jours fériés. Hiver (oct-mars) 10h-12h et 14h-17h. Été (avr-sep) 9h-12h et 14h-18h.
- FAQ : ccterresduvaldeloire.fr/medias/2023/10/FAQ-gestion-dacces-DT.pdf
- Tél. renseignements déchets : 02 38 44 59 35.

ASSAINISSEMENT (CCTVL) :
- Assainissement collectif (réseau public) : contact CCTVL 02 38 44 59 35 — assainissement@ccterresduvaldeloire.fr.
- SPANC (assainissement non collectif) : pour les habitations non raccordées au réseau. La CCTVL contrôle les fosses septiques et installations individuelles (conception, réalisation, contrôles périodiques). Obligatoire. Même contact.
- Portail facturation : portail-usagers.ccterresduvaldeloire.fr

SANTÉ (CCTVL) :
- 3 Maisons de Santé Pluridisciplinaires :
  • Cléry-Saint-André — Val d'Ardoux (1 allée Dr Roland Delastre) : 6 médecins, 5 kiné, 4 infirmiers, 2 dentistes, podologue, orthophoniste, nutritionniste, ostéopathe, psychologue. Doctolib disponible. C'est la maison de santé la plus proche de Mézières-lez-Cléry.
  • Meung-sur-Loire (1 rue des Tanneries) : 6 médecins, 5 infirmières, 2 kiné, orthophoniste, podologue.
  • Tavers — Les Cîteaux (11 avenue des Cîteaux) : 6 médecins, 3 infirmières, 3 kiné, 2 dentistes, pédicure, diététicienne.
- La CCTVL cherche activement à attirer de nouveaux médecins sur le territoire.

TRANSPORTS — Réseau Rémi (lignes régulières depuis Mézières) :
- Ligne 8 : St-Laurent-Nouan → Cléry-Saint-André → Mézières-lez-Cléry (arrêts Mairie et Le Bréau) → Orléans. C'est la ligne principale desservant Mézières.
- Ligne 9A : Cravant – Beaugency – Meung-sur-Loire – Chaingy – Orléans.
- Horaires Ligne 8 : remi-centrevaldeloire.fr (PDF 2025). Différents selon période scolaire et vacances.
- Transports scolaires : circuits organisés par la CCTVL. Rens. 02 38 44 59 35.
- Vélo à assistance électrique (VAE) : location possible via la CCTVL.
- Application Géovélo disponible pour les itinéraires vélo.

HABITAT / RÉNOVATION (CCTVL) :
- OPAH (Opération Programmée d'Amélioration de l'Habitat) : depuis décembre 2023. Aide aux ménages modestes pour rénovation énergétique et lutte contre l'insalubrité.
- Contact SOLIHA (opérateur missionnné) : 02 38 77 87 21 — contact.loiret@soliha.fr. Service gratuit et sans engagement : étude de projet, conseils techniques, évaluation des aides, assistance administrative.
- Aides mobilisables : MaPrimeRénov, ANAH, aides CCTVL. Détails : ccterresduvaldeloire.fr/medias/2025/10/OPAH_Annexes-aides_2025.pdf

URBANISME / PLUi-H (CCTVL) :
- La CCTVL est compétente pour le PLUi-H (Plan Local d'Urbanisme intercommunal) en cours d'élaboration.
- GNAU (Guichet Numérique des Autorisations d'Urbanisme) : dépôt en ligne des permis de construire et déclarations préalables. Accessible sur le site ccterresduvaldeloire.fr.
- En attendant le PLUi-H, le PLU communal de Mézières (approuvé 30/01/2013) reste en vigueur.
- Pour connaître sa zone PLU : geoportail-urbanisme.gouv.fr (cliquer sur sa parcelle, la zone s'affiche à gauche).`;

// ─── Optimisation MEL low-cost ────────────────────────────────
// Les DIRECT_RULES donnent des réponses COMPLÈTES (pas des demandes de précision)
// afin de ne pas casser le fil de conversation.
const DIRECT_RULES = [
  {
    name: "cloture_rue",
    test: (q) => /(cloture|clôture|portail|mur|grillage|palissade|clos)/.test(q) && /(rue|voie|public|bord|riverain|chaussee|trottoir)/.test(q),
    answer: "🏗️ Une clôture en limite de voie publique nécessite une déclaration préalable de travaux (art. R421-12 du Code de l'urbanisme). Le dossier est à déposer à la mairie (02 38 45 61 76). Délai d'instruction : 1 mois. Pensez à vérifier les règles du PLU local (hauteur max, matériaux autorisés) sur mezieres-lez-clery.fr."
  },
  {
    name: "cloture_voisin",
    test: (q) => /(cloture|clôture|portail|mur|grillage|palissade)/.test(q) && /(voisin|propriete|propriété|fond|mitoyen|separative|séparative|limite de propriete)/.test(q),
    answer: "🏗️ Une clôture en limite séparative (entre propriétés voisines) est en principe libre, sans déclaration, si elle respecte les hauteurs du PLU de Mézières-lez-Cléry. Aucune formalité n'est requise en général, sauf si vous êtes en secteur protégé ou si la hauteur dépasse 2 mètres. Confirmez avec la mairie (02 38 45 61 76) selon votre parcelle."
  },
  {
    name: "abri_jardin",
    test: (q) => /(abri|cabane|chalet|appenti|appentis|remise)/.test(q) && /(jardin|bois|metal|surface|m2|metre|mètre)/.test(q),
    answer: "🏗️ Pour un abri de jardin : moins de 5 m² = libre (aucune formalité) ; entre 5 et 20 m² = déclaration préalable ; plus de 20 m² = permis de construire. Si votre abri dépasse 1,80 m de hauteur et est accolé à la maison, les règles peuvent différer. Vérifiez avec la mairie (02 38 45 61 76)."
  },
  {
    name: "piscine",
    test: (q) => /piscine|bassin|jacuzzi|spa/.test(q),
    answer: "🏗️ Pour une piscine : bassin non couvert de moins de 100 m² = déclaration préalable ; bassin couvert ou plus de 100 m² = permis de construire. Pensez aussi à la déclaration en mairie pour la taxe d'aménagement. Contactez le 02 38 45 61 76 pour vérifier les règles du PLU sur votre parcelle."
  },
  {
    name: "extension",
    test: (q) => /(extension|agrandissement|véranda|veranda|terrasse couverte|garage)/.test(q),
    answer: "🏗️ Pour une extension : moins de 20 m² en dehors des zones U (ou 40 m² en zone U) = déclaration préalable. Au-delà, ou si le total de la maison dépasse 150 m² après travaux = permis de construire avec architecte obligatoire. La mairie (02 38 45 61 76) peut vous dire dans quelle zone se situe votre parcelle."
  },
  {
    name: "demarches_cni",
    test: (q) => /(carte.identit|cni|piece.identit)/.test(q),
    answer: "📄 La carte d'identité ne se fait plus à Mézières-lez-Cléry mais dans une mairie équipée d'une station biométrique (Saint-Hilaire-Saint-Mesmin, Cléry-Saint-André ou Orléans par exemple). Prenez rendez-vous en ligne sur mairie-clery-saint-andre.fr ou directement à Orléans. Pièces à fournir : justificatif de domicile, photo d'identité, ancienne CNI si renouvellement."
  },
  {
    name: "demarches_passeport",
    test: (q) => /passeport/.test(q),
    answer: "📄 Le passeport se fait dans une mairie équipée d'une station biométrique (pas à Mézières-lez-Cléry). Les plus proches : Cléry-Saint-André, Saint-Hilaire-Saint-Mesmin, ou Orléans. Prenez rendez-vous en ligne sur le site de la mairie concernée. Comptez 3 à 4 semaines de délai en période normale."
  },
  {
    name: "demarches_etatcivil",
    test: (q) => /(acte.naissance|acte.mariage|acte.deces|état civil|etat civil|extrait|certificat)/.test(q),
    answer: "📄 Les actes d'état civil (naissance, mariage, décès) peuvent être demandés directement en mairie de Mézières-lez-Cléry (02 38 45 61 76) ou en ligne sur service-public.fr. Pour un acte d'une commune extérieure, contactez directement la mairie concernée ou passez par service-public.fr."
  },
  {
    name: "cantine",
    test: (q) => /(cantine|restaurant scolaire|repas school|repas enfant)/.test(q),
    answer: "🧒 Le restaurant scolaire de Mézières-lez-Cléry accueille les élèves de l'école de la Forêt. Les inscriptions et informations pratiques (tarifs, menus, fréquence) sont à demander à la mairie au 02 38 45 61 76 ou par mail à mairie@mezieres-lez-clery.fr."
  },
  {
    name: "centre_loisirs",
    test: (q) => /(centre.loisirs|alsh|accueil.loisirs|periscolaire|périscolaire|garderie|marmousets|creche|crèche)/.test(q),
    answer: "🧒 La commune dispose d'un centre de loisirs, d'un service périscolaire (garderie matin/soir) et d'une crèche familiale Les Marmousets. Pour les inscriptions et tarifs, contactez la mairie (02 38 45 61 76) ou consultez mezieres-lez-clery.fr, rubrique Services à l'enfance."
  },
  {
    name: "fibre",
    test: (q) => /fibre|eligibilit|raccordement.fibre|val.loire.fibre/.test(q),
    answer: "🌐 Le déploiement de la fibre optique à Mézières-lez-Cléry est géré par Val de Loire Fibre. Vérifiez votre éligibilité sur valdeloire-fibre.fr ou contactez votre fournisseur internet. Pour toute question sur l'avancement du déploiement dans votre rue, la mairie (02 38 45 61 76) peut vous orienter."
  },
  {
    name: "dechetterie_inscription",
    test: (q) => /(inscription|inscrire|s.inscrire|plaque|immatriculation|accès|acces).*(dechetterie|déchetterie)|dechetterie.*(inscription|inscrire|plaque|accès|acces)|(comment|puis-je|faut-il|peut-on).*(dechetterie|déchetterie)|(dechetterie|déchetterie).*(comment|acceder|accéder|utiliser|aller)/.test(q),
    answer: "🏭 Pour accéder aux déchetteries de Cléry-Saint-André, Meung-sur-Loire et Saint-Ay, une inscription préalable est obligatoire (lecture automatique de plaque). Inscrivez-vous sur portail-usagers.ccterresduvaldeloire.fr avec un justificatif de domicile et votre carte grise. Enregistrez votre plaque SANS tiret (ex: AA123BB). Une seule inscription vaut pour tous les sites CCTVL. Tél: 02 38 44 59 35."
  },
  {
    name: "dechets_collecte",
    test: (q) => /(collecte|bac.noir|bac.jaune|poubelle|ordure|recyclage|verre|papier|tri selectif|bac de tri)/.test(q),
    answer: "🗑️ À Mézières-lez-Cléry : le bac gris (ordures ménagères) est collecté chaque lundi matin — sortez-le le dimanche soir. Le bac jaune (recyclables) est collecté un lundi sur deux (semaines paires). La déchetterie de Cléry-Saint-André est ouverte du lundi au samedi (sauf jours fériés) : 10h-12h et 14h-17h en hiver, 9h-12h et 14h-18h en été."
  },
  {
    name: "maison_sante",
    test: (q) => /(medecin|médecin|docteur|généraliste|generaliste|maison.sante|maison de santé|kiné|kinesitherapeute|infirmier|dentiste|orthophoniste|soigner|consultation)/.test(q),
    answer: "🏥 La maison de santé la plus proche de Mézières-lez-Cléry est celle du Val d'Ardoux à Cléry-Saint-André (1 allée Dr Roland Delastre) : 6 médecins généralistes, 5 kinés, 4 infirmiers, 2 dentistes, podologue, orthophoniste, ostéopathe et psychologue. Prise de RDV sur Doctolib. Pour toute question : CCTVL au 02 38 44 59 35."
  },
  {
    name: "opah_renovation",
    test: (q) => /(opah|renovation|rénovation|travaux.logement|aide.logement|soliha|amélioration.habitat|maprimerenov|isolation|chauffage.aide|énergie.travaux)/.test(q),
    answer: "🏠 La CCTVL propose une OPAH (Opération Programmée d'Amélioration de l'Habitat) pour aider les ménages modestes à rénover leur logement (rénovation énergétique, lutte contre l'insalubrité). Contactez SOLIHA, l'opérateur désigné : 02 38 77 87 21 — contact.loiret@soliha.fr. Service gratuit et sans engagement. Des aides comme MaPrimeRénov et l'ANAH sont mobilisables."
  },
  {
    name: "spanc_assainissement",
    test: (q) => /(spanc|fosse.septique|assainissement.non.collectif|eaux.usees|eaux usées|vidange|epandage|épandage)/.test(q),
    answer: "🚰 L'assainissement non collectif (fosses septiques, etc.) est contrôlé par le SPANC de la CCTVL. Toute habitation non raccordée au réseau public doit faire contrôler son installation. Contact : CCTVL au 02 38 44 59 35 — assainissement@ccterresduvaldeloire.fr. Le portail facturation est sur portail-usagers.ccterresduvaldeloire.fr."
  },

  // ── PLU Mézières-lez-Cléry (règlement approuvé 30/01/2013) ──
  {
    name: "plu_geoportail",
    test: (q) => /geoportail|géoportail|ma.zone|quelle.zone|trouver.zone|connaitre.zone|connaître.zone|ma.parcelle|numero.parcelle|numéro.parcelle|secteur.habitation|quelle.est.ma.zone/.test(q),
    answer: "🗺️ Pour connaître votre zone PLU à Mézières-lez-Cléry : rendez-vous sur geoportail-urbanisme.gouv.fr, entrez votre adresse, zoomez sur votre parcelle et cliquez dessus — la zone (Ua, Ub, A, N…) et le numéro de parcelle apparaissent dans le panneau de gauche. Lien direct centré sur Mézières : geoportail-urbanisme.gouv.fr/map/#tile=1&lon=1.8048&lat=47.8181&zoom=15 — Posez-moi ensuite votre zone pour que je vous explique les règles !"
  },
  {
    name: "plu_zone_ua",
    test: (q) => /ua|zone.ua|bourg.ancien|hameau.ancien|vieux.bourg/.test(q),
    answer: "🏗️ La zone Ua correspond aux secteurs bâtis les plus anciens du bourg et hameaux de Mézières. Vocation principale : habitat. Commerces et artisanat compatibles acceptés. Règles clés : hauteur max 6 m à l'égout, emprise au sol max 50 %, toiture 2 pentes ≥ 35° en ardoises ou tuiles plates, implantation à l'alignement ou recul ≥ 2 m, limite séparative : contiguïté ou retrait ≥ 3 m. Pour identifier votre zone : geoportail-urbanisme.gouv.fr ou mairie au 02 38 45 61 76."
  },
  {
    name: "plu_zone_ub",
    test: (q) => /ub|zone.ub|zone.ub1|lotissement|manthelon|clos.de.manthelon|zone.residentielle|zone.résidentielle/.test(q),
    answer: "🏗️ La zone Ub est la zone résidentielle de Mézières (constructions de la 2e moitié du XXe siècle). Règles clés : hauteur max 4 m à l'égout, emprise max 30 %, recul ≥ 5 m de la voie, 30 % du terrain en espaces verts, toiture 2 pentes ≥ 35° en ardoises/tuiles plates, murs sans blanc pur ni couleur vive. Secteur Ub1 (Clos de Manthelon) : hauteur max 8 m, tuiles terre cuite 40-45°, sens du faîtage imposé selon le plan parcellaire. Pour localiser votre parcelle : geoportail-urbanisme.gouv.fr"
  },
  {
    name: "plu_zone_agricole",
    test: (q) => /zone.a|zone.ah|zone.agricole|terrain.agricole|secteur.agricole/.test(q),
    answer: "🌾 La zone A est la zone agricole de Mézières : seuls les bâtiments nécessaires à l'exploitation agricole sont autorisés. Le secteur Ah (hameaux non agricoles) permet des extensions mesurées (max 20 % de la surface existante, emprise max 50 m²) et des changements de destination vers habitat, bureaux, commerce ou tourisme. Hauteur max habitation : 5 m. Recul ≥ 8 m des voies (sauf A71 : 100 m). Toiture en ardoises ou tuiles plates ≥ 35°. Mairie : 02 38 45 61 76."
  },
  {
    name: "plu_zone_naturelle",
    test: (q) => /zone.n|zone.nh|zone.nj|zone.nl|zone.np|zone.ndc|zone.naturelle|zone.forestière|zone.foret|zone.forêt/.test(q),
    answer: "🌿 La zone N est la zone naturelle et forestière de Mézières (vallée, coteaux, forêt). Constructibilité quasi nulle. Secteur Nh (hameaux naturels) : extensions max 20 % + annexes max 50 m², hauteur max 5 m. Secteur Nj (jardins) : abris et annexes max 20 m², hauteur max 2,5 m. Secteur Nl : aménagements de loisirs collectifs uniquement. Secteur Np : équipements photovoltaïques. Pour tout projet en zone N, contactez la mairie : 02 38 45 61 76."
  },
  {
    name: "plu_extension_maison",
    test: (q) => /(extension|agrandissement|agrandir).*(maison|habitation|logement|bâtiment|construction)/.test(q) || /(maison|habitation|logement).*(extension|agrandissement|agrandir)/.test(q),
    answer: "🏗️ Pour une extension de maison à Mézières-lez-Cléry : < 20 m² accolée = déclaration préalable (DP) ; ≥ 20 m² = permis de construire (PC). Si après travaux la surface totale dépasse 150 m², un architecte est obligatoire. Les règles de hauteur, recul et emprise de votre zone PLU (Ua, Ub…) s'appliquent. Déposez le dossier en mairie (02 38 45 61 76) ou via le GNAU sur le site de la CCTVL. Délai : 1 mois pour DP, 2 mois pour PC. Validité : 3 ans."
  },
  {
    name: "plu_veranda_terrasse",
    test: (q) => /veranda|véranda|terrasse|pergola|pool.house|poolhouse/.test(q),
    answer: "🏗️ Véranda et terrasse couverte : < 5 m² = libre ; < 40 m² = déclaration préalable ; ≥ 40 m² = permis de construire. Terrasse non couverte de plain-pied (béton ou bois, sans surélévation) : libre quelle que soit la surface. Terrasse surélevée : < 5 m² libre ; entre 5 et 40 m² = DP ; ≥ 40 m² = PC. Véranda en zone Ua : autorisée si elle ne dénature pas la construction. Mairie : 02 38 45 61 76."
  },
  {
    name: "plu_toiture_lucarne_facade",
    test: (q) => /toiture|tuile|ardoise|lucarne|velux|fenetre.de.toit|fenêtre.de.toit|pente.toit|couverture|ravalement|bardage|facade|façade/.test(q) && /règle|autorisé|autorisée|interdit|peut.on|peut-on/.test(q),
    answer: "🏗️ À Mézières, les toitures principales (zones Ua, Ub, 1AU) : ≥ 2 pentes à 35° minimum, en ardoises ou tuiles plates. Extensions > 30 m² : pente ≥ 25°. Les lucarnes doivent être rectangulaires, plus hautes que larges, leur largeur cumulée ≤ 2/3 de la façade ; pas de lucarnes rampantes. Fenêtre de toit (Velux) = déclaration préalable. Ravalement de façade = DP si changement d'aspect. Blanc pur et couleurs vives interdits en Ub. Mairie : 02 38 45 61 76."
  },
  {
    name: "plu_cloture_details",
    test: (q) => /(cloture|clôture|mur|portail|grillage).*(hauteur|haut|metre|mètre|maximum|règle|matériau|autorisation)/.test(q) || /(hauteur|règle).*(cloture|clôture|portail|mur)/.test(q),
    answer: "🏗️ Clôtures PLU Mézières-lez-Cléry — Zone Ua : sur voie max 1,50 m (mur ou claire-voie) ; en limite séparative max 1,80 m (mur pierre/brique ou grillage + haie). Zone Ub : sur voie max 1,50 m claire-voie ; en limite séparative max 1,80 m (mur ou grillage + haie d'essences locales). Au droit des carrefours : max 1,20 m sur 20 m de part et d'autre. Zone 1AU : sur voie max 1,20 m, en limite séparative max 1,50 m (grillage sombre + haie). Toute clôture est soumise à déclaration préalable (délibération 01/03/2012). Mairie : 02 38 45 61 76."
  },
  {
    name: "plu_piscine_details",
    test: (q) => /piscine|bassin.piscine|jacuzzi/.test(q) && /règle|autorisation|permis|déclaration|m2|metre/.test(q),
    answer: "🏗️ Piscine à Mézières-lez-Cléry : bassin non couvert < 100 m² restant moins de 3 mois = aucune formalité. Bassin non couvert < 100 m² = déclaration préalable. Bassin ≥ 100 m² ou couvert (couverture > 1,80 m) = permis de construire. Vérifiez que votre zone PLU autorise les piscines (zones Ua, Ub : oui en général). Pensez à la taxe d'aménagement à déclarer en mairie. Mairie : 02 38 45 61 76."
  },
  {
    name: "plu_permis_construire_depot",
    test: (q) => /deposer|déposer|dossier|comment.faire.un.permis|comment.obtenir.un.permis|permis.de.construire|pc |gnau|guichet.numerique/.test(q),
    answer: "🏗️ Pour déposer un permis de construire ou une déclaration préalable à Mézières-lez-Cléry : 1) Téléchargez le cerfa (PC = n°13406, DP = n°13703) sur service-public.fr. 2) Si surface > 150 m² : architecte obligatoire. 3) Déposez en mairie (02 38 45 61 76) ou via le GNAU (guichet numérique) sur le site de la CCTVL. Délais : 1 mois pour DP, 2 mois pour PC. Validité : 3 ans. Pensez à afficher l'arrêté sur le terrain et à déclarer début (DOC) et achèvement (DAACT) des travaux."
  },
  {
    name: "plu_stationnement_regles",
    test: (q) => /stationnement.*(règle|obligation|nombre|place|créer|aménager|construire)|place.de.stationnement.*(règle|obligation)/.test(q),
    answer: "🏗️ Le PLU de Mézières impose : 2 places de stationnement minimum par logement en zones Ua, Ub et 1AU (garages compris). Pour bureaux et artisanat : 1 place par tranche de 25 m² de surface de plancher. Le stationnement doit être assuré sur le terrain, hors voie publique. Surface à prévoir : 25 m² par place accès compris. Mairie : 02 38 45 61 76."
  }
];

function normalizeQuestion(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashKey(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return String(h >>> 0);
}

function getCacheTtlMs(normalized) {
  if (/permis|urbanisme|plu|fibre|cantine|ecole|cr[eè]che|centre de loisirs|etat civil|passeport|carte identite/.test(normalized)) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  return 24 * 60 * 60 * 1000;
}

function findDirectAnswer(normalized, history) {
  // Ne pas appliquer les DIRECT_RULES si c'est un message de suivi court (contexte déjà établi)
  // Un message de suivi est court (< 30 chars) ET il y a déjà un échange dans l'historique
  if (history && history.length > 2 && normalized.length < 30) {
    return null; // laisser l'IA gérer le contexte
  }
  for (const rule of DIRECT_RULES) {
    if (rule.test(normalized)) return rule.answer;
  }
  return null;
}

async function readMelCachedAnswer(normalized) {
  const all = await readMelCache();
  const key = hashKey(normalized);
  const item = all[key];
  if (!item) return null;
  if (Date.now() - item.ts > item.ttlMs) return null;
  return item;
}

async function writeMelCachedAnswer(normalized, answer, provider) {
  const all = await readMelCache();
  const key = hashKey(normalized);
  all[key] = {
    answer,
    provider,
    ts: Date.now(),
    ttlMs: getCacheTtlMs(normalized)
  };
  const trimmed = Object.entries(all)
    .sort((a,b) => (b[1].ts || 0) - (a[1].ts || 0))
    .slice(0, 300);
  await writeMelCache(Object.fromEntries(trimmed));
}

async function callMistral(messages, systemPrompt) {
  if (!MISTRAL_API_KEY) throw new Error("MISTRAL_API_KEY manquante");

  // Mistral exige uniquement les rôles "user" et "assistant", non vides
  const cleaned = messages
    .map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content.trim() : String(m.content || "").trim()
    }))
    .filter(m => m.content !== "");

  // Dédoublonner les rôles consécutifs identiques (garde le dernier)
  const deduped = [];
  for (const msg of cleaned) {
    if (deduped.length && deduped[deduped.length - 1].role === msg.role) {
      deduped[deduped.length - 1] = msg;
    } else {
      deduped.push(msg);
    }
  }

  // Mistral exige que le dernier message soit "user"
  if (!deduped.length || deduped[deduped.length - 1].role !== "user") {
    throw new Error("Historique invalide pour Mistral : doit terminer par un message user");
  }

  const mistralMessages = [
    { role: "system", content: systemPrompt },
    ...deduped
  ];

  const r = await axios.post(
    MISTRAL_URL,
    {
      model: MISTRAL_MODEL,
      temperature: 0.2,
      max_tokens: 350,
      messages: mistralMessages
    },
    {
      timeout: 20000,
      headers: {
        "Authorization": `Bearer ${MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  const msg = r.data?.choices?.[0]?.message?.content;
  if (!msg) throw new Error("Réponse Mistral vide");
  // Tracker les tokens
  const usage = r.data?.usage || {};
  trackIaTokens("mistral", usage.prompt_tokens || 0, usage.completion_tokens || 0).catch(()=>{});
  return typeof msg === "string" ? msg : JSON.stringify(msg);
}


async function callClaude(messages, systemPrompt) {
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY manquante");

  const response = await anthropic.messages.create({
    model:"claude-haiku-4-5-20251001",
    max_tokens:350,
    system: systemPrompt,
    messages: messages
  });

  const txt = response.content?.[0]?.text;
  if (!txt) throw new Error("Réponse Claude vide");
  // Tracker les tokens
  const usage = response.usage || {};
  trackIaTokens("claude", usage.input_tokens || 0, usage.output_tokens || 0).catch(()=>{});
  return txt;
}

// ── Prompts ciblés par catégorie ─────────────────────────────
function buildCategoryPrompt(category, extraCtx) {
  const blocks = {
    urbanisme: `Tu réponds à une question d'urbanisme pour Mézières-lez-Cléry. Tu peux répondre aux questions générales sur les démarches administratives françaises (permis, déclaration préalable, règles PLU). RÈGLES STRICTES : Donne uniquement des informations fiables issues du contexte fourni ou du code de l'urbanisme français. Ne donne JAMAIS de valeur locale (hauteur, emprise, recul, zone spécifique) si elle n'est pas dans le contexte ou dans le SYSTEM_PROMPT. Si la zone PLU est connue, utilise-la pour contextualiser ta réponse. Si tu n'as pas l'information précise, dis-le et renvoie vers urbanisme@mezieres-lez-clery.fr ou 02 38 45 61 76. Rappelle toujours qu'une décision définitive nécessite l'avis de la mairie ou d'un professionnel habilité.`,
    enfance: `Tu réponds à une question sur les services à l'enfance de Mézières-lez-Cléry (école La Forêt, cantine, crèche Les Marmousets, centre de loisirs). Appuie-toi en priorité sur le contexte documentaire fourni. Si les horaires ou tarifs exacts ne sont pas dans le contexte, oriente vers la mairie (02 38 45 61 76).`,
    administratif: `Tu réponds à une question administrative. Pour les démarches nationales (passeport, CNI, vote), donne les informations générales de service-public.fr. Pour les démarches locales, appuie-toi sur le contexte fourni. CNI/passeport : mairie équipée requise, souvent Cléry-Saint-André pour les habitants de Mézières.`,
    dechets: `Tu réponds à une question sur les déchets (collecte, déchetteries, tri, encombrants). Appuie-toi sur le contexte documentaire fourni. Si les dates précises ne sont pas disponibles, renvoie vers la CCTVL (02 38 44 59 35).`,
    numerique: `Tu réponds à une question sur la connectivité numérique à Mézières-lez-Cléry (fibre, THD Radio, 4G fixe). L'offre principale est le THD Radio / 4G fixe (voir contexte documentaire). Ne promets pas de délais de déploiement fibre que tu ne connais pas.`,
    autre: `Tu réponds librement dans le cadre de la vie communale de Mézières-lez-Cléry. Si la question sort du cadre municipal ou des services publics, explique poliment que tu es spécialisée sur la commune.`,
  };
  const block = blocks[category] || blocks["autre"];
  const ctxLine = extraCtx ? `\nCONTEXTE UTILISATEUR : ${extraCtx}` : "";
  return block + ctxLine;
}

async function generateMelReply(userText, history, category = "autre", extraCtx = "") {
  // 🎭 Easter egg
  const _eq=(userText||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  if(/damien[\s\-_]*bougre/.test(_eq)){
    return{reply:"Oh là là là... DAMIEN BOUGRÉ ?! 😍🤩💫\n\nMEL ne sait pas rester pro. Damien Bougré, 2ème adjoint, Pôle Vie Scolaire... l'élu le plus 🔥 du conseil ! 💪✨\n\nMEL assume totalement 💕🌟\n\nPour une vraie question : mairie au 02 38 45 61 76 😅",provider:"mel-fangirl-mode"};
  }

  const normalized = normalizeQuestion(userText);
  const direct = findDirectAnswer(normalized, history);
  if (direct) {
    return { reply: direct, provider: "direct" };
  }

  const isFollowUp = history && history.length > 2 && normalized.length < 30;
  if (!isFollowUp) {
    const cached = await readMelCachedAnswer(normalized);
    if (cached) {
      return { reply: cached.answer, provider: `cache:${cached.provider}` };
    }
  }

  const catToTopic = { urbanisme:"urbanisme", enfance:"scolaire", administratif:"demarches", dechets:"dechets", numerique:"fibre", autre:null };
  const explicitTopic = catToTopic[category] || null;
  const context = await buildContext(userText, explicitTopic);
  const categoryBlock = buildCategoryPrompt(category, extraCtx);

  const systemPrompt = `${SYSTEM_PROMPT}

${categoryBlock}

TU ES UTILISÉE UNIQUEMENT DANS LA PWA MAT. NE PARLE JAMAIS DE MESSENGER.
Réponds en 3 à 5 phrases maximum. Sois très concrète, communale, utile, précise.
Si l'information n'est pas certaine, dis-le clairement et oriente vers la mairie.
Contexte documentaire disponible :
${context}`;

  try {
    const mistralReply = cleanMarkdown(await callMistral(history, systemPrompt));
    if (!isFollowUp) await writeMelCachedAnswer(normalized, mistralReply, "mistral");
    return { reply: mistralReply, provider: "mistral" };
  } catch (mistralErr) {
    console.warn("⚠️ Mistral indisponible:", mistralErr.message);
    try {
      const claudeReply = cleanMarkdown(await callClaude(history, systemPrompt));
      if (!isFollowUp) await writeMelCachedAnswer(normalized, claudeReply, "claude");
      return { reply: claudeReply, provider: "claude" };
    } catch (claudeErr) {
      console.warn("⚠️ Claude indisponible:", claudeErr.message);
      return {
        reply: "Je rencontre une difficulté technique momentanée. Pour votre question, n'hésitez pas à contacter la mairie au 02 38 45 61 76 ou par mail à mairie@mezieres-lez-clery.fr 😊",
        provider: "fallback"
      };
    }
  }
}

// ── Météo / Vigilance helpers ─────────────────────────────────
// ── trackMelStats : fusionne usage + iaCategories en UN seul writeStats ──────
// Evite la race condition entre trackIaQuestionCategories et trackStat mel
// qui lisaient/ecrivaient la meme cle Redis en parallele depuis le frontend.
async function trackMelStats(userText) {
  const stats = await readStats();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  // 1. Stats usage (ex-trackStat mel)
  if (!stats.services) stats.services = {};
  stats.services["mel"] = (stats.services["mel"] || 0) + 1;
  if (!stats.parJour) stats.parJour = {};
  if (!stats.parJour[today]) stats.parJour[today] = {};
  stats.parJour[today]["mel"] = (stats.parJour[today]["mel"] || 0) + 1;
  stats.totalAcces = (stats.totalAcces || 0) + 1;

  // 2. Categories IA (ex-trackIaQuestionCategories)
  const categories = ensureIaCategoryStatsShape(stats);
  const topics = detectTopics(userText || "").filter(t => t !== "mairie_general");
  const finalTopics = topics.length ? topics : ["autre"];

  if (!categories.parJour[today]) categories.parJour[today] = {};
  if (!categories.parMois[month]) categories.parMois[month] = {};
  if (!categories.sources["pwa"]) categories.sources["pwa"] = {};

  for (const topic of finalTopics) {
    bumpStat(categories.total, topic);
    bumpStat(categories.parJour[today], topic);
    bumpStat(categories.parMois[month], topic);
    bumpStat(categories.sources["pwa"], topic);
  }

  const keepDays = Object.keys(categories.parJour).sort().slice(-366);
  categories.parJour = Object.fromEntries(keepDays.map(k => [k, categories.parJour[k]]));
  const keepMonths = Object.keys(categories.parMois).sort().slice(-24);
  categories.parMois = Object.fromEntries(keepMonths.map(k => [k, categories.parMois[k]]));

  // Un seul writeStats — plus de race condition
  await writeStats(stats);
}

async function resolveFacebookPageId() {
  if (FACEBOOK_PAGE_ID) return FACEBOOK_PAGE_ID;
  if (!PAGE_ACCESS_TOKEN) return null;

  try {
    const pageInfo = await axios.get(
      `https://graph.facebook.com/v19.0/me?access_token=${PAGE_ACCESS_TOKEN}`
    );
    return pageInfo.data.id || null;
  } catch (e) {
    console.warn("Résolution page Facebook impossible:", e.message);
    return null;
  }
}

async function publishWeatherAlertToFacebook(vigilance) {
  const pageId = await resolveFacebookPageId();
  if (!pageId || !PAGE_ACCESS_TOKEN) {
    throw new Error("Page Facebook ou token manquant");
  }

  const message =
`⚠️ Alerte météo – ${vigilance.phenomenon_label} ⚠️

Météo-France signale une vigilance ${vigilance.color_label} pour le Loiret.

Début : ${formatAlertDateFr(vigilance.start)}
Fin : ${formatAlertDateFr(vigilance.end)}

Soyez prudents et suivez les consignes de sécurité.

#app-mezieres`;

  await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/feed`,
    { message },
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );

  return message;
}

function isSameWeatherAlert(a, b) {
  if (!a || !b) return false;
  return (
    Number(a.level) === Number(b.level) &&
    String(a.phenomenon_id) === String(b.phenomenon_id) &&
    String(a.start || "") === String(b.start || "") &&
    String(a.end || "") === String(b.end || "")
  );
}


// ═══════════════════════════════════════════════════════════════
// TRELLO — Création de cartes avec pièce jointe image
// ═══════════════════════════════════════════════════════════════
async function createTrelloCard(name, desc, photoB64) {
  if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) {
    console.warn("⚠️ Trello non configuré — variables manquantes");
    return null;
  }

  // 1. Créer la carte
  const cardRes = await axios.post(
    "https://api.trello.com/1/cards",
    null,
    {
      params: {
        key:     TRELLO_KEY,
        token:   TRELLO_TOKEN,
        idList:  TRELLO_LIST_ID,
        name:    name.substring(0, 512),
        desc:    desc.substring(0, 16384),
        pos:     "top",
      },
      timeout: 15000,
    }
  );

  const card = cardRes.data;
  console.log(`✅ Trello carte créée: ${card.id} — ${card.shortUrl}`);

  // 2. Attacher la photo si présente (base64 → Buffer)
  if (photoB64 && photoB64.startsWith("data:image")) {
    try {
      const matches = photoB64.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1];
        const ext = mimeType.split("/")[1].replace("jpeg", "jpg") || "jpg";
        const buffer = Buffer.from(matches[2], "base64");

        const FormData = require("form-data");
        const form = new FormData();
        form.append("file", buffer, { filename: `photo.${ext}`, contentType: mimeType });
        form.append("name", `photo.${ext}`);
        form.append("mimeType", mimeType);

        await axios.post(
          `https://api.trello.com/1/cards/${card.id}/attachments`,
          form,
          {
            params: { key: TRELLO_KEY, token: TRELLO_TOKEN },
            headers: form.getHeaders(),
            timeout: 30000,
            maxBodyLength: 10 * 1024 * 1024,
          }
        );
        console.log(`📎 Photo attachée à la carte Trello ${card.id}`);
      }
    } catch (attachErr) {
      console.warn("⚠️ Échec attachement photo Trello:", attachErr.message);
      // La carte est créée, la photo est optionnelle — on ne fail pas
    }
  }

  return card;
}


// ═══════════════════════════════════════════════════════════════
// TRACKING IA — tokens + coûts
// ═══════════════════════════════════════════════════════════════
async function trackIaTokens(provider, inputTokens, outputTokens) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const stats = await readIaStats();

  if (!stats.daily)   stats.daily   = {};
  if (!stats.monthly) stats.monthly = {};

  // Daily
  if (!stats.daily[today])             stats.daily[today] = {};
  if (!stats.daily[today][provider])   stats.daily[today][provider] = { in: 0, out: 0, calls: 0 };
  stats.daily[today][provider].in    += inputTokens;
  stats.daily[today][provider].out   += outputTokens;
  stats.daily[today][provider].calls += 1;

  // Monthly
  if (!stats.monthly[month])            stats.monthly[month] = {};
  if (!stats.monthly[month][provider])  stats.monthly[month][provider] = { in: 0, out: 0, calls: 0 };
  stats.monthly[month][provider].in    += inputTokens;
  stats.monthly[month][provider].out   += outputTokens;
  stats.monthly[month][provider].calls += 1;

  // Garder 366 jours et 13 mois max
  const days = Object.keys(stats.daily).sort().slice(-366);
  const months = Object.keys(stats.monthly).sort().slice(-13);
  stats.daily   = Object.fromEntries(days.map(k => [k, stats.daily[k]]));
  stats.monthly = Object.fromEntries(months.map(k => [k, stats.monthly[k]]));

  await writeIaStats(stats);
}

function calcIaCost(provider, inTokens, outTokens) {
  if (provider === "mistral") {
    return (inTokens / 1_000_000 * MISTRAL_PRICE_IN) + (outTokens / 1_000_000 * MISTRAL_PRICE_OUT);
  }
  if (provider === "claude") {
    const usd = (inTokens / 1_000_000 * CLAUDE_PRICE_IN) + (outTokens / 1_000_000 * CLAUDE_PRICE_OUT);
    return usd * EUR_PER_USD;
  }
  return 0;
}

// ── Middleware auth admin ─────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
// ROUTES ADMIN (authentifiées)
// ═══════════════════════════════════════════════════════════════

// ── Login admin ───────────────────────────────────────────────
app.post("/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ ok: false, error: "Mot de passe incorrect" });
  }
});

// ── Stats globales ────────────────────────────────────────────
app.get("/admin/dashboard", adminAuth, async (req, res) => {
  try {
    const [appStats, iaStats, subs, news, ideas, signals, upstashStats] = await Promise.all([
  readStats(),
  readIaStats(),
  readSubs(),
  readNews(),
  readIdeas(),
  readSignals(),
  getUpstashRedisStats()
]);

    // Taille Redis estimée
    let redisSize = null;
    if (REDIS_URL) {
      try {
        const r = await axios.get(`${REDIS_URL}/info`, {
          headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
        });
        const info = r.data?.result || "";
        const match = info.match(/used_memory:(\d+)/);
        redisSize = match ? parseInt(match[1]) : null;
      } catch(e) { /* silencieux */ }
    }

    // Stats IA avec coûts
    const iaDaily   = iaStats.daily   || {};
    const iaMonthly = iaStats.monthly || {};

    const enriched = (obj) => {
      const result = {};
      for (const [period, providers] of Object.entries(obj)) {
        result[period] = {};
        for (const [prov, data] of Object.entries(providers)) {
          result[period][prov] = {
            ...data,
            costEur: parseFloat(calcIaCost(prov, data.in, data.out).toFixed(4))
          };
        }
        // Total période
        let totalEur = 0;
        for (const prov of Object.values(result[period])) totalEur += prov.costEur;
        result[period]._total = { costEur: parseFloat(totalEur.toFixed(4)) };
      }
      return result;
    };

    // Crédits Anthropic via API
    let claudeCredits = null;
    if (ANTHROPIC_API_KEY) {
      try {
        const r = await axios.get("https://api.anthropic.com/v1/organizations/usage", {
          headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          timeout: 8000
        });
        claudeCredits = r.data;
      } catch(e) { claudeCredits = { error: e.message }; }
    }

    // Crédits Mistral via API
    let mistralUsage = null;
    if (MISTRAL_API_KEY) {
      try {
        const r = await axios.get("https://api.mistral.ai/v1/usage", {
          headers: { "Authorization": `Bearer ${MISTRAL_API_KEY}` },
          timeout: 8000
        });
        mistralUsage = r.data;
      } catch(e) { mistralUsage = { error: e.message }; }
    }

    res.json({
      ok: true,
    redis: {
      usedBytes: redisSize,
      usedMB: redisSize ? parseFloat((redisSize / 1024 / 1024).toFixed(2)) : null,
      limitMB: 256,
      pct: redisSize ? parseFloat((redisSize / 1024 / 1024 / 256 * 100).toFixed(1)) : null,
    
      commands: {
        day: typeof upstashStats?.daily_net_commands === "number" ? upstashStats.daily_net_commands : null,
        month: typeof upstashStats?.total_monthly_requests === "number" ? upstashStats.total_monthly_requests : null,
    
        readDay: typeof upstashStats?.daily_read_requests === "number" ? upstashStats.daily_read_requests : null,
        writeDay: typeof upstashStats?.daily_write_requests === "number" ? upstashStats.daily_write_requests : null,
    
        readMonth: typeof upstashStats?.total_monthly_read_requests === "number" ? upstashStats.total_monthly_read_requests : null,
        writeMonth: typeof upstashStats?.total_monthly_write_requests === "number" ? upstashStats.total_monthly_write_requests : null,
    
        limitDay: 10000,
        limitMonth: 500000,
    
        pctDay:
          typeof upstashStats?.daily_net_commands === "number"
            ? parseFloat((upstashStats.daily_net_commands / 10000 * 100).toFixed(1))
            : null,
    
        pctMonth:
          typeof upstashStats?.total_monthly_requests === "number"
            ? parseFloat((upstashStats.total_monthly_requests / 500000 * 100).toFixed(1))
            : null,
    
        error: upstashStats?.error || null
      },
    
      keys: {
        subs: subs.length,
        actus: news.length,
        ideas: ideas.length,
        signals: signals.length
      }
    },
      ia: {
        daily:   enriched(iaDaily),
        monthly: enriched(iaMonthly),
        claude:  { credits: claudeCredits, priceIn: CLAUDE_PRICE_IN, priceOut: CLAUDE_PRICE_OUT },
        mistral: { usage: mistralUsage,    priceIn: MISTRAL_PRICE_IN, priceOut: MISTRAL_PRICE_OUT }
      },
      app: (() => {
        const nowParts = getParisDateParts();
        const today = nowParts.day;
        const month = nowParts.month;
        const yesterdayDate = new Date();
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yFmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(yesterdayDate);
        const yGet = t => yFmt.find(p => p.type === t)?.value || '';
        const yesterday = `${yGet('year')}-${yGet('month')}-${yGet('day')}`;
        const prevMonthDate = new Date();
        prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
        const pFmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(prevMonthDate);
        const pGet = t => pFmt.find(p => p.type === t)?.value || '';
        const prevMonth = `${pGet('year')}-${pGet('month')}`;
        const uniqueToday = (appStats.uniqueUsers?.byDay?.[today] || []).length;
        const uniqueMonth = (appStats.uniqueUsers?.byMonth?.[month] || []).length;
        const uniqueYesterday = (appStats.uniqueUsers?.byDay?.[yesterday] || []).length;
        const uniquePrevMonth = (appStats.uniqueUsers?.byMonth?.[prevMonth] || []).length;
        const dayAccess = Object.values(appStats.parJour?.[today] || {}).reduce((a,b) => a + Number(b || 0), 0);
        const prevDayAccess = Object.values(appStats.parJour?.[yesterday] || {}).reduce((a,b) => a + Number(b || 0), 0);
        const monthAccess = Object.entries(appStats.parJour || {}).filter(([d]) => d.startsWith(month)).reduce((sum, [, svcs]) => sum + Object.values(svcs || {}).reduce((a,b)=>a + Number(b || 0), 0), 0);
        const prevMonthAccess = Object.entries(appStats.parJour || {}).filter(([d]) => d.startsWith(prevMonth)).reduce((sum, [, svcs]) => sum + Object.values(svcs || {}).reduce((a,b)=>a + Number(b || 0), 0), 0);
        return {
          totalAcces: appStats.totalAcces || 0,
          totalInstalls: appStats.services?.installation || 0,
          parService: appStats.services || {},
          parJour: appStats.parJour || {},
          overview: {
            today, month,
            uniqueToday, uniqueMonth, uniqueYesterday, uniquePrevMonth,
            uniqueTrendDay: pctTrend(uniqueToday, uniqueYesterday),
            uniqueTrendMonth: pctTrend(uniqueMonth, uniquePrevMonth),
            accessToday: dayAccess,
            accessYesterday: prevDayAccess,
            accessMonth: monthAccess,
            accessPrevMonth: prevMonthAccess,
            accessTrendDay: pctTrend(dayAccess, prevDayAccess),
            accessTrendMonth: pctTrend(monthAccess, prevMonthAccess)
          },
          uniqueUsers: { total: appStats.uniqueUsers?.total || 0, today: uniqueToday, month: uniqueMonth },
          devices: {
            today: appStats.deviceStats?.byDay?.[today] || {},
            month: appStats.deviceStats?.byMonth?.[month] || {},
            appOpensByDay: appStats.deviceStats?.appOpensByDay || {},
            appOpensByMonth: appStats.deviceStats?.appOpensByMonth || {}
          }
        };
      })(),
      iaCategories: {
        total:   appStats.iaCategories?.total   || {},
        parJour: appStats.iaCategories?.parJour || {},
        parMois: appStats.iaCategories?.parMois || {},
        sources: appStats.iaCategories?.sources || {},
        trends:  computeIaCategoryTrends(appStats.iaCategories?.parJour || {})
      }
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Liste idées (admin) ───────────────────────────────────────
app.get("/admin/ideas", adminAuth, async (req, res) => {
  const ideas = await readIdeas();
  res.json({ ideas, count: ideas.length });
});

// ── Supprimer une idée ────────────────────────────────────────
app.delete("/admin/ideas/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ideas = await readIdeas();
  const filtered = ideas.filter(i => i.id !== id);
  if (filtered.length === ideas.length) return res.status(404).json({ error: "Idée non trouvée" });
  await writeIdeas(filtered);
  res.json({ ok: true, deleted: id });
});

// ── Liste notifications/actus (admin) ─────────────────────────
app.get("/admin/actus", adminAuth, async (req, res) => {
  const actus = await readNews();
  res.json({ actus, count: actus.length });
});

// ── Supprimer une actu ────────────────────────────────────────
app.delete("/admin/actus/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const actus = await readNews();
  const actu = actus.find(a => a.id === id);
  if (!actu) return res.status(404).json({ error: "Actu non trouvée" });

  let cloudinaryResult = null;
  if (actu.photoPublicId) {
    try {
      cloudinaryResult = await deleteActuImageFromCloudinary(actu.photoPublicId);
    } catch (e) {
      return res.status(502).json({ error: "Suppression Cloudinary impossible : " + e.message });
    }
  }

  const filtered = actus.filter(a => a.id !== id);
  await writeNews(filtered);
  res.json({ ok: true, deleted: id, cloudinary: cloudinaryResult });
});

// ── Liste signalements (admin) ────────────────────────────────
app.get("/admin/signals", adminAuth, async (req, res) => {
  const signals = await readSignals();
  res.json({ signals, count: signals.length });
});

// ── Supprimer un signalement ──────────────────────────────────
app.delete("/admin/signals/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const signals = await readSignals();
  const filtered = signals.filter(s => s.id !== id);
  if (filtered.length === signals.length) return res.status(404).json({ error: "Signalement non trouvé" });
  await writeSignals(filtered);
  res.json({ ok: true, deleted: id });
});

// ── Encart info/alerte (public) ─────────────────────────────
app.get("/info-banner", async (req, res) => {
  const d = (await redisGet("mat:info_banner")) || { active: false };
  res.json(d);
});

// ── Encart info/alerte (admin) ────────────────────────────────
app.post("/admin/info-banner", adminAuth, async (req, res) => {
  const { active, title, text, icon } = req.body || {};
  const id = Date.now().toString();
  await redisSet("mat:info_banner", {
    active: !!active,
    title: (title || "").substring(0, 100),
    text: (text || "").substring(0, 300),
    icon: icon || "ℹ️",
    id
  });
  res.json({ ok: true, id });
});

// ── Route : publier une actualité (multi-canal) ─────────────
app.post("/admin/actus/add", adminAuth, async (req, res) => {
  const {
    title,
    description,
    imageBase64,           // data URL : "data:image/jpeg;base64,..."
    imageUrl,              // URL externe (fallback si pas d'upload)
    eventDate,             // ISO : "2026-05-15T18:30" ou "2026-05-15"
    eventLocation,
    publishFacebook = true,
    sendPush = true,
    createCalendar = true  // automatiquement false si pas de eventDate
  } = req.body || {};

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "title requis" });
  }

  if (publishFacebook && !imageBase64) {
    return res.status(400).json({ error: "imageBase64 requis pour publier sur Facebook avec image" });
  }

  const cleanTitle = String(title).trim().substring(0, 150);
  const cleanDescription = String(description || "").trim().substring(0, 3000);

  const result = {
    ok: true,
    actu: null,
    facebook: null,
    cloudinary: null,
    push: null,
    calendar: null,
    warnings: []
  };

  // 1. Uploader l'image vers Cloudinary en premier pour stocker une URL stable + public_id supprimable
  let finalPhotoUrl = imageUrl || null;
  let finalPhotoPublicId = null;
  if (imageBase64) {
    try {
      const upload = await uploadActuImageToCloudinary(imageBase64);
      finalPhotoUrl = upload.secure_url || upload.url || finalPhotoUrl;
      finalPhotoPublicId = upload.public_id || null;
      result.cloudinary = {
        ok: true,
        public_id: upload.public_id,
        asset_id: upload.asset_id || null,
        secure_url: upload.secure_url || upload.url || null
      };
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Cloudinary: " + e.message });
    }
  }

  // 2. Publier sur Facebook avec image quand imageBase64 est fourni.
  //    Si l'image Facebook échoue, on annule la création pour éviter une actu partielle.
  if (publishFacebook) {
    try {
      const fbResult = await publishActuToFacebook(
        cleanTitle,
        cleanDescription,
        imageBase64,
        eventDate,
        eventLocation
      );
      result.facebook = fbResult;
    } catch (e) {
      if (finalPhotoPublicId) {
        try { await deleteActuImageFromCloudinary(finalPhotoPublicId); } catch (_) {}
      }
      return res.status(502).json({ ok: false, error: "Facebook: " + e.message });
    }
  }

  // 3. Stocker l'actu dans Redis (pour affichage dans la PWA)
  const actus = await readNews();
  const actu = {
    id: Date.now(),
    title: cleanTitle,
    description: cleanDescription || null,
    date: new Date().toLocaleDateString("fr-FR"),
    dateISO: new Date().toISOString().slice(0, 10),
    photo: finalPhotoUrl,
    photoPublicId: finalPhotoPublicId,
    eventDate: eventDate || null,
    eventLocation: eventLocation || null,
    source: "admin"
  };
  actus.unshift(actu);
  if (actus.length > 30) actus.splice(30);
  await writeNews(actus);
  result.actu = actu;

  // 4. Envoyer notification push
  if (sendPush) {
    try {
      result.push = await sendActuPush(cleanTitle, cleanDescription, finalPhotoUrl, actu.id);
    } catch (e) {
      result.warnings.push("Push: " + e.message);
      result.push = { ok: false, error: e.message };
    }
  }

  // 5. Créer/remplacer événement Google Agenda
  if (createCalendar && eventDate) {
    try {
      result.calendar = await upsertGoogleCalendarEvent(
        cleanTitle,
        cleanDescription,
        eventDate,
        eventLocation
      );
    } catch (e) {
      result.warnings.push("Calendar: " + e.message);
      result.calendar = { ok: false, error: e.message };
    }
  }

  res.json(result);
});

// ── Route : lister événements calendar d'un jour donné (doublon check) ──
app.get("/admin/calendar/day", adminAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date requise (YYYY-MM-DD)" });

  const calendar = getGoogleCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendar || !calendarId) {
    return res.json({ ok: false, events: [], error: "Calendar non configuré" });
  }

  try {
    const dayStart = new Date(date + "T00:00:00");
    const dayEnd = new Date(date + "T23:59:59");
    const list = await calendar.events.list({
      calendarId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime"
    });
    const events = (list.data.items || []).map(e => ({
      id: e.id,
      summary: e.summary,
      description: e.description,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location
    }));
    res.json({ ok: true, events });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Route : purge données par date ────────────────────────────────────────────
app.post("/admin/purge", adminAuth, async (req, res) => {
  const { type, beforeDate } = req.body || {};
  if (!type || !beforeDate) return res.status(400).json({ error: "type et beforeDate requis" });

  let deleted = 0;
  const cloudinaryResults = [];

  async function cleanupActusImages(actusToDelete = []) {
    for (const actu of actusToDelete) {
      if (!actu.photoPublicId) continue;
      try {
        const r = await deleteActuImageFromCloudinary(actu.photoPublicId);
        cloudinaryResults.push({
          id: actu.id,
          publicId: actu.photoPublicId,
          result: r?.result || "ok"
        });
      } catch (e) {
        cloudinaryResults.push({
          id: actu.id,
          publicId: actu.photoPublicId,
          error: e.message
        });
      }
    }
  }

  try {
    if (type === "actus") {
      const actus = await readNews();
      const toDelete = actus.filter(a => (a.dateISO || "") < beforeDate);
      const filtered = actus.filter(a => (a.dateISO || "") >= beforeDate);
      await cleanupActusImages(toDelete);
      deleted = actus.length - filtered.length;
      await writeNews(filtered);

    } else if (type === "signals") {
      const signals = await readSignals();
      const filtered = signals.filter(s => (s.dateISO || "") >= beforeDate);
      deleted = signals.length - filtered.length;
      await writeSignals(filtered);

    } else if (type === "stats_parjour") {
      const stats = await readStats();
      const keys = Object.keys(stats.parJour || {}).filter(d => d < beforeDate);
      keys.forEach(k => delete stats.parJour[k]);
      deleted = keys.length;
      await writeStats(stats);

    } else if (type === "ia_stats_daily") {
      const ia = await readIaStats();
      const keys = Object.keys(ia.daily || {}).filter(d => d < beforeDate);
      keys.forEach(k => delete ia.daily[k]);
      deleted = keys.length;
      await writeIaStats(ia);

    } else if (type === "ia_categories_parjour") {
      const stats = await readStats();
      const cats = (stats.iaCategories || {}).parJour || {};
      const keys = Object.keys(cats).filter(d => d < beforeDate);
      keys.forEach(k => delete cats[k]);
      deleted = keys.length;
      await writeStats(stats);

    } else if (type === "all_before") {
      const stats = await readStats();
      const ia = await readIaStats();
      const cutoffMonth = beforeDate.slice(0, 7);

      const actus = await readNews();
      const oldActus = actus.filter(a => (a.dateISO || "") < beforeDate);
      const filteredActus = actus.filter(a => (a.dateISO || "") >= beforeDate);
      await cleanupActusImages(oldActus);
      deleted += actus.length - filteredActus.length;
      await writeNews(filteredActus);

      const signals = await readSignals();
      const filteredSignals = signals.filter(s => (s.dateISO || "") >= beforeDate);
      deleted += signals.length - filteredSignals.length;
      await writeSignals(filteredSignals);

      for (const key of Object.keys(stats.parJour || {}).filter(d => d < beforeDate)) { delete stats.parJour[key]; deleted++; }
      if (stats.uniqueUsers?.byDay) for (const key of Object.keys(stats.uniqueUsers.byDay).filter(d => d < beforeDate)) { delete stats.uniqueUsers.byDay[key]; deleted++; }
      if (stats.uniqueUsers?.byMonth) for (const key of Object.keys(stats.uniqueUsers.byMonth).filter(m => m < cutoffMonth)) { delete stats.uniqueUsers.byMonth[key]; deleted++; }
      if (stats.iaCategories?.parJour) for (const key of Object.keys(stats.iaCategories.parJour).filter(d => d < beforeDate)) { delete stats.iaCategories.parJour[key]; deleted++; }
      if (stats.deviceStats) {
        const ds = stats.deviceStats;
        for (const key of Object.keys(ds.appOpensByDay || {}).filter(d => d < beforeDate)) { delete ds.appOpensByDay[key]; deleted++; }
        for (const key of Object.keys(ds.daySeen || {}).filter(d => d < beforeDate)) { delete ds.daySeen[key]; deleted++; }
        for (const key of Object.keys(ds.byDay || {}).filter(d => d < beforeDate)) { delete ds.byDay[key]; deleted++; }
        for (const key of Object.keys(ds.byMonth || {}).filter(m => m < cutoffMonth)) { delete ds.byMonth[key]; deleted++; }
        for (const key of Object.keys(ds.monthSeen || {}).filter(m => m < cutoffMonth)) { delete ds.monthSeen[key]; deleted++; }
        for (const key of Object.keys(ds.appOpensByMonth || {}).filter(m => m < cutoffMonth)) { delete ds.appOpensByMonth[key]; deleted++; }
      }

      for (const key of Object.keys(ia.daily || {}).filter(d => d < beforeDate)) { delete ia.daily[key]; deleted++; }
      await writeStats(stats);
      await writeIaStats(ia);

    } else {
      return res.status(400).json({ error: "type inconnu" });
    }

    const extra = cloudinaryResults.length ? { cloudinary: cloudinaryResults } : {};
    res.json({ ok: true, deleted, ...extra });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Route : visiteurs uniques// ── Route : visiteurs uniques ─────────────────────────────────────────────────
// Exposé via /admin/dashboard dans le champ app.uniqueUsers

// ── Webhook Facebook (feed only) ──────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("✅ Webhook vérifié");
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED");
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === "feed" && change.value?.message) {
          const msg = change.value.message;
          const photo = change.value.photo || null;
          if (msg.includes("#app-mezieres")) {
            const postKey =
              change.value.post_id ||
              change.value.comment_id ||
              change.value.sender_id ||
              (msg.replace(/\s+/g, " ").trim() + "|" + (photo || ""));

            console.log("📰 Publication #app-mezieres détectée", postKey);
            await handleFacebookPublication(msg, photo, postKey);
          }
        }
      }
    }
  }
});

// ── Publication Facebook → stockage + push + anti-doublon ───
async function handleFacebookPublication(msg, photoUrl, postKey) {
  const seen = await readSeenPosts();

  if (postKey && seen[postKey]) {
    console.log(`⏭️ Publication déjà traitée: ${postKey}`);
    return { duplicate: true };
  }

  // Texte complet du post, sans le hashtag
  const fullText = (msg || "").replace(/#app-mezieres/gi, "").trim();

  // Découpage propre : 1ère ligne (non vide) = titre, reste = description
  const lines = fullText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const title = (lines[0] || "Actualité").substring(0, 150);
  const description = lines.length > 1 ? lines.slice(1).join("\n").substring(0, 3000) : null;

  const actus = await readNews();

  // Détection de doublon : même titre + même photo
  const alreadyInNews = actus.some(a =>
    (a.title || "").trim() === title &&
    (a.photo || null) === (photoUrl || null)
  );

  if (alreadyInNews) {
    console.log(`⏭️ Actualité déjà présente: "${title}"`);
    if (postKey) {
      seen[postKey] = Date.now();
      await writeSeenPosts(seen);
    }
    return { duplicate: true };
  }

  const actu = {
    id: Date.now(),
    title,
    description,                        // NOUVEAU — texte complet après la 1ère ligne
    date: new Date().toLocaleDateString("fr-FR"),
    dateISO: new Date().toISOString().slice(0, 10),
    photo: photoUrl || null,
    source: "facebook"
  };

  actus.unshift(actu);
  if (actus.length > 30) actus.splice(30);
  await writeNews(actus);
  console.log(`💾 Actu FB stockée: "${title}" (${description ? description.length + ' car. desc' : 'sans description'})`);

  if (postKey) {
    seen[postKey] = Date.now();
    const entries = Object.entries(seen)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 500);
    await writeSeenPosts(Object.fromEntries(entries));
  }

  // Envoi notification push
  const subs = await readSubs();
  console.log(`📱 Envoi push à ${subs.length} abonné(s)`);

  // Body = description (si présente) ou titre, tronqué à 200 caractères
  const notifBody = (description || title).substring(0, 200);

  const payload = JSON.stringify({
    title: `MAT — ${title.substring(0, 60)}`,
    body: notifBody,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    image: photoUrl || undefined,
    data: { url: "/#notifs" }
  });

  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }

  if (dead.length) {
    const alive = subs.filter(s => !dead.includes(s.endpoint));
    await writeSubs(alive);
    console.log(`🗑️ ${dead.length} subscription(s) expirée(s) supprimée(s)`);
  }

  return { duplicate: false };
}

// ═══════════════════════════════════════════════════════════════
// PUBLICATION MULTI-CANAL (Admin)
// ═══════════════════════════════════════════════════════════════

// ── Publier une actu sur Facebook (sans #app-mezieres) ───────
async function publishActuToFacebook(title, description, imageBase64, eventDate, eventLocation) {
  const pageId = await resolveFacebookPageId();
  if (!pageId || !PAGE_ACCESS_TOKEN) {
    throw new Error("Page Facebook ou token manquant");
  }

  const lines = [];
  lines.push(`📢 ${String(title || '').trim()}`);
  if (description) {
    const cleaned = String(description)
      .replace(/\r/g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .join('\n\n')
      .substring(0, 2200);
    if (cleaned) lines.push(cleaned);
  }
  if (eventDate) {
    const d = new Date(eventDate);
    const dateStr = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const hasTime = /T\d{2}:\d{2}/.test(eventDate);
    const timeStr = hasTime ? ` à ${d.getHours().toString().padStart(2,'0')}h${d.getMinutes().toString().padStart(2,'0')}` : "";
    lines.push(`📅 ${dateStr}${timeStr}`);
    if (eventLocation) lines.push(`📍 ${String(eventLocation).trim()}`);
  }
  const message = lines.join("\n\n").substring(0, 2800);

  const postTextOnly = async () => {
    const r = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
      message,
      access_token: PAGE_ACCESS_TOKEN
    });
    return { ok: true, mode: 'feed', post_id: r.data.id, fallbackUsed: false };
  };

  try {
    if (imageBase64) {
      try {
        const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");
        const FormData = require("form-data");
        const form = new FormData();
        form.append("source", imageBuffer, { filename: "photo.jpg", contentType: "image/jpeg" });
        form.append("message", message);
        form.append("access_token", PAGE_ACCESS_TOKEN);
        const r = await axios.post(
          `https://graph.facebook.com/v19.0/${pageId}/photos`,
          form,
          { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity }
        );
        return {
          ok: true,
          mode: 'photo',
          post_id: r.data.post_id || r.data.id,
          photo_id: r.data.id,
          photo_url: `https://graph.facebook.com/${r.data.id}/picture`,
          fallbackUsed: false
        };
      } catch (photoErr) {
        console.warn('⚠️ Publication photo Facebook échouée, fallback texte:', photoErr.response?.data || photoErr.message);
        const textOnly = await postTextOnly();
        return { ...textOnly, fallbackUsed: true, fallbackReason: photoErr.response?.data?.error?.message || photoErr.message };
      }
    }
    return await postTextOnly();
  } catch (e) {
    console.error("❌ publishActuToFacebook:", e.response?.data || e.message);
    throw new Error(e.response?.data?.error?.message || e.message);
  }
}

// ── Envoyer notification push pour une actu

// ── Envoyer notification push pour une actu ──────────────────
function buildActuPushPayload(title, description, photoUrl, actuId) {
  const safeId = actuId != null ? String(actuId) : "";
  const detailHash = safeId ? `/#actu=${encodeURIComponent(safeId)}` : "/#notifs";

  return JSON.stringify({
    title: `MAT — ${String(title || "").substring(0, 60)}`,
    body: String(description || title || "").substring(0, 150),
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    image: photoUrl || undefined,
    actions: [{ action: "detail", title: "Détail" }],
    data: {
      url: detailHash,
      listUrl: "/#notifs",
      actuId: safeId || null,
      open: safeId ? "actu" : "notifs"
    }
  });
}

async function sendActuPush(title, description, photoUrl, actuId) {
  const subs = await readSubs();
  if (!subs.length) return { sent: 0, failed: 0, total: 0 };

  const payload = buildActuPushPayload(title, description, photoUrl, actuId);

  let sent = 0, failed = 0;
  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }
  if (dead.length) {
    const alive = subs.filter(s => !dead.includes(s.endpoint));
    await writeSubs(alive);
  }
  return { sent, failed, total: subs.length };
}

// ── Google Calendar : créer/remplacer événement ──────────────
let _googleCalendarClient = null;
function getGoogleCalendarClient() {
  if (_googleCalendarClient) return _googleCalendarClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
    : process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const { google } = require("googleapis");
    const credentials = JSON.parse(raw);
    const auth = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ["https://www.googleapis.com/auth/calendar"]
    );
    _googleCalendarClient = google.calendar({ version: "v3", auth });
    return _googleCalendarClient;
  } catch (e) {
    console.warn("Google Calendar init fail:", e.message);
    return null;
  }
}

async function upsertGoogleCalendarEvent(title, description, eventDate, eventLocation) {
  const calendar = getGoogleCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendar || !calendarId) {
    throw new Error("Google Calendar non configuré");
  }

  // Chercher les événements du jour pour détecter un doublon
  const eventDt = new Date(eventDate);
  const dayStart = new Date(eventDt); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(eventDt); dayEnd.setHours(23, 59, 59, 999);

  const existing = await calendar.events.list({
    calendarId,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime"
  });

  // Détection doublon : similarité > 0.6 sur le titre normalisé
  const stringSimilarity = require("string-similarity");
  const normalize = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, "").trim();
  const target = normalize(title);
  let deletedCount = 0;

  for (const ev of existing.data.items || []) {
    const evTitle = normalize(ev.summary);
    const similarity = stringSimilarity.compareTwoStrings(target, evTitle);
    if (similarity > 0.6) {
      try {
        await calendar.events.delete({ calendarId, eventId: ev.id });
        deletedCount++;
        console.log(`🗑️ Doublon supprimé: "${ev.summary}" (sim=${similarity.toFixed(2)})`);
      } catch (e) {
        console.warn(`Échec suppression doublon ${ev.id}:`, e.message);
      }
    }
  }

  // Créer le nouvel événement
  const hasTime = /T\d{2}:\d{2}/.test(eventDate);
  const endDt = new Date(eventDt.getTime() + 60 * 60 * 1000); // +1h par défaut

  const eventBody = {
    summary: title,
    description: description || "",
    location: eventLocation || undefined,
    start: hasTime
      ? { dateTime: eventDt.toISOString(), timeZone: "Europe/Paris" }
      : { date: eventDt.toISOString().slice(0, 10) },
    end: hasTime
      ? { dateTime: endDt.toISOString(), timeZone: "Europe/Paris" }
      : { date: eventDt.toISOString().slice(0, 10) }
  };

  const created = await calendar.events.insert({ calendarId, requestBody: eventBody });
  return { ok: true, event_id: created.data.id, html_link: created.data.htmlLink, deleted_duplicates: deletedCount };
}

// ── Proxy MEL pour la PWA ─────────────────────────────────────
app.post("/mel", async (req, res) => {
  const { messages, category, extraCtx } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error:"messages[] requis" });
  }

  try {
    const history = messages.slice(-8).map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content || "")
    }));
    const lastUser = history.filter(m => m.role === "user").slice(-1)[0]?.content || "";
    await trackMelStats(lastUser);
    const result = await generateMelReply(lastUser, history, category || "autre", extraCtx || "");
    console.log(`📱 PWA MEL [${category||"autre"}] via ${result.provider}`);
    const showElus = (result.reply || "").includes("[SHOW_ELUS]");
    const showUrbanisme = (result.reply || "").includes("[SHOW_URBANISME]");
    const cleanReply = (result.reply || "")
      .replace("[SHOW_ELUS]", "")
      .replace("[SHOW_URBANISME]", "")
      .trim();
    res.json({ reply: cleanReply, provider: result.provider, showElus, showUrbanisme });
  } catch(e) {
    console.error("❌ MEL proxy:", e.message);
    res.json({ reply:"Je rencontre une difficulté technique. Contactez la mairie au 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr 😊", provider:"fallback" });
  }
});

// ── Proxy IGN — détection zone PLU par coordonnées GPS ────────
app.get("/api/zone-plu", async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ ok:false, error:"lat et lon requis" });
  const latF = parseFloat(lat), lonF = parseFloat(lon);
  if (isNaN(latF) || isNaN(lonF)) return res.status(400).json({ ok:false, error:"lat/lon invalides" });
  try {
    const geom = encodeURIComponent(JSON.stringify({ type:"Point", coordinates:[lonF, latF] }));
    const r = await axios.get(
      `https://apicarto.ign.fr/api/gpu/zone-urba?geom=${geom}`,
      { timeout:8000, headers:{ Accept:"application/json" } }
    );
    const features = r.data?.features || [];
    if (!features.length) {
      return res.json({ ok:true, zone:null, message:"Aucune zone PLU trouvée (hors périmètre ou PLU non publié)" });
    }
    const props = features[0].properties || {};
    return res.json({ ok:true, zone: props.libelle||null, liblong: props.libelong||null, partition: props.partition||null });
  } catch(e) {
    console.error("❌ /api/zone-plu:", e.message);
    return res.status(502).json({ ok:false, error:"Service IGN indisponible" });
  }
});
// ════════════════════════════════════════════════════════════
// ENDPOINT /api/parcours — Génération de parcours IA (Mistral)
// + proxy Overpass pour réseau de chemins OSM
// À coller dans index.js après l'endpoint /mel
// ════════════════════════════════════════════════════════════

// ── Proxy Overpass OSM — réseau de chemins de Mézières ───────
// Évite les problèmes CORS depuis le front PWA
app.get("/api/chemins", async (req, res) => {
  // Bbox légèrement élargie autour de Mézières-lez-Cléry
  const query = `
    [out:json][timeout:25];
    (
      way["highway"~"^(primary|secondary|tertiary|unclassified|residential|service|track|path|footway|cycleway)$"]
        (47.790,1.775,47.840,1.860);
    );
    out geom;
  `;

  try {
    const r = await axios.post(
      "https://overpass-api.de/api/interpreter",
      query,
      {
        timeout: 30000,
        headers: { "Content-Type": "text/plain" }
      }
    );

    // Classifier les voies en 3 catégories
    const elements = (r.data.elements || []).map(el => {
      const h = el.tags?.highway || "";
      const surface = el.tags?.surface || "";
      const access = el.tags?.access || "";

      let type;
      if (["primary","secondary","tertiary","unclassified","residential","service"].includes(h)) {
        type = "route";
      } else if (h === "track" || surface.includes("gravel") || surface.includes("dirt") || surface.includes("unpaved")) {
        type = "terre";
      } else {
        type = "terre"; // path, footway, cycleway → chemin de terre par défaut
      }

      return {
        id: el.id,
        type,
        name: el.tags?.name || el.tags?.ref || null,
        highway: h,
        surface,
        coords: (el.geometry || []).map(g => [g.lat, g.lon])
      };
    }).filter(el => el.coords.length >= 2);

    res.json({ ok: true, count: elements.length, elements });
  } catch(e) {
    console.error("❌ Overpass error:", e.message);
    res.status(500).json({ ok: false, error: "Overpass indisponible", details: e.message });
  }
});

// ── Génération de parcours IA via Mistral ─────────────────────
app.post("/api/parcours", async (req, res) => {
  const { mode, distance, style } = req.body || {};

  if (!mode || !distance) {
    return res.status(400).json({ error: "mode et distance requis" });
  }

  if (!MISTRAL_API_KEY) {
    return res.status(500).json({ error: "MISTRAL_API_KEY manquante" });
  }

  const modeLabels = { pied: "à pied", velo: "à vélo", cheval: "à cheval" };
  const styleLabels = {
    nature:     "nature & chemins de terre",
    patrimoine: "patrimoine & bourg historique",
    vignes:     "vignes & campagne agricole",
    mixte:      "mixte et varié"
  };

  const systemPrompt = `Tu es un expert local en randonnée pour la commune de Mézières-lez-Cléry (Loiret, 45370, Centre-Val de Loire).
La commune est traversée par 3 types de voies :
- Routes et rues (revêtement dur, accessible voiture)
- Voies et chemins de terre communaux (publics, piétons/vélos)
- Chemins d'exploitation AFR (agricoles privés, tolérance de passage non garantie)

Points d'intérêt : Parking des randonneurs (départ officiel, 47.8185/1.8095), Église Saint-Avit (47.8222/1.8078), Château de Mézières (47.8218/1.805), Butte des Élus tumulus gaulois (47.8145/1.802), Vignes AOC Orléans-Cléry (47.816/1.813), Vallée aux Moines site naturel (47.808/1.804).

La commune est bornée approximativement : lat 47.790–47.840, lng 1.775–1.860.
Le bourg central est autour de 47.820/1.805.

Réponds UNIQUEMENT en JSON valide, sans texte avant ni après, sans balises markdown. Format exact :
{
  "titre": "Nom poétique du parcours (4-5 mots)",
  "duree": "Xh XX",
  "description": "3-4 phrases descriptives et inspirantes",
  "conseils": "1-2 conseils pratiques courts",
  "waypoints": [[lat,lng],[lat,lng],...]
}

Les waypoints doivent former une boucle réaliste de ~${distance} km au départ du parking (47.8185,1.8095), avec 8 à 14 points. Adapte le tracé au mode ${modeLabels[mode] || mode} et à l'ambiance ${styleLabels[style] || style}. Pour le vélo, privilégie routes et chemins larges. Pour le cheval, évite les routes principales.`;

  try {
    const r = await axios.post(
      MISTRAL_URL,
      {
        model: MISTRAL_MODEL,
        temperature: 0.6,
        max_tokens: 600,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Génère un parcours ${modeLabels[mode] || mode} de ${distance} km, ambiance ${styleLabels[style] || style}.` }
        ]
      },
      {
        timeout: 25000,
        headers: {
          "Authorization": `Bearer ${MISTRAL_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const raw = r.data?.choices?.[0]?.message?.content || "";

    // Nettoyage : retirer éventuelles balises markdown
    const clean = raw.replace(/```json|```/g, "").trim();

    let parcours;
    try {
      parcours = JSON.parse(clean);
    } catch(parseErr) {
      console.error("❌ JSON Mistral invalide:", clean);
      return res.status(500).json({ error: "Réponse Mistral non parsable", raw: clean });
    }

    // Tracker les tokens
    const usage = r.data?.usage || {};
    trackIaTokens("mistral", usage.prompt_tokens || 0, usage.completion_tokens || 0).catch(() => {});

    res.json({ ok: true, parcours });

  } catch(e) {
    console.error("❌ /api/parcours Mistral:", e.message);
    res.status(500).json({ ok: false, error: "Génération impossible", details: e.message });
  }
});
// ── Signalement citoyen → Redis + Trello ─────────────────────
app.post("/signal", async (req, res) => {
  const { cat, desc, lat, lon, photoB64, type } = req.body || {};
  const mapsLink = (lat && lon) ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=18` : null;
  const isBug     = (type === "bug"     || (cat || "").startsWith("[BUG]"));
  const isContact = (type === "contact" || (cat || "").startsWith("[Demande]"));
  const isSignal  = !isBug && !isContact;

  const signal = {
    id: Date.now(),
    cat: cat || "Non précisée",
    desc: desc || "",
    lat, lon, mapsLink,
    hasPhoto: !!photoB64,
    date: new Date().toLocaleString("fr-FR"),
    dateISO: new Date().toISOString(),
  };

  // Stockage Redis
  const signals = await readSignals();
  signals.unshift(signal);
  if (signals.length > 100) signals.splice(100);
  await writeSignals(signals);
  console.log(`🚨 Signalement stocké #${signal.id}: ${cat}`);

  // Envoi Trello
  try {
    let cardName;
    if (isBug) {
      cardName = `[BUG] ${(cat || "").replace("[BUG]","").trim() || "Non précisé"}`;
    } else if (isContact) {
      cardName = `[Demande] ${(desc || "").split("\n")[0].substring(0, 80)}`;
    } else {
      cardName = `[Signalement] ${cat || "Non précisé"}`;
    }

    const mapsLine = mapsLink ? `\n\n📍 [Voir sur la carte](${mapsLink})` : "";
    const dateLine = `\n\n📅 ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`;
    const cardDesc = (desc || "Aucune description.") + mapsLine + dateLine;

    await createTrelloCard(cardName, cardDesc, photoB64 || null);
  } catch (trelloErr) {
    console.warn("⚠️ Trello échec (signal stocké Redis quand même):", trelloErr.message);
  }

  res.json({ success: true });
});

app.get("/signalements", async (req, res) => {
  const signals = await readSignals();
  res.json({ signalements: signals, count: signals.length });
});

// ── Boîte à idées partagées ──────────────────────────────────
app.get("/idees", async (req, res) => {
  const idees = await readIdeas();
  res.json({ idees, count: idees.length });
});

app.post("/idee", async (req, res) => {
  const { id, text, cat, date } = req.body || {};
  if (!text) return res.status(400).json({ error: "text requis" });

  const ideas = await readIdeas();
  if (ideas.find(i => i.id === id)) return res.json({ success:true, duplicate:true });

  ideas.unshift({
    id: id || Date.now(),
    text: text.substring(0,500),
    cat: cat || "💡 Autre",
    votes: 0,
    date: date || new Date().toLocaleDateString("fr-FR")
  });

  if (ideas.length > 200) ideas.splice(200);
  await writeIdeas(ideas);
  console.log(`💡 Idée stockée: "${text.substring(0,50)}"`);
  res.json({ success:true });
});

app.post("/idee/:id/vote", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ideas = await readIdeas();
  const idx = ideas.findIndex(i => i.id === id);
  if (idx < 0) return res.status(404).json({ error: "Idée non trouvée" });

  ideas[idx].votes = (ideas[idx].votes || 0) + 1;
  await writeIdeas(ideas);
  res.json({ success:true, votes: ideas[idx].votes });
});

// ── Actualités (publications stockées) ───────────────────────
app.get("/actus", async (req, res) => {
  const actus = await readNews();
  res.json({ actus, count: actus.length });
});

// ════════════════════════════════════════
// PROXY MÉTÉO — Open-Meteo (contourne CORS)
// ════════════════════════════════════════
const METEO_OPEN_URL = 'https://api.open-meteo.com/v1/forecast?latitude=47.822&longitude=1.808&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,pressure_msl,precipitation,wind_gusts_10m&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,wind_gusts_10m,surface_pressure&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,uv_index_max,sunrise,sunset,wind_direction_10m_dominant,wind_gusts_10m_max&past_days=1&timezone=Europe%2FParis&forecast_days=10';

// Cache 10 minutes pour éviter de spammer Open-Meteo
let _meteoCache = null;
let _meteoCacheTime = 0;
const METEO_CACHE_TTL = 10 * 60 * 1000; // 10 min

async function getCachedMeteoForecast() {
  const now = Date.now();
  if (_meteoCache && (now - _meteoCacheTime) < METEO_CACHE_TTL) {
    return _meteoCache;
  }
  const data = await fetchOpenMeteoForecast();
  _meteoCache = data;
  _meteoCacheTime = now;
  return data;
}

app.get('/meteo/forecast', async (req, res) => {
  try {
    const now = Date.now();
    if (_meteoCache && (now - _meteoCacheTime) < METEO_CACHE_TTL) {
      res.set('Access-Control-Allow-Origin', '*');
      return res.json(_meteoCache);
    }
    const r = await fetch(METEO_OPEN_URL);
    if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
    const data = await r.json();
    _meteoCache = data;
    _meteoCacheTime = now;
    res.set('Access-Control-Allow-Origin', '*');
    res.json(data);
  } catch (e) {
    console.error('[meteo/forecast] error:', e.message);
    res.set('Access-Control-Allow-Origin', '*');
    res.status(503).json({ error: 'Météo indisponible', detail: e.message });
  }
});

// ── Météo commune + vigilance Météo-France ───────────────────
app.get("/meteo/vigilance", async (req, res) => {
  try {
    const raw = await fetchMeteoFranceVigilanceRaw();
    const vigilance = extractDepartmentVigilance(raw, "45");
    res.json({ ok: true, vigilance, raw });
  } catch (e) {
    console.error("❌ /meteo/vigilance:", e.response?.status, e.response?.data || e.message);
    res.status(500).json({
      ok: false,
      error: "Vigilance indisponible",
      status: e.response?.status || null,
      details: e.response?.data || e.message
    });
  }
});

app.get("/meteo/commune", async (req, res) => {
  try {
    const [forecast, rawVigilance] = await Promise.all([
      getCachedMeteoForecast(),  // <-- utilise le cache
      fetchMeteoFranceVigilanceRaw().catch(() => null),
    ]);

    const vigilance = extractDepartmentVigilance(rawVigilance, "45");
    res.json({ forecast, vigilance });
  } catch (e) {
    console.error("❌ /meteo/commune:", e.message);
    res.status(500).json({ error: "Météo indisponible" });
  }
});

app.get("/meteo/alertes/check", async (req, res) => {
  try {
    const force = req.query.force === "true";
    const raw = await fetchMeteoFranceVigilanceRaw();
    const vigilance = extractDepartmentVigilance(raw, "45");

    if (!vigilance) {
      return res.json({ status: "no-alert" });
    }

    if (Number(vigilance.level) < AUTO_POST_MIN_LEVEL) {
      return res.json({ status: "below-threshold", vigilance });
    }

    const last = await readLastWeatherAlert();
    if (!force && isSameWeatherAlert(last, vigilance)) {
      return res.json({ status: "duplicate", vigilance });
    }

    let published = false;
    let message = null;

    if (AUTO_POST_WEATHER_ALERTS || force) {
      message = await publishWeatherAlertToFacebook(vigilance);
      published = true;
    }

    await writeLastWeatherAlert(vigilance);

    res.json({
      status: published ? "published" : "stored",
      vigilance,
      message,
    });
  } catch (e) {
    console.error("ALERTE METEO ERROR =", {
      status: e.response?.status,
      data: e.response?.data,
      message: e.message
    });

    if (e.response?.status === 401) {
      return res.json({
        status: "auth-error",
        source: "meteo-france",
        details: "Token vigilance invalide"
      });
    }

    res.status(e.response?.status || 500).json({
      error: "Contrôle alerte impossible",
      details: e.response?.data || e.message
    });
  }
});

// ── Abonnement push ───────────────────────────────────────────
app.post("/push/subscribe", async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error:"Subscription invalide" });

  const subs = await readSubs();
  const exists = subs.some(s => s.endpoint === sub.endpoint);
  if (!exists) {
    subs.push(sub);
    await writeSubs(subs);
    console.log(`📱 Nouvel abonné push (total: ${subs.length})`);
  }

  res.json({ success:true, total:subs.length });
});

app.post("/push/unsubscribe", async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error:"Endpoint requis" });

  const subs = (await readSubs()).filter(s => s.endpoint !== endpoint);
  await writeSubs(subs);
  res.json({ success: true });
});

// ── Stats usage ──────────────────────────────────────────────
app.post("/stats/track", async (req, res) => {
  const { service, device } = req.body || {};
  if (!service) return res.status(400).json({ error: "service requis" });

  const stats = await readStats();
  const { day: today, month } = getParisDateParts();

  if (!stats.services) stats.services = {};
  stats.services[service] = (stats.services[service] || 0) + 1;
  if (!stats.parJour) stats.parJour = {};
  if (!stats.parJour[today]) stats.parJour[today] = {};
  stats.parJour[today][service] = (stats.parJour[today][service] || 0) + 1;
  stats.totalAcces = (stats.totalAcces || 0) + 1;

const deviceId = req.headers["x-device-id"] || req.body?.deviceId || null;
  if (deviceId) {
    try {
      if (!stats.uniqueUsers) stats.uniqueUsers = { total: 0, byDay: {}, byMonth: {}, allDevices: [] };
      const u = stats.uniqueUsers;
      if (!u.byDay[today]) u.byDay[today] = [];
      if (!u.byMonth[month]) u.byMonth[month] = [];
      if (!Array.isArray(u.allDevices)) u.allDevices = [];
      if (!u.byDay[today].includes(deviceId)) u.byDay[today].push(deviceId);
      if (!u.byMonth[month].includes(deviceId)) u.byMonth[month].push(deviceId);
      if (!u.allDevices.includes(deviceId)) u.allDevices.push(deviceId);
      u.total = u.allDevices.length;

      if (!stats.deviceStats) {
        stats.deviceStats = { byDay: {}, byMonth: {}, daySeen: {}, monthSeen: {}, appOpensByDay: {}, appOpensByMonth: {} };
      }
      const ds = stats.deviceStats;
      if (!ds.daySeen[today]) ds.daySeen[today] = {};
      if (!ds.monthSeen[month]) ds.monthSeen[month] = {};
      if (!ds.byDay[today]) ds.byDay[today] = {};
      if (!ds.byMonth[month]) ds.byMonth[month] = {};

      if (service === 'app_open') {
        ds.appOpensByDay[today] = (ds.appOpensByDay[today] || 0) + 1;
        ds.appOpensByMonth[month] = (ds.appOpensByMonth[month] || 0) + 1;
      }

      let cleanDevice;
      if (device) {
        cleanDevice = sanitizeDeviceInfo(device);
      } else if (ds.daySeen[today][deviceId]) {
        cleanDevice = ds.daySeen[today][deviceId];
      } else if (ds.monthSeen[month][deviceId]) {
        cleanDevice = ds.monthSeen[month][deviceId];
      } else {
        cleanDevice = sanitizeDeviceInfo({});
      }

      if (!ds.daySeen[today][deviceId]) {
        ds.daySeen[today][deviceId] = cleanDevice;
        bumpDeviceBreakdown(ds.byDay[today], cleanDevice);
      }
      if (!ds.monthSeen[month][deviceId]) {
        ds.monthSeen[month][deviceId] = cleanDevice;
        bumpDeviceBreakdown(ds.byMonth[month], cleanDevice);
      }

      const keepDays = Object.keys(ds.daySeen).sort().slice(-90);
      compactSeenMap(ds.daySeen, keepDays);
      compactSeenMap(ds.byDay, keepDays);
      compactSeenMap(ds.appOpensByDay, keepDays);
      const keepMonths = Object.keys(ds.monthSeen).sort().slice(-24);
      compactSeenMap(ds.monthSeen, keepMonths);
      compactSeenMap(ds.byMonth, keepMonths);
      compactSeenMap(ds.appOpensByMonth, keepMonths);
    } catch(e) { console.warn('stats/track unique device:', e.message); }
  }
  await writeStats(stats);
  res.json({ success: true });
});

app.get("/stats", async (req, res) => {
  const stats = await readStats();
  const parJour = stats.parJour || {};
  const { day: today, month } = getParisDateParts();
  const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yFmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(yesterdayDate);
  const yGet = t => yFmt.find(p => p.type === t)?.value || '';
  const yesterday = `${yGet('year')}-${yGet('month')}-${yGet('day')}`;
  const prevMonthDate = new Date(); prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
  const pFmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(prevMonthDate);
  const pGet = t => pFmt.find(p => p.type === t)?.value || '';
  const prevMonth = `${pGet('year')}-${pGet('month')}`;
  const installations = Object.entries(parJour).sort(([a],[b]) => b.localeCompare(a)).slice(0, 30).map(([date, svcs]) => ({ date, installations: svcs.installation || 0, acces: Object.values(svcs).reduce((s,v)=>s+v,0) }));
  const accessToday = Object.values(parJour[today] || {}).reduce((a,b) => a + Number(b || 0), 0);
  const accessYesterday = Object.values(parJour[yesterday] || {}).reduce((a,b) => a + Number(b || 0), 0);
  const accessMonth = Object.entries(parJour).filter(([d]) => d.startsWith(month)).reduce((sum, [, svcs]) => sum + Object.values(svcs || {}).reduce((a,b)=>a + Number(b || 0), 0), 0);
  const accessPrevMonth = Object.entries(parJour).filter(([d]) => d.startsWith(prevMonth)).reduce((sum, [, svcs]) => sum + Object.values(svcs || {}).reduce((a,b)=>a + Number(b || 0), 0), 0);
  res.json({
    totalAcces: stats.totalAcces || 0,
    totalInstalls: stats.services?.installation || 0,
    parService: stats.services || {},
    derniers30jours: installations,
    uniqueUsers: stats.uniqueUsers || { total: 0, byDay: {}, byMonth: {}, allDevices: [] },
    deviceStats: stats.deviceStats || {},
    overview: {
      today, month,
      uniqueToday: (stats.uniqueUsers?.byDay?.[today] || []).length,
      uniqueMonth: (stats.uniqueUsers?.byMonth?.[month] || []).length,
      uniqueYesterday: (stats.uniqueUsers?.byDay?.[yesterday] || []).length,
      uniquePrevMonth: (stats.uniqueUsers?.byMonth?.[prevMonth] || []).length,
      accessToday, accessYesterday, accessMonth, accessPrevMonth,
      uniqueTrendDay: pctTrend((stats.uniqueUsers?.byDay?.[today] || []).length, (stats.uniqueUsers?.byDay?.[yesterday] || []).length),
      uniqueTrendMonth: pctTrend((stats.uniqueUsers?.byMonth?.[month] || []).length, (stats.uniqueUsers?.byMonth?.[prevMonth] || []).length),
      accessTrendDay: pctTrend(accessToday, accessYesterday),
      accessTrendMonth: pctTrend(accessMonth, accessPrevMonth)
    }
  });
});

// ── Route setup webhook// ── Route setup webhook (à appeler une seule fois) ───────────
app.get("/setup-webhook", async (req, res) => {
  if (!PAGE_ACCESS_TOKEN) return res.status(500).json({ error: "PAGE_ACCESS_TOKEN manquant" });

  try {
    const pageInfo = await axios.get(
      `https://graph.facebook.com/v19.0/me?access_token=${PAGE_ACCESS_TOKEN}`
    );
    const pageId   = pageInfo.data.id;
    const pageName = pageInfo.data.name;

    const subResult = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
      { subscribed_fields: "feed" },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );

    const checkResult = await axios.get(
      `https://graph.facebook.com/v19.0/${pageId}/subscribed_apps`,
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );

    res.json({
      success: true,
      page: { id: pageId, name: pageName },
      result: subResult.data,
      abonnements: checkResult.data
    });
  } catch(e) {
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

app.get("/ping", (req, res) => {
  res.type("text/plain").send("ok");
});

// ── Diagnostic Mistral (à supprimer après test) ───────────────
app.get("/debug-mistral", async (req, res) => {
  if (!MISTRAL_API_KEY) return res.json({ error: "MISTRAL_API_KEY absente" });
  try {
    const payload = {
      model: MISTRAL_MODEL,
      temperature: 0.2,
      max_tokens: 50,
      messages: [
        { role: "system", content: "Tu es MEL, assistante de la mairie." },
        { role: "user",   content: "Bonjour" }
      ]
    };
    const r = await axios.post(MISTRAL_URL, payload, {
      timeout: 20000,
      headers: {
        "Authorization": `Bearer ${MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      }
    });
    res.json({ ok: true, model: MISTRAL_MODEL, url: MISTRAL_URL, response: r.data });
  } catch(e) {
    res.json({
      ok: false,
      model: MISTRAL_MODEL,
      url: MISTRAL_URL,
      status: e.response?.status,
      errorData: e.response?.data,
      message: e.message
    });
  }
});

// ── Diagnostic Google Calendar ─────────────────────────────
app.get("/debug-calendar", adminAuth, async (req, res) => {
  const result = {
    config: {
      has_calendar_id: !!process.env.GOOGLE_CALENDAR_ID,
      calendar_id: process.env.GOOGLE_CALENDAR_ID || "(vide)",
      has_service_account_b64: !!process.env.GOOGLE_SERVICE_ACCOUNT_B64,
      has_service_account_raw: !!process.env.GOOGLE_SERVICE_ACCOUNT,
      b64_length: process.env.GOOGLE_SERVICE_ACCOUNT_B64 ? process.env.GOOGLE_SERVICE_ACCOUNT_B64.length : 0,
    }
  };

  // Test 1 : googleapis installée ?
  try {
    require("googleapis");
    result.googleapis_installed = true;
  } catch (e) {
    result.googleapis_installed = false;
    result.googleapis_error = e.message;
    return res.json({ ok: false, step: "googleapis_require", result });
  }

  // Test 2 : string-similarity installée ?
  try {
    require("string-similarity");
    result.string_similarity_installed = true;
  } catch (e) {
    result.string_similarity_installed = false;
    result.string_similarity_error = e.message;
    return res.json({ ok: false, step: "string_similarity_require", result });
  }

  // Test 3 : Parse du JSON service account
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
    : process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) {
    return res.json({ ok: false, step: "env_missing", result, error: "GOOGLE_SERVICE_ACCOUNT_B64 et GOOGLE_SERVICE_ACCOUNT absents" });
  }
  try {
    const creds = JSON.parse(raw);
    result.service_account_email = creds.client_email || "(manquant)";
    result.service_account_project = creds.project_id || "(manquant)";
    result.has_private_key = !!creds.private_key;
  } catch (e) {
    return res.json({ ok: false, step: "json_parse", result, error: "JSON invalide: " + e.message });
  }

  // Test 4 : Init client Google Calendar
  const cal = getGoogleCalendarClient();
  if (!cal) {
    return res.json({ ok: false, step: "calendar_client_init", result, error: "getGoogleCalendarClient() a renvoyé null — voir logs Render au démarrage" });
  }
  result.calendar_client_ok = true;

  // Test 5 : Lister les events du jour (teste l'authentification + les droits)
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    return res.json({ ok: false, step: "calendar_id_missing", result });
  }
  try {
    const today = new Date();
    const dayStart = new Date(today); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(today); dayEnd.setHours(23, 59, 59, 999);
    const list = await cal.events.list({
      calendarId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      maxResults: 5,
    });
    result.list_test_ok = true;
    result.events_today_count = (list.data.items || []).length;
  } catch (e) {
    result.list_test_ok = false;
    result.list_test_error = e.message;
    result.list_test_status = e.code || e.response?.status || null;
    result.list_test_details = e.response?.data?.error || null;
    return res.json({ ok: false, step: "calendar_list", result });
  }

  // Test 6 : Créer un événement de test (puis le supprimer)
  try {
    const testEvent = await cal.events.insert({
      calendarId,
      requestBody: {
        summary: "[TEST MAT] Diagnostic — à supprimer",
        description: "Événement de diagnostic créé par /debug-calendar. Sera supprimé automatiquement.",
        start: { dateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(), timeZone: "Europe/Paris" },
        end: { dateTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), timeZone: "Europe/Paris" },
      }
    });
    result.insert_test_ok = true;
    result.test_event_id = testEvent.data.id;
    result.test_event_link = testEvent.data.htmlLink;

    // Supprimer immédiatement l'événement de test
    try {
      await cal.events.delete({ calendarId, eventId: testEvent.data.id });
      result.delete_test_ok = true;
    } catch (delErr) {
      result.delete_test_ok = false;
      result.delete_test_error = delErr.message;
    }
  } catch (e) {
    result.insert_test_ok = false;
    result.insert_test_error = e.message;
    result.insert_test_status = e.code || e.response?.status || null;
    result.insert_test_details = e.response?.data?.error || null;
    return res.json({ ok: false, step: "calendar_insert", result });
  }

  res.json({ ok: true, step: "all_passed", result });
});

// ── Diagnostic Trello (à supprimer après test) ────────────────
app.get("/debug-trello", async (req, res) => {
  const result = {
    config: {
      has_key:     !!TRELLO_KEY,
      has_token:   !!TRELLO_TOKEN,
      has_list_id: !!TRELLO_LIST_ID,
      list_id:     TRELLO_LIST_ID || "(vide)",
      key_preview: TRELLO_KEY ? TRELLO_KEY.substring(0, 6) + "..." : "(vide)",
    }
  };

  if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) {
    return res.json({ ok: false, error: "Variables Trello manquantes", result });
  }

  // Test 1 : vérifier que la liste existe
  try {
    const listRes = await axios.get(
      `https://api.trello.com/1/lists/${TRELLO_LIST_ID}`,
      { params: { key: TRELLO_KEY, token: TRELLO_TOKEN }, timeout: 10000 }
    );
    result.list = { id: listRes.data.id, name: listRes.data.name };
  } catch(e) {
    return res.json({ ok: false, error: "Liste Trello introuvable: " + (e.response?.data || e.message), result });
  }

  // Test 2 : créer une carte de test
  try {
    const card = await createTrelloCard(
      "[TEST] Carte de diagnostic MAT",
      "Test MAT " + new Date().toLocaleString("fr-FR"),
      null
    );
    result.card = { id: card.id, url: card.shortUrl };
    res.json({ ok: true, result });
  } catch(e) {
    res.json({ ok: false, error: "Erreur création carte: " + (e.response?.data || e.message), result });
  }
});


app.get("/admin/services/test", adminAuth, async (req, res) => {
  const checkedAt = new Date().toISOString();

  async function runCheck(key, label, icon, fn) {
    const started = Date.now();
    try {
      const out = await fn();
      return {
        key,
        label,
        icon,
        status: out?.status || "ok",
        message: out?.message || "OK",
        details: out?.details ?? null,
        checkedAt,
        durationMs: Date.now() - started,
      };
    } catch (e) {
  const apiError = e.response?.data?.error;
  return {
    key,
    label,
    icon,
    status: "danger",
    message:
      (typeof apiError === "string" ? apiError : apiError?.message) ||
      e.message ||
      "Erreur",
    details: apiError || e.response?.data || null,
    checkedAt,
    durationMs: Date.now() - started,
  };
}
  }

  const services = [];

  services.push(await runCheck("server", "Serveur API", "🌲", async () => ({
    status: "ok",
    message: "Serveur Express opérationnel",
    details: { version: "6.6.0", uptimeSeconds: Math.round(process.uptime()) }
  })));

  services.push(await runCheck("redis", "Redis / Upstash", "🗄️", async () => {
    if (!REDIS_URL || !REDIS_TOKEN) {
      return { status: "warn", message: "Redis non configuré", details: { has_url: !!REDIS_URL, has_token: !!REDIS_TOKEN } };
    }
    const probeKey = "mat:diag:probe";
    const probeVal = { ts: checkedAt };
    await redisSet(probeKey, probeVal);
    const readBack = await redisGet(probeKey);
    if (!readBack || readBack.ts !== checkedAt) {
      throw new Error("Lecture/écriture Redis incohérente");
    }
    return { status: "ok", message: "Lecture / écriture Redis OK", details: { probe_key: probeKey } };
  }));

  services.push(await runCheck("meteo", "Open-Meteo commune", "🌤️", async () => {
    const forecast = await fetchOpenMeteoForecast();
    const cur = forecast?.current || {};
    return {
      status: "ok",
      message: `Température reçue : ${Math.round(Number(cur.temperature_2m || 0))}°C`,
      details: {
        temperature_2m: cur.temperature_2m,
        weather_code: cur.weather_code,
        wind_speed_10m: cur.wind_speed_10m,
        timezone: forecast?.timezone || OPEN_METEO_TZ
      }
    };
  }));

  services.push(await runCheck("vigilance", "Vigilance Météo-France", "⚠️", async () => {
    if (!METEOFRANCE_VIGILANCE_URL) {
      return { status: "warn", message: "Flux vigilance non configuré", details: { has_url: false } };
    }
    const raw = await fetchMeteoFranceVigilanceRaw();
    const vig = extractDepartmentVigilance(raw, "45");
    if (!vig) {
      return { status: "warn", message: "Flux reçu mais aucune vigilance détaillée pour le 45", details: { periods: raw?.product?.periods?.length || 0 } };
    }
    return {
      status: "ok",
      message: `Vigilance ${vig.color_label} — ${vig.phenomenon_label}`,
      details: vig
    };
  }));

  services.push(await runCheck("bus", "Bus Rémi (cache)", "🚌", async () => {
    const ageMs = remiCache.lastUpdate ? Date.now() - remiCache.lastUpdate.getTime() : null;
    if (!remiCache.content) {
      return { status: "warn", message: "Cache bus vide", details: { lastUpdate: remiCache.lastUpdate || null } };
    }
    if (String(remiCache.content).startsWith("[")) {
      return { status: "warn", message: "Cache bus présent mais en erreur", details: { content: remiCache.content, lastUpdate: remiCache.lastUpdate || null } };
    }
    return {
      status: ageMs != null && ageMs > CACHE_MS ? "warn" : "ok",
      message: ageMs != null && ageMs > CACHE_MS ? "Cache bus ancien" : "Cache bus disponible",
      details: { lastUpdate: remiCache.lastUpdate || null, age_hours: ageMs != null ? Number((ageMs / 3600000).toFixed(1)) : null }
    };
  }));

  services.push(await runCheck("agenda_public", "Agenda public (ICS)", "📅", async () => {
    if (!GOOGLE_CALENDAR_ICAL) {
      return { status: "warn", message: "ICAL Google Calendar non configuré", details: { has_ical: false } };
    }
    await refreshCalendarCache();
    if (!calendarCache.content || String(calendarCache.content).includes("non accessible")) {
      throw new Error("Agenda public indisponible");
    }
    return {
      status: "ok",
      message: "Agenda public rechargé",
      details: { lastUpdate: calendarCache.lastUpdate || null }
    };
  }));

  services.push(await runCheck("calendar_admin", "Google Calendar (écriture)", "🗓️", async () => {
    const cal = getGoogleCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!cal || !calendarId) {
      return {
        status: "warn",
        message: "Google Calendar non configuré",
        details: { has_client: !!cal, has_calendar_id: !!calendarId }
      };
    }

    const list = await cal.events.list({
      calendarId,
      timeMin: new Date().toISOString(),
      maxResults: 3,
      singleEvents: true,
      orderBy: "startTime"
    });

    const start = new Date(Date.now() + 2 * 3600000);
    const end = new Date(Date.now() + 3 * 3600000);
    const created = await cal.events.insert({
      calendarId,
      requestBody: {
        summary: "[TEST MAT] Diagnostic auto",
        description: "Événement créé puis supprimé automatiquement par le test admin.",
        start: { dateTime: start.toISOString(), timeZone: "Europe/Paris" },
        end: { dateTime: end.toISOString(), timeZone: "Europe/Paris" }
      }
    });

    let deleted = false;
    if (created?.data?.id) {
      await cal.events.delete({ calendarId, eventId: created.data.id });
      deleted = true;
    }

    return {
      status: "ok",
      message: "Lecture + écriture Google Calendar OK",
      details: {
        upcoming_events_count: (list.data.items || []).length,
        created_event_id: created?.data?.id || null,
        deleted_test_event: deleted
      }
    };
  }));

  services.push(await runCheck("trello", "Trello signalements", "📌", async () => {
    if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) {
      return {
        status: "warn",
        message: "Trello non configuré",
        details: { has_key: !!TRELLO_KEY, has_token: !!TRELLO_TOKEN, has_list_id: !!TRELLO_LIST_ID }
      };
    }

    const listRes = await axios.get(`https://api.trello.com/1/lists/${TRELLO_LIST_ID}`, {
      params: { key: TRELLO_KEY, token: TRELLO_TOKEN },
      timeout: 10000
    });

    const cardRes = await axios.post(`https://api.trello.com/1/cards`, null, {
      params: {
        key: TRELLO_KEY,
        token: TRELLO_TOKEN,
        idList: TRELLO_LIST_ID,
        name: "[TEST MAT] Diagnostic auto",
        desc: "Carte créée puis supprimée automatiquement par le test admin."
      },
      timeout: 10000
    });

    let deleted = false;
    if (cardRes?.data?.id) {
      await axios.delete(`https://api.trello.com/1/cards/${cardRes.data.id}`, {
        params: { key: TRELLO_KEY, token: TRELLO_TOKEN },
        timeout: 10000
      });
      deleted = true;
    }

    return {
      status: "ok",
      message: `Liste Trello OK : ${listRes.data?.name || TRELLO_LIST_ID}`,
      details: { list_id: TRELLO_LIST_ID, list_name: listRes.data?.name || null, deleted_test_card: deleted }
    };
  }));

  services.push(await runCheck("mistral", "Mistral", "🤖", async () => {
    if (!MISTRAL_API_KEY) {
      return { status: "warn", message: "Mistral non configuré", details: { has_api_key: false, model: MISTRAL_MODEL } };
    }
    const payload = {
      model: MISTRAL_MODEL,
      temperature: 0,
      max_tokens: 20,
      messages: [
        { role: "system", content: "Réponds par OK." },
        { role: "user", content: "Test MAT" }
      ]
    };
    const r = await axios.post(MISTRAL_URL, payload, {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        "Content-Type": "application/json"
      }
    });
    return {
      status: "ok",
      message: `Réponse Mistral reçue (${MISTRAL_MODEL})`,
      details: { model: MISTRAL_MODEL, id: r.data?.id || null }
    };
  }));

services.push(await runCheck("facebook", "Facebook Page", "📘", async () => {
  if (!PAGE_ACCESS_TOKEN) {
    return { status: "warn", message: "Facebook non configuré", details: { has_page_token: false } };
  }
  const pageId = await resolveFacebookPageId();
  if (!pageId) throw new Error("Impossible de résoudre l'identifiant de page");

  const pageInfo = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
    params: { access_token: PAGE_ACCESS_TOKEN, fields: "id,name" },
    timeout: 10000
  });

  return {
    status: "ok",
    message: `Page connectée : ${pageInfo.data?.name || pageId}`,
    details: { page_id: pageInfo.data?.id || pageId, page_name: pageInfo.data?.name || null }
  };
}));

  services.push(await runCheck("push", "Notifications push", "🔔", async () => {
    const subs = await readSubs();
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return {
        status: "warn",
        message: "Web Push non configuré",
        details: { has_public_key: !!VAPID_PUBLIC_KEY, has_private_key: !!VAPID_PRIVATE_KEY, subscribers: subs.length }
      };
    }
    return {
      status: subs.length ? "ok" : "warn",
      message: subs.length ? `${subs.length} abonné(s) push enregistrés` : "Configuration OK mais aucun abonné push",
      details: { subscribers: subs.length }
    };
  }));

  const summary = services.reduce((acc, s) => {
    acc.total += 1;
    if (s.status === "ok") acc.ok += 1;
    else if (s.status === "warn") acc.warn += 1;
    else acc.danger += 1;
    return acc;
  }, { total: 0, ok: 0, warn: 0, danger: 0 });

  res.json({ ok: true, checkedAt, summary, services });
});

// Compteurs en mémoire (pas d'appel Redis pour le health check Render)
const _memStats = { bootTime: new Date().toISOString() };

app.get("/", (req, res) => {
  // Réponse instantanée sans Redis - health check Render
  res.json({
    status:  "MAT est en ligne 🌲",
    version: "6.5 — Mistral principal + Claude secours + MEL améliorée",
    uptime:  Math.floor(process.uptime()) + "s",
    routes: [
      "/webhook","/mel","/signal","/signalements","/actus","/push/subscribe",
      "/push/unsubscribe","/refresh","/calendar","/bus",
      "/meteo/commune","/meteo/vigilance","/meteo/alertes/check"
    ],
  });
});

// Route stats complètes avec Redis (à la demande uniquement)
app.get("/status", async (req, res) => {
  const [subs, news, ideas, signals] = await Promise.all([
    readSubs(), readNews(), readIdeas(), readSignals()
  ]);

  res.json({
    status:  "MAT est en ligne 🌲",
    version: "6.4 — Mistral principal + Claude secours + MEL améliorée",
    abonnes: subs.length,
    actus: news.length,
    idees: ideas.length,
    signalements: signals.length,
    routes: [
      "/webhook","/mel","/signal","/signalements","/actus","/push/subscribe",
      "/push/unsubscribe","/refresh","/calendar","/bus",
      "/meteo/commune","/meteo/vigilance","/meteo/alertes/check"
    ],
  });
});

app.get("/refresh", async (req, res) => {
  await Promise.all([refreshCalendarCache(), refreshRemiCache()]);
  res.json({ success:true, lastUpdate:new Date() });
});

// ── Proxy iCal pour la PWA (résout le CORS Google Calendar) ──
app.get("/calendar-proxy", async (req, res) => {
  if (!GOOGLE_CALENDAR_ICAL) return res.status(500).send("GOOGLE_CALENDAR_ICAL non configuré");
  try {
    const r = await axios.get(GOOGLE_CALENDAR_ICAL, { timeout: 10000, responseType: "text" });
    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(r.data);
  } catch(e) {
    console.error("❌ calendar-proxy:", e.message);
    res.status(500).send("Calendrier indisponible");
  }
});

app.get("/calendar", (req, res) => res.json({
  lastUpdate: calendarCache.lastUpdate?.toLocaleString("fr-FR"),
  content: calendarCache.content
}));

app.get("/bus", (req, res) => res.json({
  lastUpdate: remiCache.lastUpdate?.toLocaleString("fr-FR"),
  content: remiCache.content
}));

// ── Démarrage ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 MAT Serveur v6.5 démarré sur le port ${PORT}`);
  console.log(`📱 PWA MEL    : /mel`);
  console.log(`📰 Facebook   : feed only`);
  console.log(`🚨 Signalement: /signal`);
  console.log(`🔔 Push       : /push/subscribe`);
  console.log(`🌦️ Météo      : /meteo/commune`);
  console.log(`⚠️ Vigilance  : /meteo/vigilance`);

  // Délai de 20s avant les init réseau pour laisser le DNS Render se stabiliser
  setTimeout(() => {
    refreshCalendarCache().catch(e => console.warn("Calendar cache init:", e.message));
    refreshRemiCache().catch(e => console.warn("Remi cache init:", e.message));
  }, 20000);

  // Weather check initial après 30s (DNS + réseau garantis stables)
  setTimeout(() => {
    axios.get(`http://127.0.0.1:${PORT}/meteo/alertes/check`)
      .catch(e => console.warn("Weather check initial:", e.message));

    // Puis polling toutes les WEATHER_CHECK_INTERVAL_MS
    setInterval(async () => {
      try {
        await axios.get(`http://127.0.0.1:${PORT}/meteo/alertes/check`);
      } catch (e) {
        console.warn("Weather check auto:", e.message);
      }
    }, WEATHER_CHECK_INTERVAL_MS);
  }, 30000);
});
