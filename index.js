const express   = require("express");
const axios     = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

// ─── Configuration ─────────────────────────────────────────────────────────────
const PAGE_ACCESS_TOKEN   = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN        = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CALENDAR_ICAL = process.env.GOOGLE_CALENDAR_ICAL;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Sources web ───────────────────────────────────────────────────────────────
const MEZIERES_PAGES = [
  { url: "https://mezieres-lez-clery.fr/",                                          topics: ["general","contact","horaires"] },
  { url: "https://mezieres-lez-clery.fr/2018/10/25/178/",                           topics: ["demarches","administratif"] },
  { url: "https://mezieres-lez-clery.fr/2018/10/25/gestion-des-dechets/",           topics: ["dechets","tri","collecte","recyclage"] },
  { url: "https://mezieres-lez-clery.fr/2018/10/24/location-de-materiel/",          topics: ["location","materiel"] },
  { url: "https://mezieres-lez-clery.fr/2018/10/23/numeros-utiles/",                topics: ["contact","numeros","urgence"] },
  { url: "https://mezieres-lez-clery.fr/2018/11/03/les-services-municipaux/",       topics: ["services","mairie","general"] },
  { url: "https://mezieres-lez-clery.fr/2018/11/04/le-conseil-municipal/",          topics: ["conseil","elus","municipal"] },
  { url: "https://mezieres-lez-clery.fr/2018/10/22/presentation-de-la-commune/",   topics: ["commune","histoire","general"] },
  { url: "https://mezieres-lez-clery.fr/2018/10/21/randonnees-pedestres/",          topics: ["randonnee","balade","nature","velo"] },
  { url: "https://mezieres-lez-clery.fr/2018/11/03/lecole-de-la-foret/",            topics: ["ecole","scolaire","enfant"] },
  { url: "https://mezieres-lez-clery.fr/2018/11/01/le-restaurant-scolaire/",        topics: ["cantine","restaurant","scolaire","repas"] },
  { url: "https://mezieres-lez-clery.fr/2018/11/02/308/",                           topics: ["periscolaire","garderie","enfant","scolaire"] },
  { url: "https://mezieres-lez-clery.fr/2020/09/12/regles-durbanisme/",             topics: ["urbanisme","plu","construction","zone"] },
  { url: "https://mezieres-lez-clery.fr/2021/03/13/fiche-pratique/",                topics: ["demarches","administratif","fiche"] },
  { url: "https://mezieres-lez-clery.fr/2020/06/12/assainissement/",                topics: ["assainissement","eau","spanc"] },
  { url: "https://mezieres-lez-clery.fr/2018/10/20/tourisme/",                      topics: ["tourisme","visite","patrimoine"] },
  { url: "https://mezieres-lez-clery.fr/2021/06/14/dicrim/",                        topics: ["dicrim","risque","inondation","nucleaire","danger","securite"] },
  { url: "https://mezieres-lez-clery.fr/2018/11/02/plan-local-durbanisme/",         topics: ["plu","urbanisme","zone","terrain"] },
  { url: "https://mezieres-lez-clery.fr/2024/02/04/permis-de-construire-et-declarations-prealables/", topics: ["permis","construire","declaration","travaux"] },
  { url: "https://mezieres-lez-clery.fr/les-associations/",                          topics: ["association","subvention","club"] },
];

const CCTVL_PAGES = [
  { url: "https://www.ccterresduvaldeloire.fr/",                  topics: ["general","cctvl","intercommunalite"] },
  { url: "https://www.ccterresduvaldeloire.fr/presentation/",     topics: ["cctvl","intercommunalite"] },
  { url: "https://www.ccterresduvaldeloire.fr/dechets/",          topics: ["dechets","tri","collecte","recyclage"] },
  { url: "https://www.ccterresduvaldeloire.fr/petite-enfance/",   topics: ["creche","enfant","petite-enfance","marmousets"] },
  { url: "https://www.ccterresduvaldeloire.fr/contact/",          topics: ["contact","cctvl"] },
];

// ─── Mots-clés → topics ────────────────────────────────────────────────────────
const KEYWORD_TOPICS = {
  "bus|car|rémi|remi|ligne 8|transport|horaire|bréau|breau|arrêt|autocar": "transport",
  "permis|construire|plu|urbanisme|zone|terrain|déclaration|travaux|lotissement": "urbanisme",
  "école|ecole|cantine|périscolaire|periscolaire|enfant|crèche|creche|marmousets|garderie|restaurant scolaire": "scolaire",
  "déchet|dechet|poubelle|tri|recyclage|collecte|bac|ordures|verre|papier|déchetterie": "dechets",
  "risque|inondation|nucléaire|nucleaire|dicrim|danger|sécurité|securite|catastrophe": "dicrim",
  "manifestation|fête|fete|événement|evenement|agenda|concert|spectacle|animation|sortie": "agenda",
  "association|subvention|club|sport|loisir": "association",
  "randonnée|randonnee|balade|sentier|chemin|vélo|velo|nature|forêt|foret": "tourisme",
  "assainissement|eau|spanc|fosse|égout": "assainissement",
  "horaire|ouverte|ouverture|fermé|ferme|accueil|permanence|rendez-vous": "horaires",
  "élu|elu|maire|conseil|municipal|romuald|genty|fabrice": "conseil",
  "contact|téléphone|telephone|email|adresse|mail": "contact",
};

// ─── Cache par sujet ───────────────────────────────────────────────────────────
let contentCache = {}; // { topic: { content, lastUpdate } }
let calendarCache = { events: "", lastUpdate: null };
let busCache      = { content: "", lastUpdate: null };

const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

// ─── Détection intelligente du sujet ──────────────────────────────────────────
function detectTopics(text) {
  const lower = text.toLowerCase();
  const detected = new Set(["general", "horaires", "contact"]); // toujours inclus

  for (const [pattern, topic] of Object.entries(KEYWORD_TOPICS)) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(lower)) {
      detected.add(topic);
      // Ajouter les topics liés
      if (topic === "transport")   detected.add("transport");
      if (topic === "urbanisme")   detected.add("urbanisme");
      if (topic === "scolaire")    detected.add("scolaire");
      if (topic === "agenda")      detected.add("agenda");
    }
  }
  return [...detected];
}

// ─── Utilitaires ───────────────────────────────────────────────────────────────
function cleanHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{3,}/g, "\n\n")
    .replace(/&[a-z]+;/g, " ")
    .trim()
    .substring(0, 2500);
}

async function fetchUrl(url, timeout = 10000) {
  try {
    const res = await axios.get(url, {
      timeout,
      responseType: "arraybuffer",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MEL-MairieBot/1.0)" },
    });
    const ct = res.headers["content-type"] || "";
    const buf = Buffer.from(res.data);
    if (ct.includes("text") || ct.includes("calendar")) {
      return { text: ct.includes("html") ? cleanHtml(buf.toString("utf-8")) : buf.toString("utf-8"), binary: null };
    }
    return { text: null, binary: buf.toString("base64"), contentType: ct };
  } catch (err) {
    console.warn(`⚠️ ${url} — ${err.message}`);
    return { text: null, binary: null };
  }
}

// ─── Parsing iCal ──────────────────────────────────────────────────────────────
function parseIcal(icsText) {
  const events = [];
  const blocks = icsText.split("BEGIN:VEVENT");

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = (key) => {
      const match = block.match(new RegExp(`${key}[^:]*:([^\\r\\n]+)`));
      return match ? match[1].trim() : "";
    };

    const dtstart = get("DTSTART");
    const summary = get("SUMMARY");
    const location = get("LOCATION");
    const description = get("DESCRIPTION").replace(/\\n/g, " ").substring(0, 200);

    if (!summary || !dtstart) continue;

    // Parsing de la date
    let dateStr = dtstart.replace(/T.*/, "").replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1");

    // Filtrer les événements passés (garder 3 mois en avant + 1 semaine passée)
    try {
      const raw = dtstart.replace(/T.*/, "");
      const d = new Date(`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`);
      const now = new Date();
      const limit = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      const past  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
      if (d < past || d > limit) continue;
    } catch (_) {}

    events.push(`📅 ${dateStr} — ${summary}${location ? " 📍 " + location : ""}${description ? " — " + description : ""}`);
  }

  // Trier par date
  events.sort();
  return events.length > 0
    ? events.join("\n")
    : "Aucun événement à venir dans les 3 prochains mois.";
}

// ─── Chargement du calendrier ──────────────────────────────────────────────────
async function refreshCalendar() {
  if (!GOOGLE_CALENDAR_ICAL) return;
  console.log("📅 Rafraîchissement du calendrier...");
  const { text } = await fetchUrl(GOOGLE_CALENDAR_ICAL);
  if (text) {
    calendarCache.events    = parseIcal(text);
    calendarCache.lastUpdate = new Date();
    console.log(`✅ Calendrier mis à jour — ${calendarCache.events.split("\n").length} événements`);
  } else {
    console.warn("⚠️ Calendrier inaccessible");
  }
}

// ─── Chargement du PDF bus (Drive) ────────────────────────────────────────────
async function refreshBus() {
  console.log("🚌 Rafraîchissement horaires bus...");
  const url = "https://drive.google.com/uc?export=download&id=1Fn9SWsL7jdipI3G0xq61NjWuluSPSZie";
  const { binary } = await fetchUrl(url);
  if (!binary) { console.warn("⚠️ PDF bus non accessible"); return; }

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: binary } },
          { type: "text", text: `Extrais UNIQUEMENT les horaires des arrêts de MÉZIÈRES-LEZ-CLÉRY.
Il y a DEUX arrêts distincts : "Mairie" et "Le Bréau".
Pour chacun, indique :
- Direction (vers Orléans / vers St-Laurent-Nouan)
- Horaires en période scolaire
- Horaires en vacances scolaires
- Jours de circulation (lundi-vendredi, samedi...)
Indique aussi les dates des vacances scolaires mentionnées.
Format concis et clair.` }
        ]
      }]
    });
    busCache.content    = resp.content[0].text;
    busCache.lastUpdate = new Date();
    console.log("✅ Horaires bus extraits");
  } catch (e) {
    console.warn(`⚠️ Extraction PDF bus : ${e.message}`);
  }
}

// ─── Chargement du contenu web par sujet ──────────────────────────────────────
async function refreshWebContent() {
  console.log("🌐 Rafraîchissement contenu web...");
  const byTopic = {};

  for (const page of [...MEZIERES_PAGES, ...CCTVL_PAGES]) {
    const { text } = await fetchUrl(page.url);
    if (!text) continue;
    for (const topic of page.topics) {
      if (!byTopic[topic]) byTopic[topic] = [];
      byTopic[topic].push(`[${page.url}]\n${text}`);
    }
  }

  // Stocker par topic
  for (const [topic, contents] of Object.entries(byTopic)) {
    contentCache[topic] = {
      content:    contents.join("\n\n---\n\n").substring(0, 8000),
      lastUpdate: new Date(),
    };
  }
  console.log(`✅ Contenu web chargé — ${Object.keys(contentCache).length} topics`);
}

// ─── Rafraîchissement complet ──────────────────────────────────────────────────
async function refreshAll() {
  console.log("\n🔄 Rafraîchissement complet de MEL...");
  await Promise.all([
    refreshWebContent(),
    refreshCalendar(),
    refreshBus(),
  ]);
  console.log("✅ MEL est à jour !\n");
}

async function ensureUpToDate() {
  const now = Date.now();
  const needsRefresh = !calendarCache.lastUpdate ||
    now - calendarCache.lastUpdate.getTime() > CACHE_DURATION_MS;
  if (needsRefresh) await refreshAll();
}

// ─── Sélection intelligente du contexte ───────────────────────────────────────
function buildContext(detectedTopics) {
  const sections = [];

  // Informations générales (toujours)
  if (contentCache["general"]) {
    sections.push("=== INFOS GÉNÉRALES MAIRIE ===\n" + contentCache["general"].content);
  }
  if (contentCache["horaires"]) {
    sections.push("=== HORAIRES & CONTACTS ===\n" + contentCache["horaires"].content);
  }

  // Contenu spécifique selon les topics détectés
  const topicLabels = {
    transport:      "🚌 HORAIRES BUS LIGNE 8 RÉMI",
    urbanisme:      "🏗️ URBANISME & PLU",
    scolaire:       "🏫 VIE SCOLAIRE",
    dechets:        "♻️ GESTION DES DÉCHETS",
    dicrim:         "⚠️ DICRIM & RISQUES",
    agenda:         "📅 AGENDA DES MANIFESTATIONS",
    association:    "🤝 VIE ASSOCIATIVE",
    tourisme:       "🥾 TOURISME & RANDONNÉES",
    assainissement: "💧 ASSAINISSEMENT",
    conseil:        "🏛️ CONSEIL MUNICIPAL",
    contact:        "📞 CONTACTS UTILES",
    cctvl:          "🏘️ INTERCOMMUNALITÉ CCTVL",
  };

  for (const topic of detectedTopics) {
    if (topic === "general" || topic === "horaires") continue;

    // Horaires bus : source spéciale
    if (topic === "transport" && busCache.content) {
      sections.push(`=== 🚌 HORAIRES BUS LIGNE 8 RÉMI ===\n⚠️ DEUX arrêts à Mézières : "Mairie" et "Le Bréau"\n${busCache.content}`);
      continue;
    }

    // Agenda : source calendrier
    if (topic === "agenda") {
      const cal = calendarCache.events || "Calendrier non disponible";
      sections.push(`=== 📅 AGENDA DES MANIFESTATIONS ===\n${cal}`);
      // Ajouter aussi le contenu web si disponible
      if (contentCache["agenda"]) {
        sections.push(contentCache["agenda"].content);
      }
      continue;
    }

    if (contentCache[topic]) {
      const label = topicLabels[topic] || topic.toUpperCase();
      sections.push(`=== ${label} ===\n${contentCache[topic].content}`);
    }
  }

  return sections.join("\n\n").substring(0, 20000);
}

// ─── Prompt système ────────────────────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `Tu es MEL (Mézières En Ligne), l'assistante virtuelle de la mairie de Mézières-lez-Cléry (45370, Loiret) sur Facebook Messenger.

INFOS PERMANENTES :
📍 36 rue du bourg – 45370 MÉZIÈRES-LEZ-CLÉRY
📞 02 38 45 61 76 | ✉️ mairie@mezieres-lez-clery.fr
🌐 https://mezieres-lez-clery.fr

🕐 HORAIRES MAIRIE : Lundi 14h-17h30 | Mercredi sur RDV | Vendredi 8h30-11h30

🚌 BUS LIGNE 8 : La commune a DEUX arrêts distincts — "Mairie" et "Le Bréau". Toujours les mentionner séparément.

INSTRUCTIONS :
- Réponds en français, de façon conviviale et concise (3-5 phrases max).
- Utilise les emojis pour structurer. Pas de Markdown (pas de **, pas de #).
- Pour le bus : distingue toujours "arrêt Mairie" et "arrêt Le Bréau", et période scolaire vs vacances.
- Si tu ne trouves pas la réponse : "Toutes mes excuses, je n'ai pas cette information pour le moment. 🙏 Romuald ou Fabrice vous répondront incessamment sous peu. Vous pouvez aussi nous contacter au 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr 😊"
- Ne jamais inventer d'informations.`;

// ─── Historique conversations ──────────────────────────────────────────────────
const conversations = new Map();
const MAX_HISTORY = 6; // Réduit pour économiser les tokens

function getHistory(senderId) {
  if (!conversations.has(senderId)) conversations.set(senderId, []);
  return conversations.get(senderId);
}

function addToHistory(senderId, role, content) {
  const history = getHistory(senderId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

// ─── Webhook Meta ──────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook vérifié");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);
  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry) {
    for (const event of (entry.messaging || [])) {
      const senderId = event.sender.id;
      if (event.message?.text) {
        console.log(`📩 ${senderId} : ${event.message.text}`);
        await handleMessage(senderId, event.message.text);
      }
      if (event.postback?.payload === "GET_STARTED") {
        await sendMessengerMessage(senderId,
          "🌲 Bonjour ! Je suis MEL (Mézières En Ligne), l'assistante virtuelle de la mairie de Mézières-lez-Cléry.\n\nJe peux vous renseigner sur les horaires, le bus ligne 8, les démarches, l'école, les événements, le PLU, les risques et bien plus !\n\nComment puis-je vous aider ? 😊"
        );
      }
    }
  }
});

// ─── Traitement du message ─────────────────────────────────────────────────────
async function handleMessage(senderId, userText) {
  try {
    await sendTypingOn(senderId);
    await ensureUpToDate();

    // Détection intelligente du sujet
    const topics  = detectTopics(userText);
    const context = buildContext(topics);
    console.log(`🔍 Topics détectés : ${topics.join(", ")}`);

    const systemPrompt = `${BASE_SYSTEM_PROMPT}

─────────────────────────────────
INFORMATIONS DISPONIBLES (mis à jour le ${calendarCache.lastUpdate?.toLocaleDateString("fr-FR") || "inconnu"}) :
${context}
─────────────────────────────────`;

    addToHistory(senderId, "user", userText);

    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001", // Modèle économique
      max_tokens: 300,                          // Réponses courtes
      system:     systemPrompt,
      messages:   getHistory(senderId),
    });

    const reply = response.content[0].text;
    addToHistory(senderId, "assistant", reply);
    await sendMessengerMessage(senderId, reply);

    // Log de consommation estimée
    const inputTokens  = response.usage?.input_tokens  || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    console.log(`✅ Réponse envoyée — ${inputTokens} in / ${outputTokens} out tokens`);

  } catch (error) {
    console.error("❌ Erreur :", error.message);
    await sendMessengerMessage(senderId,
      "Désolé, je rencontre une difficulté technique. Contactez la mairie au 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr 😊"
    );
  }
}

// ─── Helpers Messenger ─────────────────────────────────────────────────────────
async function sendMessengerMessage(recipientId, text) {
  for (const chunk of splitMessage(text, 1900)) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text: chunk }, messaging_type: "RESPONSE" }
    );
  }
}

async function sendTypingOn(recipientId) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    { recipient: { id: recipientId }, sender_action: "typing_on" }
  ).catch(() => {});
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      const sp = text.lastIndexOf(" ",  end);
      end = nl > start + 100 ? nl : sp > start + 100 ? sp : end;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

// ─── Routes utilitaires ────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status:      "MEL est en ligne 🌲",
  lastUpdate:  calendarCache.lastUpdate?.toLocaleString("fr-FR") || "jamais",
  topics:      Object.keys(contentCache),
  nextEvents:  calendarCache.events?.split("\n").slice(0, 3).join(" | ") || "aucun",
}));

app.get("/refresh", async (req, res) => {
  await refreshAll();
  res.json({ success: true, lastUpdate: calendarCache.lastUpdate });
});

app.get("/calendar", (req, res) => res.json({
  lastUpdate: calendarCache.lastUpdate?.toLocaleString("fr-FR"),
  events:     calendarCache.events,
}));

app.get("/bus", (req, res) => res.json({
  lastUpdate: busCache.lastUpdate?.toLocaleString("fr-FR"),
  content:    busCache.content,
}));

// ─── Démarrage ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 MEL démarrée sur le port ${PORT}`);
  await refreshAll();
});
