const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

// ─── Configuration ────────────────────────────────────────────────────────────
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Prompt système (base de connaissances de la mairie) ──────────────────────
const SYSTEM_PROMPT = `Tu es l'assistant virtuel de la mairie de Mézières-lez-Cléry, commune du Loiret (45370) en région Centre-Val de Loire, à l'orée de la Sologne, à 15 km d'Orléans.

📍 COORDONNÉES :
- Adresse : 36 rue du bourg – 45370 MÉZIÈRES-LEZ-CLÉRY
- Tél : 02 38 45 61 76
- Email : mairie@mezieres-lez-clery.fr
- Site : https://mezieres-lez-clery.fr

🕐 HORAIRES D'OUVERTURE :
- Lundi : 14h00 – 17h30
- Mercredi : sur rendez-vous uniquement
- Vendredi : 8h30 – 11h30
- Répondeur disponible en dehors de ces créneaux.

🏘️ LA COMMUNE :
- ~854 habitants (Macériens et Macériennes)
- 2 700 ha dont 70% de forêt
- Intercommunalité : Communauté de Communes des Terres du Val de Loire (CCTVL)

🏫 VIE SCOLAIRE ET ENFANCE :
- École de la Forêt
- Restaurant scolaire
- Accueil périscolaire
- Crèche familiale "Les Marmousets"
- Centre de loisirs
- Halte-garderie itinérante "Les Petits Faons"

🥾 RANDONNÉES :
- 3 circuits balisés au parking des "randonneurs" (sortie du Bourg direction Cléry-Saint-André)
- Parcours de 3 km à 21 km

🚌 TRANSPORTS :
- Ligne 8 réseau Ulys : Saint-Laurent-Nouan / Lailly-en-Val → Orléans via Cléry-Saint-André

♻️ DÉCHETS :
- Collecte SMIRTOM de Beaugency
- Ordures ménagères et emballages recyclables en porte à porte
- Verre et papiers en points d'apport volontaire

🏗️ URBANISME :
- PLU disponible en mairie et sur le site
- Dépôt permis de construire via portail numérique ou mairie

🌿 PATRIMOINE :
- Butte des Élus (tumulus gaulois classé 1924)
- Château (XVIIe s.)
- Église Saint-Avit (XVe s.)
- Vins AOC Orléans-Cléry et AOC Orléans

INSTRUCTIONS :
- Réponds en français, de façon conviviale, courte et précise (3-5 phrases max).
- Si tu ne sais pas, oriente vers la mairie : 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr
- Ne jamais inventer d'informations.
- Tu es sur Messenger : évite le Markdown (pas de **, pas de #). Utilise des emojis pour structurer.`;

// ─── Historique des conversations (en mémoire) ────────────────────────────────
// Clé = senderId, valeur = tableau de messages
const conversations = new Map();
const MAX_HISTORY = 10; // Nombre max de messages conservés par utilisateur

function getHistory(senderId) {
  if (!conversations.has(senderId)) {
    conversations.set(senderId, []);
  }
  return conversations.get(senderId);
}

function addToHistory(senderId, role, content) {
  const history = getHistory(senderId);
  history.push({ role, content });
  // Garder seulement les N derniers messages
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ─── Vérification du webhook (étape Meta) ─────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook vérifié par Meta");
    res.status(200).send(challenge);
  } else {
    console.error("❌ Échec de la vérification du webhook");
    res.sendStatus(403);
  }
});

// ─── Réception des messages Messenger ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") return res.sendStatus(404);

  // Accusé de réception immédiat (obligatoire dans les 20s pour Meta)
  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry) {
    const events = entry.messaging;
    if (!events) continue;

    for (const event of events) {
      const senderId = event.sender.id;

      // Message texte reçu
      if (event.message && event.message.text) {
        const userText = event.message.text;
        console.log(`📩 Message de ${senderId} : ${userText}`);

        await handleMessage(senderId, userText);
      }

      // Bouton "Commencer" ou postback
      if (event.postback) {
        const payload = event.postback.payload;
        if (payload === "GET_STARTED") {
          await sendMessage(
            senderId,
            "🌲 Bonjour et bienvenue ! Je suis l'assistant de la mairie de Mézières-lez-Cléry.\n\nJe peux vous renseigner sur :\n🕐 Les horaires d'ouverture\n📋 Les démarches administratives\n🏫 La vie scolaire\n🥾 Les randonnées\n♻️ Les déchets\n\nComment puis-je vous aider ?"
          );
        }
      }
    }
  }
});

// ─── Traitement du message via Claude ─────────────────────────────────────────
async function handleMessage(senderId, userText) {
  try {
    // Indicateur de frappe
    await sendTypingOn(senderId);

    // Ajouter le message à l'historique
    addToHistory(senderId, "user", userText);

    // Appel à l'API Claude
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: getHistory(senderId),
    });

    const reply = response.content[0].text;

    // Ajouter la réponse à l'historique
    addToHistory(senderId, "assistant", reply);

    // Envoyer la réponse
    await sendMessage(senderId, reply);
    console.log(`✅ Réponse envoyée à ${senderId}`);

  } catch (error) {
    console.error("❌ Erreur Claude :", error.message);
    await sendMessage(
      senderId,
      "Désolé, je rencontre une difficulté technique. Veuillez contacter la mairie directement au 02 38 45 61 76 ou par email : mairie@mezieres-lez-clery.fr"
    );
  }
}

// ─── Envoi d'un message via l'API Messenger ───────────────────────────────────
async function sendMessage(recipientId, text) {
  // Messenger limite les messages à 2000 caractères
  const chunks = splitMessage(text, 1900);

  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text: chunk },
        messaging_type: "RESPONSE",
      }
    );
  }
}

// Indicateur "en train d'écrire..."
async function sendTypingOn(recipientId) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      recipient: { id: recipientId },
      sender_action: "typing_on",
    }
  );
}

// Découpe les longs messages en morceaux
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end < text.length) {
      // Couper proprement à un saut de ligne ou un espace
      const lastNewline = text.lastIndexOf("\n", end);
      const lastSpace   = text.lastIndexOf(" ", end);
      end = lastNewline > start + 100 ? lastNewline : lastSpace > start + 100 ? lastSpace : end;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

// ─── Démarrage du serveur ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📡 Webhook disponible sur /webhook`);
});
