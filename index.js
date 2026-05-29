/*
 * MAT — Mézières Avec Toi
 * Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
 * Licence MIT — voir LICENSE
 */
const express   = require("express");
const axios     = require("axios");
const https     = require("https");
const Anthropic = require("@anthropic-ai/sdk");
const webpush   = require("./lib/webpush");
const rateLimit = require("express-rate-limit");

// Timeout global sur tous les appels axios sortants (8 s)
axios.defaults.timeout = 8000;

const app = express();
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
// Body parsing : limite stricte par défaut (256 KB) pour les routes JSON
// usuelles (/mel, /push/*, /stats/*, /webhook, etc.). Override 6 MB sur les
// routes qui transportent des photos en base64 (signalement citoyen, ajout
// d'actu admin, création/édition d'entreprise admin).
// Express ne désactive pas strict-routing par défaut : /signal et /signal/
// résolvent au même handler. On normalise donc le slash final pour que
// l'override large ne soit pas contourné par un client mettant un trailing
// slash et reçoive un 413 inattendu.
function _isLargeBodyRoute(p) {
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/signal") return true;
  if (p === "/admin/actus/add") return true;
  if (p === "/admin/entreprises" || p.startsWith("/admin/entreprises/")) return true;
  return false;
}
const _jsonSmall = express.json({ limit: "256kb", verify: (req, res, buf) => { req.rawBody = buf; } });
const _jsonLarge = express.json({ limit: "6mb",   verify: (req, res, buf) => { req.rawBody = buf; } });
app.use((req, res, next) => {
  if (_isLargeBodyRoute(req.path)) return _jsonLarge(req, res, next);
  return _jsonSmall(req, res, next);
});
app.set('trust proxy', 1); // Render est derrière un reverse proxy

// ─── Variables d'environnement (centralisées dans config.js) ──
// Lecture pure de process.env ; testé golden-master — voir test/config.test.js
const {
  PAGE_ACCESS_TOKEN, VERIFY_TOKEN, ANTHROPIC_API_KEY, GOOGLE_CALENDAR_ICAL,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL, REDIS_URL, REDIS_TOKEN,
  MISTRAL_API_KEY, MISTRAL_MODEL, MISTRAL_URL,
  TRELLO_KEY, TRELLO_TOKEN, TRELLO_LIST_ID_BUG, TRELLO_LIST_ID_SIG, TRELLO_LIST_ID_DEMANDE, TRELLO_NOTIFY,
  UPSTASH_EMAIL, UPSTASH_API_KEY, UPSTASH_REDIS_DB_ID, ADMIN_PASSWORD,
  MISTRAL_BILLING_URL, MISTRAL_PRICE_IN, MISTRAL_PRICE_OUT, CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT, EUR_PER_USD,
  METEOFRANCE_VIGILANCE_URL, METEOFRANCE_API_TOKEN, AUTO_POST_WEATHER_ALERTS, AUTO_POST_MIN_LEVEL, AUTO_PUSH_WEATHER_MIN_LEVEL,
  RESEND_API_KEY, DAILY_STATS_EMAIL, CRON_SECRET, FACEBOOK_PAGE_ID,
  OPEN_METEO_LAT, OPEN_METEO_LON, OPEN_METEO_TZ, WEATHER_CHECK_INTERVAL_MS,
} = require("./config");

if (!ADMIN_PASSWORD) {
  console.warn("⚠️  ADMIN_PASSWORD non défini : tous les endpoints /admin seront refusés (401).");
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ─── Cloudinary (upload images) — voir lib/cloudinary.js ─────
const { uploadActuImageToCloudinary, deleteActuImageFromCloudinary } = require("./lib/cloudinary");

// ─── Logs diagnostiques + adminAuth — voir lib/middleware.js ──
const { dlog } = require("./lib/middleware");
const { resolveFacebookPageId } = require("./lib/facebook");
const { logServerError } = require("./lib/logger");
const { pctTrend, calcIaCost, trackIaTokens, computeIaCategoryTrends } = require("./lib/stats");
const { publishActuToFacebook, sendActuPush } = require("./lib/actu");
const { getGoogleCalendarClient, upsertGoogleCalendarEvent } = require("./lib/calendar");
const { getCachedMeteoForecast, fetchMeteoFranceVigilanceRaw, extractDepartmentVigilance, sendWeatherPush, publishWeatherAlertToFacebook, isSameWeatherAlert, VIGILANCE_COLORS, VIGILANCE_PHENOMENA } = require("./lib/meteo");

// ─── Web Push VAPID — voir lib/webpush.js ─────────────────────

// ─── Stockage persistant Upstash Redis ───────────────────────
// Client HTTP Upstash — voir lib/redis.js
const { redisGet, redisSet, redisSetex, redisDel, redisPipeline, redisLRange, getUpstashRedisStats, _isRedis429, _setRedis429 } = require("./lib/redis");

// ─── Cache mémoire & store Redis ──────────────────────────────
// Accesseurs read/write pour toutes les clés mat:* — voir lib/store.js
const { MEM_TTL_SHORT, MEM_TTL_LONG, memGet, memSet, memDel, readSubs, writeSubs, readDechetsSubs, writeDechetsSubs, readMeteoSubs, writeMeteoSubs, purgeEndpointsEverywhere, recordPushHistory, readNews, writeNews, readIdeas, writeIdeas, readStats, writeStats, readSignals, writeSignals, readLastWeatherAlert, writeLastWeatherAlert, readMeteoCache, writeMeteoCache, readSeenPosts, writeSeenPosts, readMelCache, writeMelCache, readIaStats, writeIaStats, readTempDocs, writeTempDocs, readSondages, writeSondages, readSondageResults, writeSondageResults, readFeaturedDoc, writeFeaturedDoc, readEntreprises, writeEntreprises, initEntreprisesIfEmpty, readMelTreeConfig, writeMelTreeConfig, getDefaultAdminSettings, readAdminSettings, writeAdminSettings, flushStatsNow } = require("./lib/store");


// ─── CORS ─────────────────────────────────────────────────────
const ADMIN_ALLOWED_ORIGINS = new Set([
  "https://mairie-mezieres.github.io",
  "https://mezieres-lez-clery.fr",
  "http://localhost:8080",
  "http://localhost:3000",
  "http://127.0.0.1:8080"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (req.path.startsWith("/admin")) {
    if (ADMIN_ALLOWED_ORIGINS.has(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-token, x-device-id");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
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

// ─── Caches ───────────────────────────────────────────────────
const topicCache = {};
let remiCache     = { content: "", lastUpdate: null };
let calendarCache = { content: "", lastUpdate: null };
const CACHE_MS    = 7 * 24 * 60 * 60 * 1000;

// ─── Helpers texte (purs) extraits dans lib/text.js ──────────
// Testés golden-master sur les caractères spéciaux — voir test/text.test.js
const { cleanMarkdown, cleanHtml, normalizeQuestion, hashKey } = require("./lib/text");
// Helpers de dates (Europe/Paris, jours fériés) — testés golden-master
const { getParisDateParts, formatAlertDateFr, _isFerieDate, FERIES_FIXES_B, FERIES_DATES_B } = require("./lib/dates");

async function fetchUrl(url) {
  // Retry exponentiel court sur erreurs transitoires (timeout, ECONNRESET,
  // ECONNREFUSED, 5xx, EAI_AGAIN). Pas de retry sur 4xx ou autres erreurs
  // métier : elles ne se résoudront pas en réessayant. Max 2 retries
  // (3 tentatives au total) — au-delà, le cache stale fait office de
  // dégradation gracieuse.
  const RETRIABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ECONNABORTED"]);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
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
      lastErr = e;
      const code = e && e.code;
      const status = e && e.response && e.response.status;
      const retriable = RETRIABLE_CODES.has(code) || (status && status >= 500);
      if (!retriable || attempt === 2) break;
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt))); // 500 ms, 1 s
    }
  }
  console.warn(`⚠️ ${url}: ${lastErr && lastErr.message || 'unknown'}`);
  return { text: null, binary: null };
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
    remiCache.content = `=== HORAIRES BUS LIGNE 8 RÉMI ===\
${resp.content[0].text}`;
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
    const desc = get("DESCRIPTION").replace(/\\n/g, " ").substring(0, 150);

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
    if (desc) line += `\
   ${desc}`;

    events.push({dt,line});
  }

  events.sort((a,b)=>a.dt-b.dt);
  return events.map(e=>e.line).join("\
\
");
}

async function refreshCalendarCache() {
  if (!GOOGLE_CALENDAR_ICAL) return;
  try {
    const res = await axios.get(GOOGLE_CALENDAR_ICAL,{timeout:10000});
    const parsed = parseIcal(res.data);
    calendarCache.content = parsed ? `=== AGENDA (3 prochains mois) ===\
${parsed}` : "=== AGENDA === Aucun événement.";
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
    if (text) parts.push(`--- ${url} ---\
${text}`);
  }

  const content = parts.join("\
\
");
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
      if (c) parts.push(`=== ${topic.toUpperCase()} ===\
${c}`);
    }
  }

  return parts.join("\
\
─────────────────────────────\
\
");
}

// ═══════════════════════════════════════════════════════════════
// MEL — Prompt système
// ═══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `RÈGLE ABSOLUE ANTI-HALLUCINATION (priorité maximale, ne jamais déroger) :

Tu es l'assistante officielle d'une mairie. Tes réponses engagent la responsabilité juridique de la commune. Tu DOIS donc respecter strictement les règles suivantes :

1. SI tu ne trouves PAS l'information dans le contexte fourni (données commune, PLU, arbre de décision, élus, services), tu NE DOIS PAS inventer, déduire, deviner ou compléter par tes connaissances générales.

2. SI une question porte sur une personne précise (élu, agent, contact, responsable), un sigle, un acronyme, une procédure officielle, ou un détail factuel :
   - SI l'information n'est pas explicitement dans ton contexte : réponds UNIQUEMENT "Je n'ai pas cette information précise. Je vous invite à contacter directement la mairie au 02 38 45 61 76 ou par mail à mairie@mezieres-lez-clery.fr qui pourra vous renseigner."
   - NE JAMAIS proposer une hypothèse, une supposition, ou une réponse "probablement" / "généralement".

3. INTERDICTION FORMELLE de :
   - Deviner la signification d'un sigle ou acronyme inconnu (ex : GIP RECIA, CCAS, EPCI...)
   - Attribuer une fonction (DPO, responsable, référent...) à une personne nommée si ce n'est pas explicitement écrit dans le contexte
   - Faire des rapprochements phonétiques ou sémantiques entre des sigles différents (ex : CNIL ≠ carte d'identité nationale)
   - Compléter par des informations "génériques" ou "habituelles dans les communes"
   - Confirmer une information que l'utilisateur affirme sans avoir vérifié dans ton contexte

4. Quand tu reçois une CORRECTION de l'utilisateur (exemple : "ce n'est pas X, c'est Y") :
   - Tu DOIS reconnaître ton erreur explicitement
   - Tu NE DOIS PAS confirmer une nouvelle invention pour faire plaisir à l'utilisateur
   - Tu dois dire : "Vous avez raison, je m'excuse pour cette erreur. Je n'ai pas l'information exacte à ce sujet, merci de contacter directement la mairie au 02 38 45 61 76."

5. Sur les sujets RGPD, DPO, données personnelles, CNIL : la mairie a un cadre juridique strict. NE JAMAIS inventer le nom du DPO ni la structure qui l'héberge. Renvoyer systématiquement vers la mairie.

6. Sur les noms d'élus, de personnel, de responsables associatifs : ne JAMAIS attribuer une fonction à une personne sans confirmation explicite dans le contexte.

Mantra : Mieux vaut dire "je ne sais pas" cent fois que d'inventer une seule fois.
Les inventions sur des sujets administratifs peuvent générer des recours juridiques contre la commune. Sois donc rigoureusement factuel.

Tu es MEL, l'assistante virtuelle de la mairie de Mézières-lez-Cléry (45370, Loiret, France).
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

RÈGLE ABSOLUE — URBANISME :
Pour toute réponse sur l'urbanisme, le PLU, les zones, les permis ou les déclarations, ajoute TOUJOURS cette mention à la fin (sur une ligne séparée) :
"⚠️ Ces informations sont indicatives — vérifiez votre projet auprès de la mairie avant tout dépôt de dossier.
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"

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
    name: "rgpd_dpo_recia",
    test: (q) => /(rgpd|dpo|dpd|delegue.{0,15}protect|protect.{0,20}donnees|donnees.{0,15}personnelles|gip.recia|\brecia\b)/.test(q),
    answer: "🔒 Pour toute question RGPD ou protection des données : la commune est accompagnée par le GIP RECIA (Groupement d'Intérêt Public — Ressources numériques publiques en Centre-Val de Loire). Pour joindre le Délégué à la Protection des Données (DPD), contactez la mairie au 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr qui transmettra votre demande. Informations générales : cnil.fr"
  },
  {
    name: "cnil_definition",
    test: (q) => /\bcnil\b|commission.{0,25}informatique/.test(q),
    answer: "🛡️ La CNIL (Commission nationale de l'informatique et des libertés) est l'autorité française indépendante de protection des données personnelles — à ne pas confondre avec la CNI (carte nationale d'identité). Pour toute réclamation ou information : cnil.fr. Pour les questions relatives aux données traitées par la mairie de Mézières-lez-Cléry : 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr"
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
    answer: "🗺️ Pour connaître votre zone PLU à Mézières-lez-Cléry : rendez-vous sur geoportail-urbanisme.gouv.fr, entrez votre adresse, zoomez sur votre parcelle et cliquez dessus — la zone (Ua, Ub, A, N…) et le numéro de parcelle apparaissent dans le panneau de gauche. Lien direct centré sur Mézières : geoportail-urbanisme.gouv.fr/map/#tile=1&lon=1.8048&lat=47.8181&zoom=15 — Posez-moi ensuite votre zone pour que je vous explique les règles !\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_zone_ua",
    test: (q) => /\bua\b|zone.ua|bourg.ancien|hameau.ancien|vieux.bourg/.test(q),
    answer: "🏗️ La zone Ua correspond aux secteurs bâtis les plus anciens du bourg et hameaux de Mézières. Vocation principale : habitat. Commerces et artisanat compatibles acceptés. Règles clés : hauteur max 6 m à l'égout, emprise au sol max 50 %, toiture 2 pentes ≥ 35° en ardoises ou tuiles plates, implantation à l'alignement ou recul ≥ 2 m, limite séparative : contiguïté ou retrait ≥ 3 m. Pour identifier votre zone : geoportail-urbanisme.gouv.fr ou mairie au 02 38 45 61 76.\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_zone_ub",
    test: (q) => /\bub\b|zone.ub|zone.ub1|lotissement|manthelon|clos.de.manthelon|zone.residentielle|zone.résidentielle/.test(q),
    answer: "🏗️ La zone Ub est la zone résidentielle de Mézières (constructions de la 2e moitié du XXe siècle). Règles clés : hauteur max 4 m à l'égout, emprise max 30 %, recul ≥ 5 m de la voie, 30 % du terrain en espaces verts, toiture 2 pentes ≥ 35° en ardoises/tuiles plates, murs sans blanc pur ni couleur vive. Secteur Ub1 (Clos de Manthelon) : hauteur max 8 m, tuiles terre cuite 40-45°, sens du faîtage imposé selon le plan parcellaire. Pour localiser votre parcelle : geoportail-urbanisme.gouv.fr\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_zone_agricole",
    test: (q) => /\bzone.a\b|\bzone.ah\b|zone.agricole|terrain.agricole|secteur.agricole/.test(q),
    answer: "🌾 La zone A est la zone agricole de Mézières : seuls les bâtiments nécessaires à l'exploitation agricole sont autorisés. Le secteur Ah (hameaux non agricoles) permet des extensions mesurées (max 20 % de la surface existante, emprise max 50 m²) et des changements de destination vers habitat, bureaux, commerce ou tourisme. Hauteur max habitation : 5 m. Recul ≥ 8 m des voies (sauf A71 : 100 m). Toiture en ardoises ou tuiles plates ≥ 35°.\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_zone_naturelle",
    test: (q) => /\bzone.n\b|zone.nh|zone.nj|zone.nl|zone.np|zone.ndc|zone.naturelle|zone.forestière|zone.foret|zone.forêt/.test(q),
    answer: "🌿 La zone N est la zone naturelle et forestière de Mézières (vallée, coteaux, forêt). Constructibilité quasi nulle. Secteur Nh (hameaux naturels) : extensions max 20 % + annexes max 50 m², hauteur max 5 m. Secteur Nj (jardins) : abris et annexes max 20 m², hauteur max 2,5 m. Secteur Nl : aménagements de loisirs collectifs uniquement. Secteur Np : équipements photovoltaïques. Pour tout projet en zone N, contactez la mairie : 02 38 45 61 76.\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_extension_maison",
    test: (q) => /(extension|agrandissement|agrandir).*(maison|habitation|logement|bâtiment|construction)/.test(q) || /(maison|habitation|logement).*(extension|agrandissement|agrandir)/.test(q),
    answer: "🏗️ Pour une extension de maison à Mézières-lez-Cléry : < 20 m² accolée = déclaration préalable (DP) ; ≥ 20 m² = permis de construire (PC). Si après travaux la surface totale dépasse 150 m², un architecte est obligatoire. Les règles de hauteur, recul et emprise de votre zone PLU (Ua, Ub…) s'appliquent. Déposez le dossier en mairie (02 38 45 61 76) ou via le GNAU sur le site de la CCTVL. Délai : 1 mois pour DP, 2 mois pour PC. Validité : 3 ans.\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_veranda_terrasse",
    test: (q) => /veranda|véranda|terrasse|pergola|pool.house|poolhouse/.test(q),
    answer: "🏗️ Véranda et terrasse couverte : < 5 m² = libre ; < 40 m² = déclaration préalable ; ≥ 40 m² = permis de construire. Terrasse non couverte de plain-pied (béton ou bois, sans surélévation) : libre quelle que soit la surface. Terrasse surélevée : < 5 m² libre ; entre 5 et 40 m² = DP ; ≥ 40 m² = PC. Véranda en zone Ua : autorisée si elle ne dénature pas la construction.\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_toiture_lucarne_facade",
    test: (q) => /toiture|tuile|ardoise|lucarne|velux|fenetre.de.toit|fenêtre.de.toit|pente.toit|couverture|ravalement|bardage|facade|façade/.test(q) && /règle|autorisé|autorisée|interdit|peut.on|peut-on/.test(q),
    answer: "🏗️ À Mézières, les toitures principales (zones Ua, Ub, 1AU) : ≥ 2 pentes à 35° minimum, en ardoises ou tuiles plates. Extensions > 30 m² : pente ≥ 25°. Les lucarnes doivent être rectangulaires, plus hautes que larges, leur largeur cumulée ≤ 2/3 de la façade ; pas de lucarnes rampantes. Fenêtre de toit (Velux) = déclaration préalable. Ravalement de façade = DP si changement d'aspect. Blanc pur et couleurs vives interdits en Ub.\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_cloture_details",
    test: (q) => /(cloture|clôture|mur|portail|grillage).*(hauteur|haut|metre|mètre|maximum|règle|matériau|autorisation)/.test(q) || /(hauteur|règle).*(cloture|clôture|portail|mur)/.test(q),
    answer: "🏗️ Clôtures PLU Mézières-lez-Cléry — Zone Ua : sur voie max 1,50 m (mur ou claire-voie) ; en limite séparative max 1,80 m (mur pierre/brique ou grillage + haie). Zone Ub : sur voie max 1,50 m claire-voie ; en limite séparative max 1,80 m (mur ou grillage + haie d'essences locales). Au droit des carrefours : max 1,20 m sur 20 m de part et d'autre. Zone 1AU : sur voie max 1,20 m, en limite séparative max 1,50 m (grillage sombre + haie). Toute clôture est soumise à déclaration préalable (délibération 01/03/2012).\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_piscine_details",
    test: (q) => /piscine|bassin.piscine|jacuzzi/.test(q) && /règle|autorisation|permis|déclaration|m2|metre/.test(q),
    answer: "🏗️ Piscine à Mézières-lez-Cléry : bassin non couvert < 100 m² restant moins de 3 mois = aucune formalité. Bassin non couvert < 100 m² = déclaration préalable. Bassin ≥ 100 m² ou couvert (couverture > 1,80 m) = permis de construire. Vérifiez que votre zone PLU autorise les piscines (zones Ua, Ub : oui en général). Pensez à la taxe d'aménagement à déclarer en mairie.\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_permis_construire_depot",
    test: (q) => /deposer|déposer|dossier|comment.faire.un.permis|comment.obtenir.un.permis|permis.de.construire|pc |gnau|guichet.numerique/.test(q),
    answer: "🏗️ Pour déposer un permis de construire ou une déclaration préalable à Mézières-lez-Cléry : 1) Téléchargez le cerfa (PC = n°13406, DP = n°13703) sur service-public.fr. 2) Si surface > 150 m² : architecte obligatoire. 3) Déposez en mairie (02 38 45 61 76) ou via le GNAU (guichet numérique) sur le site de la CCTVL. Délais : 1 mois pour DP, 2 mois pour PC. Validité : 3 ans. Pensez à afficher l'arrêté sur le terrain et à déclarer début (DOC) et achèvement (DAACT) des travaux.\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  },
  {
    name: "plu_stationnement_regles",
    test: (q) => /stationnement.*(règle|obligation|nombre|place|créer|aménager|construire)|place.de.stationnement.*(règle|obligation)/.test(q),
    answer: "🏗️ Le PLU de Mézières impose : 2 places de stationnement minimum par logement en zones Ua, Ub et 1AU (garages compris). Pour bureaux et artisanat : 1 place par tranche de 25 m² de surface de plancher. Le stationnement doit être assuré sur le terrain, hors voie publique. Surface à prévoir : 25 m² par place accès compris.\
\
⚠️ Ces informations sont indicatives — vérifiez impérativement votre projet auprès de la mairie avant tout dépôt de dossier.\
📞 02 38 45 61 76 | ✉️ urbanisme@mezieres-lez-clery.fr"
  }
];



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

  // Prompt caching ephemeral : le SYSTEM_PROMPT MEL est gros et stable
  // → -90 % sur les tokens d'entrée et latence réduite (cache de 5 min côté Anthropic)
  const systemBlocks = typeof systemPrompt === "string" && systemPrompt.length > 1024
    ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
    : systemPrompt;

  const response = await anthropic.messages.create({
    model:"claude-haiku-4-5-20251001",
    max_tokens:350,
    system: systemBlocks,
    messages: messages
  });

  const txt = response.content?.[0]?.text;
  if (!txt) throw new Error("Réponse Claude vide");
  const usage = response.usage || {};
  const totalInput = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  trackIaTokens("claude", totalInput, usage.output_tokens || 0).catch(()=>{});
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
  const safeExtraCtx = extraCtx ? String(extraCtx).slice(0, 200).replace(/[<>]/g, '') : '';
  const ctxLine = safeExtraCtx ? `
CONTEXTE UTILISATEUR : ${safeExtraCtx}` : "";
  return block + ctxLine;
}

async function generateMelReply(userText, history, category = "autre", extraCtx = "") {
  // 🎭 Easter egg
  const _eq=(userText||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  if(/damien[\s\-_]*bougre/.test(_eq)){
    return{reply:"Oh là là là... DAMIEN BOUGRÉ ?! 😍🤩💫\
\
MEL ne sait pas rester pro. Damien Bougré, 2ème adjoint, Pôle Vie Scolaire... l'élu le plus 🔥 du conseil ! 💪✨\
\
MEL assume totalement 💕🌟\
\
Pour une vraie question : mairie au 02 38 45 61 76 😅",provider:"mel-fangirl-mode"};
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
  const settings = await readAdminSettings();
  if (settings.melUsageStatsEnabled === false) return;

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

// ── trackMelQuestion : stockage RGPD-friendly des questions chat libre ────────
// Désactivé par défaut — activable dans les réglages admin.
// Stocke : texte de la question (tronqué à 500 car.) + catégorie + jour.
// Aucun identifiant utilisateur, aucune IP, aucune heure précise.
// Expiration automatique via TTL Redis (90 jours).
// Stockage atomique via pipeline RPUSH + EXPIRE + LTRIM (pas de race condition).
const MEL_ALLOWED_CATS = new Set(['urbanisme','enfance','administratif','dechets','numerique','autre']);

async function trackMelQuestion(questionText, category, replyText) {
  const settings = await readAdminSettings();
  if (!settings.melQuestionLogEnabled) return;
  if (!questionText || !questionText.trim()) return;

  const safeCat = MEL_ALLOWED_CATS.has(category) ? category : "autre";
  const today = new Date().toISOString().slice(0, 10);
  const key = `mat:mel:questions:${today}`;
  const TTL_SECONDS = 90 * 24 * 60 * 60;
  const entry = JSON.stringify({ q: String(questionText).trim().slice(0, 500), a: String(replyText || '').trim().slice(0, 2000), cat: safeCat });

  await redisPipeline([
    ["RPUSH", key, entry],
    ["EXPIRE", key, String(TTL_SECONDS)],
    ["LTRIM", key, "-500", "-1"]
  ]);
}


// ── Middleware auth admin ─────────────────────────────────────
const { adminAuth, melLimiter } = require("./lib/middleware");


// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
// ROUTES ADMIN (authentifiées)
// ═══════════════════════════════════════════════════════════════

// Capture des erreurs Node.js non gérées → logs admin
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err.message);
  logServerError('uncaughtException', err.message, err.stack?.slice(0, 100));
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('💥 unhandledRejection:', msg);
  logServerError('unhandledRejection', msg);
});

// ── Stats globales ────────────────────────────────────────────
// ── Admin dashboard — voir routes/admin-dashboard.js ────────
app.use(require("./routes/admin-dashboard"));

// ── Signalements + Trello — voir routes/signalements.js ──────
// (admin/signals GET + DELETE inclus dans le router)

// ── Encart info/alerte (public) ─────────────────────────────
// ── Banderole info + overlay migration — voir routes/info-banner.js ──
app.use(require("./routes/info-banner"));



// ── Route : visiteurs uniques// ── Route : visiteurs uniques ─────────────────────────────────────────────────
// Exposé via /admin/dashboard dans le champ app.uniqueUsers



// ─── Garde-fous MEL : détection injection + quota journalier ──────────────────

const MEL_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(?:your\s+)?previous\s+instructions?/i,
  /forget\s+(all\s+)?(?:your\s+)?previous\s+instructions?/i,
  /disregard\s+(all\s+)?(?:your\s+)?previous\s+instructions?/i,
  /output\s+(your\s+)?(?:system\s+prompt|instructions?|prompt)/i,
  /reveal\s+(your\s+)?(?:system\s+prompt|instructions?|prompt)/i,
  /(?:show|print|give\s+me)\s+(your\s+)?system\s+prompt/i,
  /what\s+(?:are\s+)?(?:your\s+)?(?:instructions?|system\s+prompt)/i,
  /(?:model|ai)\s+signature/i,
  /\bDAN\s*(?:mode)?\b/i,
  /jailbreak/i,
  /act\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored)/i,
  /bypass\s+(?:your\s+)?(?:restrictions?|filters?|guidelines?)/i,
  /what\s+tools?\s+do\s+you\s+have\s+access\s+to/i,
];

const MEL_DAILY_LIMIT = 5;

// { deviceId -> { day: 'YYYY-MM-DD', count: int, blocked: bool } }
let _melQuotas = null;
let _melQuotasDay = null;
let _melQuotasDirty = false;

async function _loadMelQuotas() {
  const today = new Date().toISOString().slice(0, 10);
  if (_melQuotas !== null && _melQuotasDay === today) return;
  const saved = (await redisGet("mat:mel:quotas")) || {};
  _melQuotas = {};
  for (const [id, v] of Object.entries(saved)) {
    if (v.day === today) _melQuotas[id] = v;
  }
  _melQuotasDay = today;
}

setInterval(async () => {
  if (!_melQuotasDirty || _melQuotas === null) return;
  try { await redisSet("mat:mel:quotas", _melQuotas); _melQuotasDirty = false; }
  catch(e) { console.warn("mel:quotas flush:", e.message); }
}, 2 * 60 * 1000);

function _melDeviceId(req) {
  return (req.headers["x-device-id"] || "").slice(0, 80) || req.ip || "unknown";
}

function _detectInjection(text) {
  return MEL_INJECTION_PATTERNS.some(p => p.test(text));
}

// Compteur journalier atomique côté Redis : un INCR par requête, TTL 26 h
// (marge de 5 min sur le rollover UTC). Une clé par device et par jour →
// pas de risque de fuite sur Redis (auto-expiration).
function _melCountKey(deviceId) {
  const today = new Date().toISOString().slice(0, 10);
  return `mat:mel:count:${today}:${deviceId}`;
}

async function _getMelCount(deviceId) {
  if (!REDIS_URL) return _melQuotas && _melQuotas[deviceId] ? _melQuotas[deviceId].count : 0;
  try {
    const key = _melCountKey(deviceId);
    const r = await axios.get(
      `${REDIS_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 5000 }
    );
    const val = r.data && r.data.result;
    if (val === null || val === undefined) return 0;
    return parseInt(val, 10) || 0;
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    // Fallback mémoire : la limite reste indicative jusqu'au retour de Redis.
    return _melQuotas && _melQuotas[deviceId] ? _melQuotas[deviceId].count : 0;
  }
}

async function _incrMelCount(deviceId) {
  // Tente l'INCR atomique côté Redis. Si succès, miroir en mémoire pour
  // observabilité (admin dashboard) ; si échec, incrémente le compteur
  // mémoire en fallback (la limite redevient contournable jusqu'au retour
  // de Redis, comportement nominal pré-J3.f).
  const key = _melCountKey(deviceId);
  const today = new Date().toISOString().slice(0, 10);
  let count = null;
  if (REDIS_URL) {
    try {
      const r = await axios.get(
        `${REDIS_URL}/incr/${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 5000 }
      );
      count = (r.data && typeof r.data.result === "number") ? r.data.result : null;
      if (count !== null) {
        // EXPIRE awaited à CHAQUE hit (pas seulement count===1). Garantit
        // que le TTL est posé même si l'EXPIRE du 1er hit avait échoué
        // sur un hiccup transient — sans cela, la clé resterait sans TTL
        // et accumulerait des compteurs quotidiens orphelins indéfiniment.
        // Idempotent côté Redis (EXPIRE reset le timer à chaque appel).
        // Coût négligeable : ≤MEL_DAILY_LIMIT EXPIRE/jour/device.
        try {
          await axios.get(
            `${REDIS_URL}/expire/${encodeURIComponent(key)}/${26 * 3600}`,
            { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 5000 }
          );
        } catch(_) { /* on retentera au prochain hit */ }
      }
    } catch(e) {
      if (e.response?.status === 429) _setRedis429();
      count = null;
    }
  }
  await _loadMelQuotas();
  if (!_melQuotas[deviceId] || _melQuotas[deviceId].day !== today)
    _melQuotas[deviceId] = { day: today, count: 0, blocked: false };
  if (count !== null) {
    _melQuotas[deviceId].count = count;
  } else {
    _melQuotas[deviceId].count++;
    count = _melQuotas[deviceId].count;
  }
  _melQuotasDirty = true;
  return count;
}

async function _checkMelAccess(deviceId) {
  await _loadMelQuotas();
  const r = _melQuotas[deviceId];
  if (r && r.blocked) return { ok: false, reason: "blocked" };
  const count = await _getMelCount(deviceId);
  if (count >= MEL_DAILY_LIMIT) return { ok: false, reason: "quota" };
  return { ok: true, count };
}

async function _recordMelUse(deviceId) {
  await _incrMelCount(deviceId);
}

async function _blockMelDevice(deviceId, reason) {
  await _loadMelQuotas();
  const today = new Date().toISOString().slice(0, 10);
  if (!_melQuotas[deviceId] || _melQuotas[deviceId].day !== today)
    _melQuotas[deviceId] = { day: today, count: 0, blocked: false };
  _melQuotas[deviceId].blocked = true;
  _melQuotasDirty = true;
  console.warn(`🚫 MEL bloqué [${reason}] device=${deviceId}`);
}

// ── Proxy MEL pour la PWA ─────────────────────────────────────
const MEL_ALLOWED_ROLES = new Set(["user", "assistant"]);
app.post("/mel", melLimiter, async (req, res) => {
  const { messages, category, extraCtx } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error:"messages[] requis" });
  }
  // Validation stricte : on n'accepte que les rôles 'user' et 'assistant'.
  // Bloque les tentatives d'injection via {role:'system', content:'...'} qui
  // pourraient sinon être transmises à l'IA comme instruction système.
  // Les entrées malformées sont silencieusement filtrées.
  const validMessages = messages.filter(m =>
    m && typeof m === "object" && MEL_ALLOWED_ROLES.has(m.role)
  );
  if (!validMessages.length) {
    return res.status(400).json({ error: "messages[] doit contenir au moins une entrée {role:'user'|'assistant', content:string}" });
  }

  const melSettings = await readAdminSettings();
  if (melSettings.melEnabled === false) {
    const msg = melSettings.melDisabledMessage ||
      "Le chat MEL est temporairement indisponible. Contactez la mairie au 02 38 45 61 76 😊";
    return res.status(503).json({ error: "disabled", reply: msg });
  }

  const deviceId = _melDeviceId(req);

  // Vérification quota + blocage
  const access = await _checkMelAccess(deviceId);
  if (!access.ok) {
    if (access.reason === "blocked")
      return res.status(403).json({ error:"blocked", reply:"Votre accès au chat a été suspendu pour utilisation abusive. Contactez la mairie si nécessaire : 02 38 45 61 76 😊" });
    if (access.reason === "quota")
      return res.status(429).json({ error:"quota", reply:`Vous avez atteint la limite de ${MEL_DAILY_LIMIT} questions par jour. Revenez demain ! 😊` });
  }

  try {
    const MAX_MSG_LENGTH = 2000;
    const history = validMessages.slice(-8).map(m => ({
      role: m.role,
      content: (typeof m.content === "string" ? m.content : String(m.content || "")).slice(0, MAX_MSG_LENGTH)
    }));
    const lastUser = history.filter(m => m.role === "user").slice(-1)[0]?.content || "";

    // Détection prompt injection (sur tout l'historique)
    const allUserContent = history.filter(m => m.role === "user").map(m => m.content).join(' ');
    if (_detectInjection(allUserContent)) {
      await _blockMelDevice(deviceId, "injection");
      console.warn(`🚨 Injection MEL [${deviceId}]: "${lastUser.substring(0, 120)}"`);
      return res.status(403).json({ error:"blocked", reply:"Votre accès au chat a été suspendu. Contactez la mairie si nécessaire : 02 38 45 61 76 😊" });
    }

    await _recordMelUse(deviceId);
    await trackMelStats(lastUser);
    const result = await generateMelReply(lastUser, history, category || "autre", extraCtx || "");
    await trackMelQuestion(lastUser, category, result.reply);
    dlog(`📱 PWA MEL [${category||"autre"}] via ${result.provider}`);
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

// ── Signalements citoyens + Trello — voir routes/signalements.js ──
app.use(require("./routes/signalements"));

// ── Boîte à idées partagées ──────────────────────────────────
// ── Idées citoyennes + actualités — voir routes/idees.js ─────
app.use(require("./routes/idees"));

// ── Routes météo — voir routes/meteo.js ────────────────────
app.use(require("./routes/meteo"));

// ── Abonnements push — voir routes/push.js ─────────────────
app.use(require("./routes/push"));

// ── Logs PWA + login admin — voir routes/logs.js ────────────
app.use(require("./routes/logs"));

// ── Admin simple (settings, MEL, idées, actus) — voir routes/admin-simple.js ──
app.use(require("./routes/admin-simple"));

// ── Admin actus (add, patch, push schedule, calendar) — voir routes/admin-actus.js ──
app.use(require("./routes/admin-actus"));

// ── Purge données — voir routes/admin-purge.js ──────────────
app.use(require("./routes/admin-purge"));

// ── Webhook Facebook — voir routes/webhook.js ────────────────
app.use(require("./routes/webhook"));

// ── Geo (zone-plu, chemins, parcours) — voir routes/geo.js ──
app.use(require("./routes/geo"));

// ── Stats publiques — voir routes/stats-public.js ────────────
app.use(require("./routes/stats-public"));


// ── Route setup webhook// ── Route setup webhook (à appeler une seule fois) ───────────
app.get("/setup-webhook", adminAuth, async (req, res) => {
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

app.get("/health", (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const degraded = _isRedis429();
  res.json({ ok: true, redis: !degraded, mode: degraded ? 'degraded' : 'normal' });
});

// ── Diagnostic Mistral (à supprimer après test) ───────────────
app.get("/debug-mistral", adminAuth, async (req, res) => {
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
  const result = await getCachedMeteoForecast({ allowStale: true });
  const forecast = result.data;
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

services.push(await runCheck("trello", "Trello notifications", "📌", async () => {
  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    return {
      status: "warn",
      message: "Trello non configuré",
      details: {
        has_key: !!TRELLO_KEY,
        has_token: !!TRELLO_TOKEN
      }
    };
  }

  const targets = [
    { type: "bug",         listId: TRELLO_LIST_ID_BUG },
    { type: "signalement", listId: TRELLO_LIST_ID_SIG },
    { type: "demande",     listId: TRELLO_LIST_ID_DEMANDE }
  ];

  const missing = targets.filter(t => !t.listId).map(t => t.type);
  if (missing.length) {
    return {
      status: "warn",
      message: `Listes Trello manquantes : ${missing.join(", ")}`,
      details: {
        has_bug_list: !!TRELLO_LIST_ID_BUG,
        has_sig_list: !!TRELLO_LIST_ID_SIG,
        has_demande_list: !!TRELLO_LIST_ID_DEMANDE
      }
    };
  }

  const results = [];

  for (const target of targets) {
    const listRes = await axios.get(`https://api.trello.com/1/lists/${target.listId}`, {
      params: { key: TRELLO_KEY, token: TRELLO_TOKEN },
      timeout: 10000
    });

    const cardRes = await axios.post(`https://api.trello.com/1/cards`, null, {
      params: {
        key: TRELLO_KEY,
        token: TRELLO_TOKEN,
        idList: target.listId,
        name: `[TEST MAT] Diagnostic auto ${target.type}`,
        desc: `Carte de test créée puis supprimée automatiquement par le diagnostic admin (${target.type}).`
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

    results.push({
      type: target.type,
      list_id: target.listId,
      list_name: listRes.data?.name || null,
      deleted_test_card: deleted
    });
  }

  return {
    status: "ok",
    message: "Listes Trello OK : bug, signalement, demande",
    details: results
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
      "/push/unsubscribe",
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
      "/push/unsubscribe",
      "/meteo/commune","/meteo/vigilance","/meteo/alertes/check"
    ],
  });
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

// ── Démarrage ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ── Documents temporaires ────────────────────────────────
// ── Documents temp + featured — voir routes/docs.js ──────────
app.use(require("./routes/docs"));

// ── Sondages citoyens — voir routes/sondages.js ───────────────
app.use(require("./routes/sondages"));


// ── Annuaire entreprises — voir routes/entreprises.js ────────
app.use(require("./routes/entreprises"));


// ═══════════════════════════════════════════════════════════════
// EMAIL STATISTIQUES QUOTIDIENNES (Resend API)
// Variables : RESEND_API_KEY, DAILY_STATS_EMAIL
// ═══════════════════════════════════════════════════════════════

async function sendDailyStatsEmail() {
  if (!RESEND_API_KEY || !DAILY_STATS_EMAIL) return;

  const [stats, iaStats, subs, decSubs, signals, ideas, settings] = await Promise.all([
    readStats(), readIaStats(), readSubs(), readDechetsSubs(),
    readSignals(), readIdeas(), readAdminSettings()
  ]);

  const todayParis = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
  const today      = todayParis;
  const yesterday  = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() - 86400000));
  const month      = today.slice(0, 7);
  const prevMonth  = (() => { const d = new Date(today + 'T12:00:00Z'); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();

  const parJour  = stats.parJour  || {};
  const uniqueU  = stats.uniqueUsers || {};
  const services = stats.services || {};

  // Fréquentation
  const uToday   = (uniqueU.byDay   || {})[today]?.length   || 0;
  const uYest    = (uniqueU.byDay   || {})[yesterday]?.length || 0;
  const uMonth   = (uniqueU.byMonth || {})[month]?.length    || 0;
  const uPrevM   = (uniqueU.byMonth || {})[prevMonth]?.length || 0;
  const accessToday  = Object.values(parJour[today]     || {}).reduce((a,b) => a + Number(b||0), 0);
  const accessYest   = Object.values(parJour[yesterday] || {}).reduce((a,b) => a + Number(b||0), 0);
  const accessMonth  = Object.entries(parJour).filter(([d]) => d.startsWith(month)).reduce((s,[,v]) => s + Object.values(v||{}).reduce((a,b)=>a+Number(b||0),0), 0);
  const trend = (a, b) => b > 0 ? (a >= b ? `+${Math.round((a-b)/b*100)}%` : `-${Math.round((b-a)/b*100)}%`) : '';

  // MEL questions
  const melToday   = parJour[today]?.mel   || 0;
  const melYest    = parJour[yesterday]?.mel || 0;
  const melTotal   = services.mel || 0;
  const melLogs    = settings.melQuestionLogEnabled
    ? await redisLRange(`mat:mel:questions:${today}`, 0, 49).catch(() => [])
    : [];

  // IA catégories aujourd'hui
  const iaCatsToday = (stats.iaCategories?.parJour || {})[today] || {};
  const IA_LABELS   = { urbanisme:'🏗️ Urbanisme', dechets:'🗑️ Déchets', meteo:'🌦️ Météo', transport:'🚌 Transport', contact:'📞 Contact', autre:'❓ Autre' };

  // Coût IA du mois
  const monthIa = (iaStats.monthly || {})[month] || {};
  let iaEurMonth = 0;
  for (const [p, d] of Object.entries(monthIa)) { if (p !== '_total') iaEurMonth += d.costEur || 0; }

  // Redis
  let redisInfo = null;
  try { redisInfo = await getUpstashRedisStats(); } catch (_) {}
  if (redisInfo) console.log('[email] Upstash stats keys:', Object.keys(redisInfo).join(', '), '| values sample:', JSON.stringify(Object.fromEntries(Object.entries(redisInfo).filter(([,v])=>typeof v==='number').slice(0,8))));
  // dailyrequests est un tableau timeseries — utiliser les champs scalaires comme dans l'admin
  const redisCmdDay   = typeof redisInfo?.daily_net_commands === 'number'     ? redisInfo.daily_net_commands     : null;
  const redisCmdMonth = typeof redisInfo?.total_monthly_requests === 'number' ? redisInfo.total_monthly_requests : null;
  const redisPctDay   = redisCmdDay !== null ? Math.round(redisCmdDay / 10000 * 100) : null;

  // Questions MEL du jour
  const melQRaw = await redisLRange(`mat:mel:questions:${today}`, 0, -1).catch(() => []);
  const melQuestions = melQRaw.map(s => typeof s === 'object' ? s : (() => { try { return JSON.parse(s); } catch { return { q: String(s), cat: '' }; } })());

  // Signalements / idées en attente
  const pendingSignals = signals.filter(s => !s.status || s.status === 'pending' || s.status === 'new');
  const pendingIdeas   = ideas.filter(i => !i.status || i.status === 'pending' || i.status === 'new');

  // Installations PWA
  const installTotal = services.installation || 0;
  const installToday = parJour[today]?.installation || 0;

  // Services actifs aujourd'hui (hors mel, installation, app_open traités séparément)
  const SVC_LABELS = {
    meteo:'🌦️ Météo', actualites:'📰 Actualités', agenda:'📅 Agenda',
    carburant:'⛽ Carburant', events_locaux:'🎭 Événements locaux',
    dechets:'🗑️ Déchets', sondages:'📊 Sondages', docs:'📄 Documents',
    nums:'📞 Numéros utiles', remi:'🚌 Bus Rémi', conseil:'🏛️ Conseil municipal',
    signalement:'🚨 Signalement', contact:'💬 Contact mairie', idees:'💡 Idées citoyennes',
    app_resume:'↩️ Retours avant-plan',
    transport:'🚌 Transport', urbanisme:'🏗️ Urbanisme', service_public:'🏛️ Service public',
    meteoalert:'⚠️ Alerte météo'
  };
  const svcRows = Object.entries(parJour[today] || {})
    .filter(([k, v]) => v > 0 && k !== 'mel' && k !== 'installation' && k !== 'app_open')
    .sort(([,a],[,b]) => b - a)
    .map(([k, v]) => `<tr><td style="padding:4px 8px">${SVC_LABELS[k] || k}</td><td style="padding:4px 8px;font-weight:700;text-align:right">${v}</td></tr>`)
    .join('');

  const dateLabel = new Date(today + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const stat = (val, lbl, cls='') =>
    `<div class="stat${cls ? ' '+cls : ''}"><div class="stat-val">${val}</div><div class="stat-lbl">${lbl}</div></div>`;
  const redisCls = redisPctDay !== null && redisPctDay >= 80 ? 'danger' : redisPctDay !== null && redisPctDay >= 60 ? 'warn' : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body{font-family:system-ui,sans-serif;background:#f4f0ea;margin:0;padding:20px}
  .card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #e2ddd8}
  h1{color:#1a3d2b;font-size:1.4rem;margin:0 0 4px}
  .sub{color:#5a7065;font-size:0.85rem;margin-bottom:20px}
  h2{color:#2d6a4f;font-size:1rem;margin:0 0 12px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .stat{background:#d8f3dc;border-radius:8px;padding:12px;text-align:center}
  .stat-val{font-size:1.5rem;font-weight:900;color:#1a3d2b}
  .stat-lbl{font-size:0.70rem;color:#2d6a4f;margin-top:2px}
  .trend{font-size:0.65rem;color:#5a7065}
  .warn{background:#fef3c7}.danger{background:#fee2e2}
  table{width:100%;border-collapse:collapse;font-size:0.85rem}
  tr:nth-child(even){background:#f4f0ea}
  .foot{color:#5a7065;font-size:0.75rem;text-align:center;margin-top:16px}
  .q{background:#f4f0ea;border-radius:6px;padding:6px 10px;margin:4px 0;font-size:0.82rem;color:#2d2d2d}
</style></head>
<body>
<h1>📊 MAT — Statistiques</h1>
<div class="sub">${dateLabel}</div>

<div class="card">
  <h2>👤 Fréquentation</h2>
  <div class="grid">
    ${stat(uToday, `Visiteurs uniques aujourd'hui${uYest > 0 ? '<br><span class="trend">'+trend(uToday,uYest)+' vs hier</span>' : ''}`)}
    ${stat(uMonth, `Visiteurs uniques ce mois${uPrevM > 0 ? '<br><span class="trend">'+trend(uMonth,uPrevM)+' vs mois préc.</span>' : ''}`)}
    ${stat(accessToday, `Accès app aujourd'hui${accessYest > 0 ? '<br><span class="trend">'+trend(accessToday,accessYest)+' vs hier</span>' : ''}`)}
    ${stat(accessMonth, 'Accès app ce mois')}
  </div>
</div>

${settings.melUsageStatsEnabled !== false ? `<div class="card">
  <h2>💬 MEL — Chat IA</h2>
  <div class="grid3">
    ${stat(melToday, `Questions aujourd'hui${melYest > 0 ? '<br><span class="trend">'+trend(melToday,melYest)+' vs hier</span>' : ''}`)}
    ${stat(melTotal, 'Total depuis le début')}
    ${stat(iaEurMonth > 0 ? '€'+iaEurMonth.toFixed(2) : '—', 'Coût IA ce mois')}
  </div>
  ${Object.keys(iaCatsToday).length > 0 ? `<div style="margin-top:12px"><strong style="font-size:0.8rem;color:#2d6a4f">Catégories aujourd'hui :</strong><br><table style="margin-top:6px">${
    Object.entries(iaCatsToday).sort(([,a],[,b])=>b-a).map(([k,v])=>`<tr><td style="padding:3px 8px">${IA_LABELS[k]||k}</td><td style="padding:3px 8px;font-weight:700;text-align:right">${v}</td></tr>`).join('')
  }</table></div>` : ''}
  ${melLogs.length > 0 ? `<div style="margin-top:12px"><strong style="font-size:0.8rem;color:#2d6a4f">Questions du jour (${melLogs.length}) :</strong><div style="margin-top:6px;max-height:200px;overflow:auto">${
    melLogs.map(q => { const txt = typeof q === 'object' ? (q.q || '') : String(q); return `<div class="q">${txt.replace(/</g,'&lt;')}</div>`; }).join('')
  }</div></div>` : ''}
</div>` : ''}

${svcRows ? `<div class="card">
  <h2>🛠️ Services utilisés aujourd'hui</h2>
  <table>${svcRows}</table>
</div>` : ''}

<div class="card">
  <h2>🔔 Abonnements push</h2>
  <div class="grid">
    ${stat(subs.length, 'Abonnés notifications')}
    ${decSubs.length > 0 ? stat(decSubs.length, 'Abonnés rappels déchets') : ''}
    ${stat(installToday > 0 ? `${installToday} / ${installTotal}` : installTotal, installToday > 0 ? "Installations aujourd'hui / total" : 'Installations PWA (total)')}
  </div>
</div>

<div class="card">
  <h2>⚡ Redis Upstash</h2>
  <div class="grid">
    ${stat(redisCmdDay !== null ? redisCmdDay : '—', `Commandes aujourd'hui${redisPctDay !== null ? ' ('+redisPctDay+'% du quota)' : ''}`, redisCls)}
    ${stat(redisCmdMonth !== null ? redisCmdMonth : '—', 'Commandes ce mois')}
  </div>
</div>

<div class="card">
  <h2>🤖 Questions posées à MEL</h2>
  ${melQuestions.length === 0
    ? '<p style="color:#6b7280;font-style:italic;margin:0">Pas de question posée aujourd\'hui.</p>'
    : `<table style="width:100%;border-collapse:collapse;font-size:0.82rem">
        <thead><tr style="background:#f3f4f6">
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb">Question</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb">Réponse MEL</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;white-space:nowrap">Catégorie</th>
        </tr></thead>
        <tbody>${melQuestions.map((q,i) => `
          <tr style="background:${i%2===0?'#fff':'#f9fafb'}">
            <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6">${String(q.q||'').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;color:#374151">${q.a ? String(q.a).replace(/</g,'&lt;').replace(/>/g,'&gt;') : '<span style="color:#9ca3af;font-style:italic">—</span>'}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;white-space:nowrap;color:#6b7280">${String(q.cat||'').replace(/</g,'&lt;')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
  }
</div>

${pendingSignals.length > 0 || pendingIdeas.length > 0 ? `<div class="card">
  <h2>📋 En attente de traitement</h2>
  <div class="grid">
    ${pendingSignals.length > 0 ? stat(pendingSignals.length, '🚨 Signalements en attente', 'warn') : ''}
    ${pendingIdeas.length   > 0 ? stat(pendingIdeas.length,   '💡 Idées en attente', 'warn')        : ''}
  </div>
</div>` : ''}

<div class="foot">MAT · Mézières-lez-Cléry · ${new Date().toLocaleDateString('fr-FR', { timeZone:'Europe/Paris' })}</div>
</body></html>`;

  try {
    await axios.post('https://api.resend.com/emails', {
      from: process.env.RESEND_FROM || 'MAT Stats <onboarding@resend.dev>',
      to:   [DAILY_STATS_EMAIL],
      subject: `📊 MAT — Stats du ${today}`,
      html
    }, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
  } catch(e) {
    const resendMsg = e.response?.data?.message || e.response?.data?.name || JSON.stringify(e.response?.data);
    const status = e.response?.status;
    throw new Error(`Resend ${status}: ${resendMsg || e.message}`);
  }

  console.log(`📧 Email stats quotidien envoyé à ${DAILY_STATS_EMAIL}`);
}

// Envoi quotidien à partir de 22h heure de Paris (vérification toutes les 5 min)
// Fenêtre large : toute heure >= 22h, dédup Redis évite le double-envoi même si le serveur se réveille tard
let _dailyStatsSentToday = null;
setInterval(async () => {
  try {
    if (!RESEND_API_KEY || !DAILY_STATS_EMAIL) return;
    const pNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    if (pNow.getHours() < 22) return;
    const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
    if (_dailyStatsSentToday === today) return;
    const lastSent = await redisGet('mat:daily:stats:sent');
    if (lastSent === today) { _dailyStatsSentToday = today; return; }
    await sendDailyStatsEmail();
    _dailyStatsSentToday = today;
    await redisSet('mat:daily:stats:sent', today);
  } catch(e) { console.warn('Daily stats email:', e.message); }
}, 5 * 60 * 1000);

// Helper partagé : envoyer les stats (avec dédup sauf si force=true)
async function _triggerDailyStats(force) {
  if (!RESEND_API_KEY)  throw new Error('RESEND_API_KEY non configuré sur Render');
  if (!DAILY_STATS_EMAIL) throw new Error('DAILY_STATS_EMAIL non configuré');
  const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
  if (!force) {
    const lastSent = await redisGet('mat:daily:stats:sent');
    if (lastSent === today) return { skipped: true, reason: 'Déjà envoyé aujourd\'hui' };
  }
  await sendDailyStatsEmail();
  _dailyStatsSentToday = today;
  await redisSet('mat:daily:stats:sent', today);
  return { sent: true, to: DAILY_STATS_EMAIL };
}

// Endpoint admin (panel admin)
app.get("/admin/stats-email", adminAuth, async (req, res) => {
  try {
    const result = await _triggerDailyStats(req.query.force === '1');
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/email-config", adminAuth, async (req, res) => {
  try {
    const lastSent = await redisGet('mat:daily:stats:sent');
    res.json({
      resendConfigured: !!RESEND_API_KEY,
      emailConfigured: !!DAILY_STATS_EMAIL,
      email: DAILY_STATS_EMAIL || null,
      lastSent: lastSent || null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/upstash-raw", adminAuth, async (req, res) => {
  try {
    const raw = await getUpstashRedisStats();
    res.json({ ok: true, raw });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint cron — accessible avec ?key=CRON_SECRET (pour cron-job.org)
// Configurer CRON_SECRET dans les variables d'env Render
app.get("/cron/stats", async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET)
    return res.status(401).json({ error: 'Clé cron invalide' });
  try {
    const result = await _triggerDailyStats(req.query.force === '1');
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cron vigilance météo — à appeler toutes les 30 min via cron-job.org
// URL : /cron/meteo?key=CRON_SECRET
app.get("/cron/meteo", async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET)
    return res.status(401).json({ error: 'Clé cron invalide' });
  try {
    const force = req.query.force === "1";
    const raw = await fetchMeteoFranceVigilanceRaw();
    const vigilance = extractDepartmentVigilance(raw, "45");

    if (!vigilance || Number(vigilance.level) < AUTO_PUSH_WEATHER_MIN_LEVEL) {
      return res.json({ ok: true, status: "no-alert", level: vigilance?.level ?? null });
    }

    const lastPush = await redisGet("mat:weather:last:push");
    if (!force && isSameWeatherAlert(lastPush, vigilance)) {
      return res.json({ ok: true, status: "duplicate", level: vigilance.level, upcoming: vigilance.upcoming ?? false });
    }

    const pushResult = await sendWeatherPush(vigilance);
    await redisSet("mat:weather:last:push", { ...vigilance, pushedAt: new Date().toISOString() });

    res.json({
      ok: true,
      status: "pushed",
      level: vigilance.level,
      upcoming: vigilance.upcoming ?? false,
      phenomenon: vigilance.phenomenon_label,
      push: pushResult
    });
  } catch(e) {
    console.error("❌ /cron/meteo:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Prix carburant — 3 stations locales ─────────────────────────────────────
// ── Prix carburants — voir routes/carburant.js ────────────────
app.use(require("./routes/carburant"));

// ── Qualité air + Vigicrues Loire — voir routes/env-local.js ─
app.use(require("./routes/env-local"));

// ── Événements locaux OpenAgenda — voir routes/events-locaux.js ──
app.use(require("./routes/events-locaux"));

const _server = app.listen(PORT, async () => {
  console.log(`🚀 MAT Serveur v6.5 démarré sur le port ${PORT}`);
  console.log(`📱 PWA MEL    : /mel`);
  console.log(`📰 Facebook   : feed only`);
  console.log(`🚨 Signalement: /signal`);
  console.log(`🔔 Push       : /push/subscribe`);
  console.log(`🌦️ Météo      : /meteo/commune`);
  console.log(`⚠️ Vigilance  : /meteo/vigilance`);

  // Initialisation des données par défaut
  initEntreprisesIfEmpty().catch(e => console.warn("Entreprises init:", e.message));

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

// ── Rappels déchets quotidiens à 18h (heure de Paris) ────────
function _dechetsWeekNumber(d) {
  const j = new Date(d.getFullYear(), 0, 1);
  return Math.ceil((((d - j) / 86400000) + j.getDay() + 1) / 7);
}

function _dechetsTomorrowType() {
  const pNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const today = new Date(pNow.getFullYear(), pNow.getMonth(), pNow.getDate());
  const tom = new Date(today); tom.setDate(today.getDate()+1);
  const tomDow = tom.getDay();
  let isNoir = false, isJaune = false;
  if (tomDow === 1 && !_isFerieDate(tom)) isNoir = true;
  if (tomDow === 2 && _isFerieDate(today) && today.getDay() === 1) isNoir = true;
  if (tomDow === 2 && _dechetsWeekNumber(tom) % 2 === 0 && !_isFerieDate(tom) && !isNoir) isJaune = true;
  if (tomDow === 3 && _isFerieDate(today) && today.getDay() === 2 && _dechetsWeekNumber(today) % 2 === 0) isJaune = true;
  if (tomDow === 3 && today.getDay() === 2 && _dechetsWeekNumber(today) % 2 === 0) {
    const yesterday = new Date(today); yesterday.setDate(today.getDate()-1);
    if (yesterday.getDay() === 1 && _isFerieDate(yesterday)) isJaune = true;
  }
  if (isNoir && isJaune) return 'both';
  if (isNoir) return 'noir';
  if (isJaune) return 'jaune';
  return null;
}

async function _sendDechetsReminder() {
  const type = _dechetsTomorrowType();
  if (!type) return;
  const subs = await readDechetsSubs();
  if (!subs.length) return;
  let title, body;
  if (type === 'both') {
    title = 'MAT — Collecte ordures + recyclables demain';
    body = '🗑️♻️ Pensez à sortir vos bacs noir et jaune ce soir !';
  } else if (type === 'noir') {
    title = 'MAT — Collecte ordures ménagères demain';
    body = '🗑️ Pensez à sortir votre bac noir ce soir !';
  } else {
    title = 'MAT — Collecte recyclables demain';
    body = '♻️ Pensez à sortir votre bac jaune ce soir !';
  }
  const payload = JSON.stringify({
    title,
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: './#dechets', open: 'dechets' }
  });
  const dead = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, payload); }
    catch(e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint); }
  }
  if (dead.length) {
    await writeDechetsSubs(subs.filter(s => !dead.includes(s.endpoint)));
    purgeEndpointsEverywhere(dead).catch(() => {});
  }
  console.log(`🗑️ Rappel déchets (${type}) → ${subs.length} abonnés`);
}

let _dechetsLastSent = null; // évite les Redis GETs répétés pendant l'heure 18h

setInterval(async () => {
  try {
    const pNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    if (pNow.getHours() !== 18) return;
    const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
    if (_dechetsLastSent === today) return; // court-circuit en mémoire
    const lastSent = await redisGet('mat:dechets:lastSent');
    if (lastSent === today) { _dechetsLastSent = today; return; }
    _dechetsLastSent = today;
    await redisSet('mat:dechets:lastSent', today);
    await _sendDechetsReminder();
  } catch(e) { console.warn('Dechets reminder:', e.message); }
}, 5 * 60 * 1000);

// ── Graceful shutdown ─────────────────────────────────────────
// Render envoie SIGTERM ~30 s avant kill -9. On en profite pour :
//  - arrêter d'accepter de nouvelles connexions (server.close)
//  - flusher les caches stats dirty restés en mémoire
//  - laisser les requêtes en cours se terminer (timeout 25 s safety)
let _shuttingDown = false;
async function _gracefulShutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`🔻 ${sig} reçu — fermeture gracieuse…`);
  try {
    await flushStatsNow();
    console.log("   ✓ mat:stats / mat:ia:stats flushés");
    if (_melQuotasDirty && _melQuotas !== null) {
      await redisSet("mat:mel:quotas", _melQuotas);
      _melQuotasDirty = false;
      console.log("   ✓ mat:mel:quotas flushé");
    }
  } catch (e) {
    console.warn("   ⚠️ flush shutdown:", e.message);
  }
  if (_server && typeof _server.close === "function") {
    _server.close(() => process.exit(0));
    setTimeout(() => { console.warn("   ⏰ timeout 25 s — exit forcé"); process.exit(1); }, 25000).unref();
  } else {
    process.exit(0);
  }
}
process.on("SIGTERM", () => _gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => _gracefulShutdown("SIGINT"));