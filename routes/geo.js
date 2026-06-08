// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const { MISTRAL_API_KEY, MISTRAL_MODEL, MISTRAL_URL } = require("../config");
const { melLimiter } = require("../lib/middleware");
const { trackIaTokens } = require("../lib/stats");

// ── Proxy IGN — détection zone PLU par coordonnées GPS ────────
router.get("/api/zone-plu", async (req, res) => {
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

// ── Proxy Overpass OSM — réseau de chemins de Mézières ───────
// Évite les problèmes CORS depuis le front PWA
router.get("/api/chemins", async (req, res) => {
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
router.post("/api/parcours", melLimiter, async (req, res) => {
  const { mode, distance, style } = req.body || {};

  const modeLabels = { pied: "à pied", velo: "à vélo", cheval: "à cheval" };
  const styleLabels = {
    nature:     "nature & chemins de terre",
    patrimoine: "patrimoine & bourg historique",
    vignes:     "vignes & campagne agricole",
    mixte:      "mixte et varié"
  };

  if (!modeLabels[mode]) return res.status(400).json({ error: "mode invalide (pied|velo|cheval)" });
  const distanceNum = parseFloat(distance);
  if (!distanceNum || distanceNum < 1 || distanceNum > 50) return res.status(400).json({ error: "distance invalide (1–50 km)" });
  if (style && !styleLabels[style]) return res.status(400).json({ error: "style invalide" });

  if (!MISTRAL_API_KEY) {
    return res.status(500).json({ error: "MISTRAL_API_KEY manquante" });
  }

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

Les waypoints doivent former une boucle réaliste de ~${distanceNum} km au départ du parking (47.8185,1.8095), avec 8 à 14 points. Adapte le tracé au mode ${modeLabels[mode]} et à l'ambiance ${styleLabels[style] || styleLabels.mixte}. Pour le vélo, privilégie routes et chemins larges. Pour le cheval, évite les routes principales.`;

  try {
    const r = await axios.post(
      MISTRAL_URL,
      {
        model: MISTRAL_MODEL,
        temperature: 0.6,
        max_tokens: 600,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Génère un parcours ${modeLabels[mode]} de ${distanceNum} km, ambiance ${styleLabels[style] || styleLabels.mixte}.` }
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

module.exports = router;
