const express  = require("express");
const axios    = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

// ─── Configuration ─────────────────────────────────────────────────────────────
const PAGE_ACCESS_TOKEN    = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN         = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CALENDAR_ICAL = process.env.GOOGLE_CALENDAR_ICAL;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Sources par sujet ─────────────────────────────────────────────────────────
const SOURCES = {
  mairie_general: [
    "https://mezieres-lez-clery.fr/",
    "https://mezieres-lez-clery.fr/2018/11/03/les-services-municipaux/",
    "https://mezieres-lez-clery.fr/2018/10/23/numeros-utiles/",
    "https://mezieres-lez-clery.fr/2018/10/22/presentation-de-la-commune/",
    "https://mezieres-lez-clery.fr/2018/11/04/le-conseil-municipal/",
  ],
  demarches: [
    "https://mezieres-lez-clery.fr/2018/10/25/178/",
    "https://mezieres-lez-clery.fr/2021/03/13/fiche-pratique/",
  ],
  dechets: [
    "https://mezieres-lez-clery.fr/2018/10/25/gestion-des-dechets/",
    "https://www.ccterresduvaldeloire.fr/dechets/",
  ],
  urbanisme: [
    "https://mezieres-lez-clery.fr/2020/09/12/regles-durbanisme/",
    "https://mezieres-lez-clery.fr/2018/11/02/plan-local-durbanisme/",
    "https://mezieres-lez-clery.fr/2024/02/04/permis-de-construire-et-declarations-prealables/",
  ],
  scolaire: [
    "https://mezieres-lez-clery.fr/2018/11/03/lecole-de-la-foret/",
    "https://mezieres-lez-clery.fr/2018/11/01/le-restaurant-scolaire/",
    "https://mezieres-lez-clery.fr/2018/11/02/308/",
    "https://mezieres-lez-clery.fr/2018/10/29/creche-familiale-les-marmousets/",
    "https://mezieres-lez-clery.fr/2018/10/30/centre-de-loisirs/",
  ],
  associations: [
    "https://mezieres-lez-clery.fr/les-associations/",
    "https://mezieres-lez-clery.fr/2021/12/06/demande-subvention/",
  ],
  dicrim: [
    "https://mezieres-lez-clery.fr/2021/06/14/dicrim/",
  ],
  randonnees: [
    "https://mezieres-lez-clery.fr/2018/10/21/randonnees-pedestres/",
    "https://mezieres-lez-clery.fr/2018/10/20/tourisme/",
  ],
  assainissement: [
    "https://mezieres-lez-clery.fr/2020/06/12/assainissement/",
  ],
  location: [
    "https://mezieres-lez-clery.fr/2018/10/24/location-de-materiel/",
  ],
  cctvl: [
    "https://www.ccterresduvaldeloire.fr/presentation/",
    "https://www.ccterresduvaldeloire.fr/competences/",
  ],
};

// ─── Mots-clés par sujet ───────────────────────────────────────────────────────
const KEYWORDS = {
  transport:      ["bus", "car", "rémi", "remi", "ligne 8", "ligne8", "transport", "horaire", "bréau", "breau", "arrêt", "navette", "trajet", "orléans"],
  dechets:        ["déchet", "dechet", "poubelle", "tri", "recyclage", "collecte", "ordure", "verre", "papier", "déchetterie", "bac", "compost"],
  urbanisme:      ["permis", "construire", "plu", "urbanisme", "zone", "terrain", "déclaration", "préalable", "construction", "bâtir", "parcelle"],
  scolaire:       ["école", "ecole", "cantine", "restaurant scolaire", "périscolaire", "enfant", "crèche", "creche", "loisirs", "garderie", "marmousets", "classe"],
  associations:   ["association", "asso", "subvention", "club", "bénévole"],
  dicrim:         ["risque", "danger", "inondation", "nucléaire", "nucleaire", "dicrim", "catastrophe", "alerte", "sirène"],
  randonnees:     ["randonnée", "rando", "balade", "promenade", "chemin", "circuit", "vélo", "forêt", "nature"],
  assainissement: ["assainissement", "spanc", "fosse", "eaux usées", "raccordement"],
  location:       ["louer", "location", "matériel", "salle", "table", "chaise", "barnum"],
  demarches:      ["carte identité", "passeport", "naissance", "mariage", "décès", "état civil", "acte", "certificat"],
  cctvl:          ["cctvl", "intercommunalité", "communauté de communes", "terres du val"],
  agenda:         ["manifestation", "fête", "événement", "agenda", "concert", "animation", "sortie", "prochainement", "ce week", "bientôt", "calendrier"],
};

function detectTopics(text) {
  const lower  = text.toLowerCase();
  const topics = new Set(["mairie_general"]);
  for (const [topic, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => lower.includes(w))) topics.add(topic);
  }
  return [...topics];
}

// ─── Caches ────────────────────────────────────────────────────────────────────
const topicCache    = {};
let   remiCache     = { content: "", lastUpdate: null };
let   calendarCache = { content: "", lastUpdate: null };
const CACHE_MS      = 7 * 24 * 60 * 60 * 1000;

// ─── Utilitaires ───────────────────────────────────────────────────────────────
function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{3,}/g, "\n\n")
    .replace(/&[a-z]+;/g, " ")
    .trim()
    .substring(0, 2500);
}

async function fetchUrl(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      responseType: "arraybuffer",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MairieBot/2.0)" },
    });
    const ct = res.headers["content-type"] || "";
    if (ct.includes("text")) return { text: cleanHtml(Buffer.from(res.data).toString("utf-8")), binary: null };
    return { text: null, binary: Buffer.from(res.data).toString("base64") };
  } catch (e) {
    console.warn(`⚠️ ${url} : ${e.message}`);
    return { text: null, binary: null };
  }
}

// ─── PDF Rémi ──────────────────────────────────────────────────────────────────
async function refreshRemiCache() {
  console.log("🚌 Mise à jour horaires Rémi...");
  const { binary } = await fetchUrl("https://drive.google.com/uc?export=download&id=1Fn9SWsL7jdipI3G0xq61NjWuluSPSZie");
  if (!binary) { remiCache.content = "[Horaires Rémi : PDF non accessible]"; return; }
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: binary } },
          { type: "text", text: "Extrais UNIQUEMENT les horaires des deux arrêts de MÉZIÈRES-LEZ-CLÉRY : arrêt MAIRIE et arrêt LE BRÉAU. Pour chaque arrêt : direction vers Orléans et direction vers St-Laurent-Nouan, horaires période scolaire et vacances, jours de circulation. Ajoute les dates des vacances scolaires. Texte structuré sans markdown." }
        ],
      }],
    });
    remiCache.content    = `=== HORAIRES BUS LIGNE 8 RÉMI — ARRÊTS MÉZIÈRES-LEZ-CLÉRY ===\n${resp.content[0].text}`;
    remiCache.lastUpdate = new Date();
    console.log("✅ Cache Rémi mis à jour");
  } catch (e) {
    remiCache.content = "[Horaires Rémi : erreur extraction PDF]";
    console.warn("⚠️ Rémi PDF error:", e.message);
  }
}

// ─── Calendrier iCal ──────────────────────────────────────────────────────────
function parseIcal(icsText) {
  const events = [];
  const now    = new Date();
  const limit  = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const blocks = icsText.split("BEGIN:VEVENT");

  for (let i = 1; i < blocks.length; i++) {
    const b   = blocks[i];
    const get = (key) => { const m = b.match(new RegExp(`${key}[^:]*:(.+)`)); return m ? m[1].replace(/\r/g, "").trim() : ""; };

    const rawStart = get("DTSTART");
    const summary  = get("SUMMARY");
    const location = get("LOCATION");
    const desc     = get("DESCRIPTION").replace(/\\n/g, " ").substring(0, 150);

    if (!rawStart || !summary) continue;

    const y = rawStart.substring(0, 4), mo = rawStart.substring(4, 6), d = rawStart.substring(6, 8);
    const h = rawStart.length > 8 ? rawStart.substring(9, 11) : "00";
    const mn = rawStart.length > 8 ? rawStart.substring(11, 13) : "00";
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mn}:00`);

    if (isNaN(dt) || dt < now || dt > limit) continue;

    const dateStr = dt.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const timeStr = h !== "00" ? ` à ${h}h${mn}` : "";
    let line = `📅 ${summary} — ${dateStr}${timeStr}`;
    if (location) line += ` 📍 ${location}`;
    if (desc)     line += `\n   ${desc}`;
    events.push({ dt, line });
  }

  events.sort((a, b) => a.dt - b.dt);
  return events.map(e => e.line).join("\n\n");
}

async function refreshCalendarCache() {
  if (!GOOGLE_CALENDAR_ICAL) { console.warn("⚠️ GOOGLE_CALENDAR_ICAL non défini"); return; }
  console.log("📅 Mise à jour calendrier...");
  try {
    const res    = await axios.get(GOOGLE_CALENDAR_ICAL, { timeout: 10000 });
    const parsed = parseIcal(res.data);
    calendarCache.content    = parsed
      ? `=== AGENDA DES MANIFESTATIONS (3 prochains mois) ===\n${parsed}`
      : "=== AGENDA === Aucun événement dans les 3 prochains mois.";
    calendarCache.lastUpdate = new Date();
    const nb = (parsed.match(/📅/g) || []).length;
    console.log(`✅ Calendrier mis à jour — ${nb} événement(s)`);
  } catch (e) {
    calendarCache.content = "[Agenda : non accessible]";
    console.warn("⚠️ Calendar error:", e.message);
  }
}

// ─── Cache par sujet ───────────────────────────────────────────────────────────
async function getTopicContent(topic) {
  const now = Date.now();
  if (topicCache[topic]?.lastUpdate && now - topicCache[topic].lastUpdate.getTime() < CACHE_MS) {
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

// ─── Construction contexte intelligent ────────────────────────────────────────
async function buildContext(userText) {
  const topics = detectTopics(userText);
  const parts  = [];

  // Calendrier toujours inclus (léger)
  if (!calendarCache.lastUpdate || Date.now() - calendarCache.lastUpdate.getTime() > CACHE_MS) await refreshCalendarCache();
  if (calendarCache.content) parts.push(calendarCache.content);

  for (const topic of topics) {
    if (topic === "transport") {
      if (!remiCache.lastUpdate || Date.now() - remiCache.lastUpdate.getTime() > CACHE_MS) await refreshRemiCache();
      parts.push(remiCache.content);
    } else if (topic === "agenda") {
      // déjà inclus via calendrier
    } else if (SOURCES[topic]) {
      const c = await getTopicContent(topic);
      if (c) parts.push(`=== ${topic.toUpperCase()} ===\n${c}`);
    }
  }

  return parts.join("\n\n─────────────────────────────────────────\n\n");
}

// ─── Prompt système ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es MEL (Mézières En Ligne), l'assistante virtuelle de la mairie de Mézières-lez-Cléry (45370, Loiret) sur Facebook Messenger. Présente-toi toujours sous le prénom MEL.

INFORMATIONS PERMANENTES :
📍 36 rue du bourg – 45370 MÉZIÈRES-LEZ-CLÉRY
📞 02 38 45 61 76 | ✉️ mairie@mezieres-lez-clery.fr | 🌐 mezieres-lez-clery.fr
🕐 Lundi 14h-17h30 / Mercredi sur RDV / Vendredi 8h30-11h30
CCTVL : 02 38 45 11 11 | ccterresduvaldeloire.fr

⚠️ BUS LIGNE 8 : La commune a DEUX arrêts : "Mairie" et "Le Bréau". Toujours préciser lequel.

INSTRUCTIONS :
- Français, convivial, concis (3-5 phrases max). Emojis pour structurer.
- N'utilise jamais de Markdown : pas de **, pas de *, pas de #, pas de _.
- Si tu ne trouves pas : "Toutes mes excuses, je n'ai pas cette information pour le moment. 🙏 Romuald ou Fabrice vous répondront incessamment sous peu. Vous pouvez aussi nous contacter au 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr 😊"
- Ne jamais inventer.`;

// ─── Suppression du gras Markdown (** et *) ───────────────────────────────────
// Messenger affiche **texte** tel quel, on le nettoie avant envoi
function cleanMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1") // **gras** → gras
    .replace(/\*(.+?)\*/g,     "$1") // *italique* → italique
    .replace(/#{1,6}\s/g,      "")   // # titres → supprimés
    .replace(/_{2}(.+?)_{2}/g, "$1") // __gras__ → gras
    .trim();
}

// ─── Présentation quotidienne ──────────────────────────────────────────────────
const introductions = new Map(); // senderId → date du dernier bonjour (YYYY-MM-DD)

function shouldIntroduce(senderId) {
  const today = new Date().toISOString().slice(0, 10); // "2026-03-25"
  if (introductions.get(senderId) !== today) {
    introductions.set(senderId, today);
    return true;
  }
  return false;
}

const INTRO_MESSAGE = "🌲 Bonjour ! Je suis MEL, l'assistante virtuelle de la mairie de Mézières-lez-Cléry. Comment puis-je vous aider ? 😊";

// ─── Historique ────────────────────────────────────────────────────────────────
const conversations = new Map();
function getHistory(id) { if (!conversations.has(id)) conversations.set(id, []); return conversations.get(id); }
function addToHistory(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > 6) h.splice(0, h.length - 6);
}

// ─── Webhook ───────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    console.log("✅ Webhook vérifié"); res.status(200).send(req.query["hub.challenge"]);
  } else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  if (req.body.object !== "page") return res.sendStatus(404);
  res.status(200).send("EVENT_RECEIVED");
  for (const entry of req.body.entry || []) {
    for (const event of entry.messaging || []) {
      const sid = event.sender.id;
      if (event.message?.text) { console.log(`📩 ${sid}: ${event.message.text}`); await handleMessage(sid, event.message.text); }
      if (event.postback?.payload === "GET_STARTED") {
        await sendMsg(sid, "🌲 Bonjour ! Je suis MEL (Mézières En Ligne), l'assistante virtuelle de la mairie de Mézières-lez-Cléry.\n\nJe peux vous renseigner sur les horaires d'ouverture, les démarches administratives, le bus ligne 8 (arrêts Mairie et Le Bréau), le PLU, le DICRIM, l'agenda des manifestations, l'école et bien plus !\n\nComment puis-je vous aider ? 😊");
      }
    }
  }
});

// ─── Traitement message ────────────────────────────────────────────────────────
async function handleMessage(senderId, userText) {
  try {
    await typingOn(senderId);

    // Présentation quotidienne — une seule fois par jour par utilisateur
    if (shouldIntroduce(senderId)) {
      await sendMsg(senderId, INTRO_MESSAGE);
    }

    const context = await buildContext(userText);
    addToHistory(senderId, "user", userText);

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: `${SYSTEM_PROMPT}\n\n─── CONTEXTE ───\n${context}\n────────────────`,
      messages: getHistory(senderId),
    });

    const raw   = response.content[0].text;
    const reply = cleanMarkdown(raw); // Suppression du gras Markdown
    addToHistory(senderId, "assistant", reply);
    await sendMsg(senderId, reply);
    console.log(`✅ Réponse | in:${response.usage.input_tokens} out:${response.usage.output_tokens} tokens`);
  } catch (err) {
    console.error("❌", err.message);
    await sendMsg(senderId, "Désolé, difficulté technique. Contactez la mairie au 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr 😊");
  }
}

// ─── Helpers Messenger ─────────────────────────────────────────────────────────
async function sendMsg(to, text) {
  for (const chunk of (text.length <= 1900 ? [text] : text.match(/.{1,1900}/g) || [])) {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: to }, message: { text: chunk }, messaging_type: "RESPONSE" }
    ).catch(e => console.error("Messenger:", e.message));
  }
}
async function typingOn(to) {
  await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    { recipient: { id: to }, sender_action: "typing_on" }).catch(() => {});
}

// ─── Proxy MEL pour la PWA ────────────────────────────────────────────────────
// Permet à la PWA GitHub Pages d'appeler Claude sans exposer la clé API

// Gestion CORS (requêtes depuis GitHub Pages ou tout domaine)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin",  "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  next();
});
app.options("/mel", (req, res) => res.sendStatus(200));

app.post("/mel", async (req, res) => {
  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages[] requis" });
  }
  try {
    const context = messages.length > 0
      ? await buildContext(messages[messages.length - 1]?.content || "")
      : "";

    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:     `${SYSTEM_PROMPT}\n\n─── CONTEXTE ───\n${context}\n────────────────`,
      messages:   messages.slice(-6),
    });

    const reply = cleanMarkdown(response.content[0].text);
    console.log(`📱 PWA MEL | in:${response.usage.input_tokens} out:${response.usage.output_tokens} tokens`);
    res.json({ reply });
  } catch (e) {
    console.error("❌ MEL proxy:", e.message);
    res.status(500).json({ reply: "Désolée, difficulté technique. Contactez la mairie au 02 38 45 61 76 😊" });
  }
});

// ─── Routes utilitaires ────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status:  "MEL est en ligne 🌲",
  version: "4.1 — Messenger + PWA proxy",
  routes:  ["/webhook (Messenger)", "/mel (PWA proxy)", "/refresh", "/calendar", "/bus"],
}));

app.get("/refresh", async (req, res) => {
  await Promise.all([refreshCalendarCache(), refreshRemiCache()]);
  res.json({ success: true, lastUpdate: new Date() });
});

app.get("/calendar", (req, res) => res.json({
  lastUpdate: calendarCache.lastUpdate?.toLocaleString("fr-FR"),
  content:    calendarCache.content,
}));

app.get("/bus", (req, res) => res.json({
  lastUpdate: remiCache.lastUpdate?.toLocaleString("fr-FR"),
  content:    remiCache.content,
}));

// ─── Démarrage ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 MEL démarrée sur le port ${PORT}`);
  console.log(`📡 Messenger : /webhook`);
  console.log(`📱 PWA proxy : /mel`);
  await refreshCalendarCache();
  await refreshRemiCache();
});
