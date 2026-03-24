const express = require("express");
const axios   = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

// ─── Configuration ─────────────────────────────────────────────────────────────
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Sources à crawler ─────────────────────────────────────────────────────────

// Pages du site de la mairie
const MEZIERES_PAGES = [
  "https://mezieres-lez-clery.fr/",
  "https://mezieres-lez-clery.fr/2018/10/25/178/",
  "https://mezieres-lez-clery.fr/2018/10/25/gestion-des-dechets/",
  "https://mezieres-lez-clery.fr/2018/10/24/location-de-materiel/",
  "https://mezieres-lez-clery.fr/2018/10/23/numeros-utiles/",
  "https://mezieres-lez-clery.fr/2018/11/03/les-services-municipaux/",
  "https://mezieres-lez-clery.fr/2018/11/04/le-conseil-municipal/",
  "https://mezieres-lez-clery.fr/2018/10/22/presentation-de-la-commune/",
  "https://mezieres-lez-clery.fr/2018/10/21/randonnees-pedestres/",
  "https://mezieres-lez-clery.fr/2018/11/03/lecole-de-la-foret/",
  "https://mezieres-lez-clery.fr/2018/11/01/le-restaurant-scolaire/",
  "https://mezieres-lez-clery.fr/2018/11/02/308/",
  "https://mezieres-lez-clery.fr/2020/09/12/regles-durbanisme/",
  "https://mezieres-lez-clery.fr/2021/03/13/fiche-pratique/",
  "https://mezieres-lez-clery.fr/2020/06/12/assainissement/",
  "https://mezieres-lez-clery.fr/2018/10/20/tourisme/",
  "https://mezieres-lez-clery.fr/2021/06/14/dicrim/",
  "https://mezieres-lez-clery.fr/2018/11/02/plan-local-durbanisme/",
  "https://mezieres-lez-clery.fr/2024/02/04/permis-de-construire-et-declarations-prealables/",
  "https://mezieres-lez-clery.fr/les-associations/",
];

// Pages du site de la CCTVL
const CCTVL_PAGES = [
  "https://www.ccterresduvaldeloire.fr/",
  "https://www.ccterresduvaldeloire.fr/presentation/",
  "https://www.ccterresduvaldeloire.fr/competences/",
  "https://www.ccterresduvaldeloire.fr/dechets/",
  "https://www.ccterresduvaldeloire.fr/petite-enfance/",
  "https://www.ccterresduvaldeloire.fr/contact/",
];

// Fichiers Google Drive publics (PDF ou Google Docs exportés en texte)
// Format : { id, type: 'pdf' | 'doc', label }
const DRIVE_FILES = [
  {
    id:    "1Fn9SWsL7jdipI3G0xq61NjWuluSPSZie",
    type:  "pdf",
    label: "Horaires Rémi Ligne 8",
  },
];

// Dossiers Google Drive à lister et lire automatiquement
// Le bot liste tous les fichiers du dossier et en lit le contenu
const DRIVE_FOLDERS = [
  {
    id:    "1RfOBOFJQs7mvtkOsoyg_uG52gJuJ3KVu",
    label: "Documents mairie (Drive)",
  }
];

// ─── Cache ─────────────────────────────────────────────────────────────────────
let siteCache = { content: "", lastUpdate: null };
const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

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
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim()
    .substring(0, 3000);
}

async function fetchUrl(url, timeout = 10000) {
  try {
    const res = await axios.get(url, {
      timeout,
      responseType: "arraybuffer",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MairieBot/1.0)" },
    });
    const contentType = res.headers["content-type"] || "";
    if (contentType.includes("text")) {
      return { text: cleanHtml(Buffer.from(res.data).toString("utf-8")), binary: null };
    }
    return { text: null, binary: Buffer.from(res.data).toString("base64"), contentType };
  } catch (err) {
    console.warn(`⚠️ Impossible de lire : ${url} — ${err.message}`);
    return { text: null, binary: null };
  }
}

// ─── Lecture d'un fichier Drive (PDF ou Google Doc) ───────────────────────────
async function fetchDriveFile(fileId, type, label) {
  console.log(`  📄 Lecture Drive : ${label}`);
  if (type === "pdf") {
    const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const { binary, contentType } = await fetchUrl(url);
    if (!binary) return `[${label} : non accessible]`;

    // Envoi du PDF à Claude pour extraction de texte pertinent
    try {
      const resp = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: binary },
            },
            {
              type: "text",
              text: `Extrais UNIQUEMENT les horaires concernant les arrêts de MÉZIÈRES-LEZ-CLÉRY (arrêts "Mairie" et "Le Bréau") de ce document. 
Indique clairement :
- La direction (vers Orléans / vers St-Laurent-Nouan)
- Les horaires par arrêt (Mairie et Le Bréau séparément)
- Les différences période scolaire / vacances scolaires
- Les dates des périodes de vacances
Sois concis et structuré.`,
            },
          ],
        }],
      });
      return `=== ${label} ===\n${resp.content[0].text}`;
    } catch (e) {
      console.warn(`⚠️ Extraction PDF échouée pour ${label} : ${e.message}`);
      return `[${label} : erreur extraction PDF]`;
    }
  }

  if (type === "doc") {
    const url = `https://docs.google.com/document/d/${fileId}/export?format=txt`;
    const { text } = await fetchUrl(url);
    return text ? `=== ${label} ===\n${text.substring(0, 3000)}` : `[${label} : non accessible]`;
  }

  return "";
}

// ─── Lecture d'un dossier Drive ────────────────────────────────────────────────
async function fetchDriveFolder(folderId, label) {
  console.log(`  📁 Lecture dossier Drive : ${label}`);
  const results = [];

  // Lister les fichiers via l'API publique Drive
  const listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&fields=files(id,name,mimeType)&key=AIzaSyD-PLACEHOLDER`;
  // Note : sans clé API, on tente directement les exports connus
  // On récupère les Google Docs du dossier via export texte
  try {
    // Tentative via URL d'export direct pour les Google Docs connus
    // Pour les dossiers partagés publiquement, l'index HTML est accessible
    const indexUrl = `https://drive.google.com/drive/folders/${folderId}`;
    const { text } = await fetchUrl(indexUrl);
    if (text) {
      results.push(`=== ${label} (aperçu) ===\n${text.substring(0, 1500)}`);
    }
  } catch (e) {
    results.push(`[${label} : dossier non accessible sans clé API]`);
  }

  return results.join("\n\n");
}

// ─── Rafraîchissement complet du cache ────────────────────────────────────────
async function refreshSiteCache() {
  console.log("\n🔄 Rafraîchissement du cache...");
  const allContent = [];

  // 1. Site de la mairie
  console.log("🌐 Crawl site mairie...");
  allContent.push("=== SITE OFFICIEL DE LA MAIRIE DE MÉZIÈRES-LEZ-CLÉRY ===");
  for (const url of MEZIERES_PAGES) {
    const { text } = await fetchUrl(url);
    if (text) allContent.push(`--- ${url} ---\n${text}`);
  }

  // 2. Site CCTVL
  console.log("🌐 Crawl site CCTVL...");
  allContent.push("\n=== SITE DE LA COMMUNAUTÉ DE COMMUNES (CCTVL) ===");
  for (const url of CCTVL_PAGES) {
    const { text } = await fetchUrl(url);
    if (text) allContent.push(`--- ${url} ---\n${text}`);
  }

  // 3. Agenda des manifestations (WordPress — tentative)
  console.log("📅 Récupération agenda...");
  const agendaUrls = [
    "https://mezieres-lez-clery.fr/?post_type=tribe_events",
    "https://mezieres-lez-clery.fr/events/",
    "https://mezieres-lez-clery.fr/manifestations/",
  ];
  allContent.push("\n=== AGENDA DES MANIFESTATIONS ===");
  let agendaFound = false;
  for (const url of agendaUrls) {
    const { text } = await fetchUrl(url);
    if (text && text.length > 200) {
      allContent.push(text);
      agendaFound = true;
      break;
    }
  }
  if (!agendaFound) {
    allContent.push("(Agenda dynamique — consulter https://mezieres-lez-clery.fr pour les événements à venir)");
  }

  // 4. Fichiers Drive (PDF et Docs individuels)
  console.log("📄 Lecture fichiers Drive...");
  allContent.push("\n=== DOCUMENTS DRIVE — MAIRIE ===");
  for (const file of DRIVE_FILES) {
    const content = await fetchDriveFile(file.id, file.type, file.label);
    allContent.push(content);
  }

  // 5. Dossiers Drive (PLU, documents divers)
  console.log("📁 Lecture dossiers Drive...");
  for (const folder of DRIVE_FOLDERS) {
    const content = await fetchDriveFolder(folder.id, folder.label);
    allContent.push(content);
  }

  siteCache.content  = allContent.join("\n\n");
  siteCache.lastUpdate = new Date();
  console.log(`✅ Cache mis à jour : ${siteCache.lastUpdate.toLocaleString("fr-FR")}`);
  console.log(`📦 Taille : ${Math.round(siteCache.content.length / 1024)} Ko\n`);
}

async function ensureCacheUpToDate() {
  const now = Date.now();
  if (!siteCache.lastUpdate || now - siteCache.lastUpdate.getTime() > CACHE_DURATION_MS) {
    await refreshSiteCache();
  }
}

// ─── Prompt système ────────────────────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `Tu es MEL (Mézières En Ligne), l'assistante virtuelle de la mairie de Mézières-lez-Cléry (45370, Loiret) sur Facebook Messenger. Présente-toi toujours sous le prénom MEL.

INFORMATIONS PERMANENTES :
📍 Adresse : 36 rue du bourg – 45370 MÉZIÈRES-LEZ-CLÉRY
📞 Tél : 02 38 45 61 76
✉️ Email : mairie@mezieres-lez-clery.fr
🌐 Site : https://mezieres-lez-clery.fr

🕐 HORAIRES D'OUVERTURE :
- Lundi : 14h00 – 17h30
- Mercredi : sur rendez-vous uniquement
- Vendredi : 8h30 – 11h30

CCTVL (intercommunalité) :
🌐 Site : https://www.ccterresduvaldeloire.fr
📞 Tél : 02 38 45 11 11
📍 32 rue du Général de Gaulle – 45130 Meung-sur-Loire

🚌 BUS LIGNE 8 RÉMI :
La commune dispose de DEUX arrêts distincts :
- Arrêt MAIRIE (centre bourg)
- Arrêt LE BRÉAU
Consulte toujours les horaires détaillés dans les documents fournis ci-dessous.
Infos : 0 806 70 33 33 — www.remi-centrevaldeloire.fr

INSTRUCTIONS :
- Réponds en français, de façon conviviale et concise (3-5 phrases max).
- Utilise les emojis pour structurer, pas de Markdown (pas de **, pas de #).
- Pour les horaires du bus, distingue toujours les deux arrêts (Mairie et Le Bréau) et les deux périodes (scolaire / vacances).
- Si tu ne trouves pas la réponse : "Toutes mes excuses, je n'ai pas cette information pour le moment. 🙏 Mais pas d'inquiétude ! Romuald ou Fabrice vous répondront incessamment sous peu. Vous pouvez aussi nous contacter au 02 38 45 61 76 ou par email : mairie@mezieres-lez-clery.fr 😊"
- Ne jamais inventer d'informations.
- Utilise en priorité les informations des documents fournis ci-dessous.`;

// ─── Historique des conversations ─────────────────────────────────────────────
const conversations = new Map();
const MAX_HISTORY = 10;

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
    console.log("✅ Webhook vérifié par Meta");
    res.status(200).send(challenge);
  } else {
    console.error("❌ Échec vérification webhook");
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
        console.log(`📩 Message de ${senderId} : ${event.message.text}`);
        await handleMessage(senderId, event.message.text);
      }
      if (event.postback?.payload === "GET_STARTED") {
        await sendMessengerMessage(
          senderId,
          "🌲 Bonjour et bienvenue ! Je suis MEL (Mézières En Ligne), l'assistante virtuelle de la mairie de Mézières-lez-Cléry.\n\nJe peux vous renseigner sur les horaires, les démarches administratives, le bus ligne 8, l'urbanisme (PLU), les risques (DICRIM), l'école, les déchets et bien plus encore !\n\nComment puis-je vous aider ? 😊"
        );
      }
    }
  }
});

// ─── Traitement du message ─────────────────────────────────────────────────────
async function handleMessage(senderId, userText) {
  try {
    await sendTypingOn(senderId);
    await ensureCacheUpToDate();

    const systemPrompt = `${BASE_SYSTEM_PROMPT}

─────────────────────────────────────────
CONTENU DES SOURCES (mis à jour le ${siteCache.lastUpdate?.toLocaleDateString("fr-FR") || "inconnu"}) :
${siteCache.content.substring(0, 20000)}
─────────────────────────────────────────`;

    addToHistory(senderId, "user", userText);

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: systemPrompt,
      messages: getHistory(senderId),
    });

    const reply = response.content[0].text;
    addToHistory(senderId, "assistant", reply);
    await sendMessengerMessage(senderId, reply);
    console.log(`✅ Réponse envoyée à ${senderId}`);
  } catch (error) {
    console.error("❌ Erreur :", error.message);
    await sendMessengerMessage(
      senderId,
      "Désolé, je rencontre une difficulté technique. Vous pouvez contacter la mairie au 02 38 45 61 76 ou par email : mairie@mezieres-lez-clery.fr 😊"
    );
  }
}

// ─── Helpers Messenger ─────────────────────────────────────────────────────────
async function sendMessengerMessage(recipientId, text) {
  const chunks = splitMessage(text, 1900);
  for (const chunk of chunks) {
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
      const sp = text.lastIndexOf(" ", end);
      end = nl > start + 100 ? nl : sp > start + 100 ? sp : end;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

// ─── Route de rafraîchissement manuel ─────────────────────────────────────────
app.get("/refresh", async (req, res) => {
  await refreshSiteCache();
  res.json({
    success: true,
    message: "Cache rafraîchi avec succès",
    lastUpdate: siteCache.lastUpdate,
    size: `${Math.round(siteCache.content.length / 1024)} Ko`,
  });
});

// Route de statut
app.get("/", (req, res) => {
  res.json({
    status: "MEL est en ligne 🌲",
    cacheLastUpdate: siteCache.lastUpdate?.toLocaleString("fr-FR") || "jamais",
    cacheSize: `${Math.round(siteCache.content.length / 1024)} Ko`,
  });
});

// ─── Démarrage ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 MEL démarrée sur le port ${PORT}`);
  console.log(`📡 Webhook : /webhook`);
  console.log(`🔄 Rafraîchissement manuel : /refresh`);
  await refreshSiteCache();
});
