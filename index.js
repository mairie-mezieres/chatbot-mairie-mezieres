// ════════════════════════════════════════════════════════════
// MAT — Mézières Avec Toi · Serveur Render v6.1
// ════════════════════════════════════════════════════════════
// Fonctions : Messenger MEL · Proxy PWA MEL · Signalement
//             Actus Facebook · Push notifications · Webhook FB
//             Stockage persistant via Upstash Redis
//             Météo Open-Meteo · Vigilance Météo-France
// ════════════════════════════════════════════════════════════

const express   = require("express");
const axios     = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const webpush   = require("web-push");

const app = express();
app.use(express.json({ limit: "10mb" }));

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

const METEOFRANCE_VIGILANCE_URL = process.env.METEOFRANCE_VIGILANCE_URL || process.env.METEOFRANCE_VIGILANCE || "";
const METEOFRANCE_API_TOKEN     = process.env.METEOFRANCE_API_TOKEN;
const AUTO_POST_WEATHER_ALERTS  = process.env.AUTO_POST_WEATHER_ALERTS === "true";
const AUTO_POST_MIN_LEVEL       = Number(process.env.AUTO_POST_MIN_LEVEL || 3);
const FACEBOOK_PAGE_ID          = process.env.FACEBOOK_PAGE_ID;
const OPEN_METEO_LAT            = Number(process.env.OPEN_METEO_LAT || 47.822);
const OPEN_METEO_LON            = Number(process.env.OPEN_METEO_LON || 1.808);
const OPEN_METEO_TZ             = process.env.OPEN_METEO_TZ || "Europe/Paris";
const WEATHER_CHECK_INTERVAL_MS = Number(process.env.WEATHER_CHECK_INTERVAL_MS || 15 * 60 * 1000);

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
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
  if (!REDIS_URL) {
    console.warn("REDIS_URL non configuré");
    return;
  }
  try {
    const encoded = encodeURIComponent(key);
    await axios.post(
      `${REDIS_URL}/set/${encoded}`,
      JSON.stringify(value),
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch(e) {
    console.warn(`Redis SET ${key}:`, e.message);
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

// ─── CORS ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
  dechets:        ["https://mezieres-lez-clery.fr/2018/10/25/gestion-des-dechets/","https://www.ccterresduvaldeloire.fr/dechets/"],
  urbanisme:      ["https://mezieres-lez-clery.fr/2020/09/12/regles-durbanisme/","https://mezieres-lez-clery.fr/2018/11/02/plan-local-durbanisme/","https://mezieres-lez-clery.fr/2024/02/04/permis-de-construire-et-declarations-prealables/"],
  scolaire:       ["https://mezieres-lez-clery.fr/2018/11/03/lecole-de-la-foret/","https://mezieres-lez-clery.fr/2018/11/01/le-restaurant-scolaire/","https://mezieres-lez-clery.fr/2018/10/29/creche-familiale-les-marmousets/","https://mezieres-lez-clery.fr/2018/10/30/centre-de-loisirs/"],
  associations:   ["https://mezieres-lez-clery.fr/les-associations/","https://mezieres-lez-clery.fr/2021/12/06/demande-subvention/"],
  dicrim:         ["https://mezieres-lez-clery.fr/2021/06/14/dicrim/"],
  randonnees:     ["https://mezieres-lez-clery.fr/2018/10/21/randonnees-pedestres/","https://mezieres-lez-clery.fr/2018/10/20/tourisme/"],
  assainissement: ["https://mezieres-lez-clery.fr/2020/06/12/assainissement/"],
  location:       ["https://mezieres-lez-clery.fr/2018/10/24/location-de-materiel/"],
  cctvl:          ["https://www.ccterresduvaldeloire.fr/presentation/","https://www.ccterresduvaldeloire.fr/competences/"],
};

const KEYWORDS = {
  transport:      ["bus","car","rémi","remi","ligne 8","transport","horaire","bréau","breau","arrêt","navette","orléans"],
  dechets:        ["déchet","dechet","poubelle","tri","recyclage","collecte","ordure","verre","papier","déchetterie","bac","compost"],
  urbanisme:      ["permis","construire","plu","urbanisme","zone","terrain","déclaration","préalable","construction","bâtir","parcelle"],
  scolaire:       ["école","ecole","cantine","restaurant scolaire","périscolaire","enfant","crèche","loisirs","garderie","marmousets"],
  associations:   ["association","asso","subvention","club","bénévole"],
  dicrim:         ["risque","danger","inondation","nucléaire","dicrim","catastrophe","alerte","sirène"],
  randonnees:     ["randonnée","rando","balade","promenade","chemin","circuit","vélo","forêt","nature"],
  assainissement: ["assainissement","spanc","fosse","eaux usées","raccordement"],
  location:       ["louer","location","matériel","salle","table","chaise","barnum"],
  demarches:      ["carte identité","passeport","naissance","mariage","décès","état civil","acte","certificat"],
  cctvl:          ["cctvl","intercommunalité","communauté de communes","terres du val"],
  agenda:         ["manifestation","fête","événement","agenda","concert","animation","sortie","calendrier"],
};

function detectTopics(text) {
  const lower = (text || "").toLowerCase();
  const topics = new Set(["mairie_general"]);
  for (const [topic, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => lower.includes(w))) topics.add(topic);
  }
  return [...topics];
}

// ─── Caches ───────────────────────────────────────────────────
const topicCache = {};
let remiCache     = { content: "", lastUpdate: null };
let calendarCache = { content: "", lastUpdate: null };
const CACHE_MS    = 7 * 24 * 60 * 60 * 1000;

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
  if (!binary) {
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
  const now = Date.now();
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

async function buildContext(userText) {
  const topics = detectTopics(userText);
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

const SYSTEM_PROMPT = `Tu es MEL (Mézières En Ligne), l'assistante virtuelle de la mairie de Mézières-lez-Cléry (45370, Loiret). Présente-toi sous le prénom MEL.

INFORMATIONS PERMANENTES :
📍 36 rue du bourg – 45370 MÉZIÈRES-LEZ-CLÉRY
📞 02 38 45 61 76 | ✉️ mairie@mezieres-lez-clery.fr | 🌐 mezieres-lez-clery.fr
🕐 Lundi 14h-17h30 / Mercredi sur RDV / Vendredi 8h30-11h30
CCTVL : 02 38 45 11 11 | ccterresduvaldeloire.fr

⚠️ BUS LIGNE 8 : La commune a DEUX arrêts : "Mairie" et "Le Bréau". Toujours préciser lequel.

INSTRUCTIONS :
- Français, convivial, concis (3-5 phrases max). Emojis pour structurer.
- Jamais de Markdown : pas de **, pas de *, pas de #.
- Si tu ne sais pas : "Toutes mes excuses 🙏 Romuald ou Fabrice vous répondront incessamment. Contactez-nous au 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr 😊"
- Ne jamais inventer.`;

function cleanMarkdown(text) {
  return (text || "")
    .replace(/\*\*(.+?)\*\*/g,"$1")
    .replace(/\*(.+?)\*/g,"$1")
    .replace(/#{1,6}\s/g,"")
    .trim();
}

const introductions = new Map();
function shouldIntroduce(senderId) {
  const today = new Date().toISOString().slice(0,10);
  if (introductions.get(senderId) !== today) {
    introductions.set(senderId, today);
    return true;
  }
  return false;
}

const INTRO_MESSAGE = "🌲 Bonjour ! Je suis MEL, l'assistante virtuelle de la mairie de Mézières-lez-Cléry. Comment puis-je vous aider ? 😊";
const conversations = new Map();

function getHistory(id) {
  if (!conversations.has(id)) conversations.set(id, []);
  return conversations.get(id);
}

function addToHistory(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > 6) h.splice(0, h.length-6);
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
    `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m,pressure_msl,precipitation,wind_gusts_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max,sunrise,sunset` +
    `&timezone=${encodeURIComponent(OPEN_METEO_TZ)}` +
    `&forecast_days=3`;

  const r = await axios.get(url, { timeout: 10000 });
  return r.data;
}

async function fetchMeteoFranceVigilanceRaw() {
  if (!METEOFRANCE_VIGILANCE_URL) {
    throw new Error("METEOFRANCE_VIGILANCE_URL non configurée");
  }

  const headers = {};
  if (METEOFRANCE_API_TOKEN) {
    headers.Authorization = `Bearer ${METEOFRANCE_API_TOKEN}`;
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
// ROUTES
// ═══════════════════════════════════════════════════════════════

// ── Webhook Facebook ──────────────────────────────────────────
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
      for (const event of entry.messaging || []) {
        const sid = event.sender.id;
        if (event.message?.text) {
          await handleMessage(sid, event.message.text);
        }
        if (event.postback?.payload === "GET_STARTED") {
          await sendMsg(sid, "🌲 Bonjour ! Je suis MEL, l'assistante virtuelle de la mairie de Mézières-lez-Cléry.\n\nJe peux vous renseigner sur les horaires, les démarches, le bus ligne 8, le PLU, l'agenda et bien plus !\n\nComment puis-je vous aider ? 😊");
        }
      }

      for (const change of entry.changes || []) {
        if (change.field === "feed" && change.value?.message) {
          const msg   = change.value.message;
          const photo = change.value.photo || null;
          if (msg.includes("#app-mezieres")) {
            console.log("📰 Publication #app-mezieres détectée");
            await handleFacebookPublication(msg, photo);
          }
        }
      }
    }
  }
});

// ── Traitement message Messenger ──────────────────────────────
async function handleMessage(senderId, userText) {
  try {
    await typingOn(senderId);
    if (shouldIntroduce(senderId)) await sendMsg(senderId, INTRO_MESSAGE);

    const context = await buildContext(userText);
    addToHistory(senderId, "user", userText);

    const response = await anthropic.messages.create({
      model:"claude-haiku-4-5-20251001",
      max_tokens:300,
      system:`${SYSTEM_PROMPT}\n\n─── CONTEXTE ───\n${context}\n────────────────`,
      messages:getHistory(senderId),
    });

    const reply = cleanMarkdown(response.content[0].text);
    addToHistory(senderId, "assistant", reply);
    await sendMsg(senderId, reply);
    console.log(`✅ Messenger | in:${response.usage.input_tokens} out:${response.usage.output_tokens}`);
  } catch(err) {
    console.error("❌", err.message);
    await sendMsg(senderId, "Désolé, difficulté technique. Contactez la mairie au 02 38 45 61 76 😊");
  }
}

// ── Helpers Messenger ─────────────────────────────────────────
async function sendMsg(to, text) {
  const chunks = text.length <= 1900 ? [text] : (text.match(/.{1,1900}/g) || []);
  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient:{id:to}, message:{text:chunk}, messaging_type:"RESPONSE" }
    ).catch(e => console.error("Messenger:", e.message));
  }
}

async function typingOn(to) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    { recipient:{id:to}, sender_action:"typing_on" }
  ).catch(() => {});
}

// ── Publication Facebook → stockage + push ────────────────────
async function handleFacebookPublication(msg, photoUrl) {
  const title = msg.replace(/#app-mezieres/gi,"").replace(/\s+/g," ").trim().substring(0,120);
  const actu  = {
    id: Date.now(),
    title,
    date: new Date().toLocaleDateString("fr-FR"),
    photo: photoUrl || null
  };

  const actus = await readNews();
  actus.unshift(actu);
  if (actus.length > 20) actus.splice(20);
  await writeNews(actus);
  console.log(`💾 Actu stockée: "${title}"`);

  const subs = await readSubs();
  console.log(`📱 Envoi push à ${subs.length} abonné(s)`);
  const payload = JSON.stringify({
    title:"📰 Radio Mézières",
    body:title.substring(0,80),
    icon:"./icon-192.png"
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
}

// ── Proxy MEL pour la PWA ─────────────────────────────────────
app.post("/mel", async (req, res) => {
  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error:"messages[] requis" });
  }

  try {
    const context = await buildContext(messages[messages.length-1]?.content || "");
    const response = await anthropic.messages.create({
      model:"claude-haiku-4-5-20251001",
      max_tokens:300,
      system:`${SYSTEM_PROMPT}\n\n─── CONTEXTE ───\n${context}\n────────────────`,
      messages:messages.slice(-6),
    });

    const reply = cleanMarkdown(response.content[0].text);
    console.log(`📱 PWA MEL | in:${response.usage.input_tokens} out:${response.usage.output_tokens}`);
    res.json({ reply });
  } catch(e) {
    console.error("❌ MEL proxy:", e.message);
    res.status(500).json({ reply:"Désolée, erreur technique. Contactez la mairie au 02 38 45 61 76 😊" });
  }
});

// ── Signalement citoyen → stockage Redis ─────────────────────
app.post("/signal", async (req, res) => {
  const { cat, desc, lat, lon, photoB64 } = req.body || {};
  const mapsLink = (lat && lon) ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=18` : null;

  const signal = {
    id: Date.now(),
    cat: cat || "Non précisée",
    desc: desc || "",
    lat, lon, mapsLink,
    hasPhoto: !!photoB64,
    date: new Date().toLocaleString("fr-FR"),
    dateISO: new Date().toISOString(),
  };

  const signals = await readSignals();
  signals.unshift(signal);
  if (signals.length > 100) signals.splice(100);
  await writeSignals(signals);
  console.log(`🚨 Signalement stocké #${signal.id}: ${cat}`);
  res.json({ success:true });
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
      fetchOpenMeteoForecast(),
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
    console.error("❌ /meteo/alertes/check:", e.message);
    res.status(500).json({ error: "Contrôle alerte impossible" });
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
  res.json({ success:true });
});

// ── Stats usage ──────────────────────────────────────────────
app.post("/stats/track", async (req, res) => {
  const { service } = req.body || {};
  if (!service) return res.status(400).json({ error: "service requis" });

  const stats = await readStats();
  const today = new Date().toISOString().slice(0, 10);

  if (!stats.services) stats.services = {};
  stats.services[service] = (stats.services[service] || 0) + 1;

  if (!stats.parJour) stats.parJour = {};
  if (!stats.parJour[today]) stats.parJour[today] = {};
  stats.parJour[today][service] = (stats.parJour[today][service] || 0) + 1;

  stats.totalAcces = (stats.totalAcces || 0) + 1;
  await writeStats(stats);

  res.json({ success: true });
});

app.get("/stats", async (req, res) => {
  const stats = await readStats();
  const parJour = stats.parJour || {};

  const installations = Object.entries(parJour)
    .sort(([a],[b]) => b.localeCompare(a))
    .slice(0, 30)
    .map(([date, svcs]) => ({
      date,
      installations: svcs.installation || 0,
      acces: Object.values(svcs).reduce((s,v)=>s+v,0)
    }));

  res.json({
    totalAcces:      stats.totalAcces || 0,
    totalInstalls:   stats.services?.installation || 0,
    parService:      stats.services || {},
    derniers30jours: installations,
  });
});

// ── Route setup webhook (à appeler une seule fois) ───────────
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
      { subscribed_fields: "feed,messages" },
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

app.get("/", async (req, res) => {
  const [subs, news, ideas, signals] = await Promise.all([
    readSubs(), readNews(), readIdeas(), readSignals()
  ]);

  res.json({
    status:  "MAT est en ligne 🌲",
    version: "6.1 — Messenger + PWA + Signalement + Push + Actus + Stats + Météo",
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
  console.log(`🚀 MAT Serveur v6.1 démarré sur le port ${PORT}`);
  console.log(`📡 Messenger  : /webhook`);
  console.log(`📱 PWA MEL    : /mel`);
  console.log(`🚨 Signalement: /signal`);
  console.log(`📋 Consulter  : /signalements`);
  console.log(`🔔 Push       : /push/subscribe`);
  console.log(`📰 Actus      : /actus`);
  console.log(`🌦️ Météo      : /meteo/commune`);
  console.log(`⚠️ Vigilance  : /meteo/vigilance`);
  console.log(`📣 Vérif auto : /meteo/alertes/check`);

  await refreshCalendarCache();
  await refreshRemiCache();

  try {
    await axios.get(`http://127.0.0.1:${PORT}/meteo/alertes/check`);
  } catch (e) {
    console.warn("Weather check initial:", e.message);
  }

  setInterval(async () => {
    try {
      await axios.get(`http://127.0.0.1:${PORT}/meteo/alertes/check`);
    } catch (e) {
      console.warn("Weather check auto:", e.message);
    }
  }, WEATHER_CHECK_INTERVAL_MS);
});
