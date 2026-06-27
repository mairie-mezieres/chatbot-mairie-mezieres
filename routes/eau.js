// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
//
// Restrictions sécheresse (VigiEau) — endpoints publics + cron de vérification.
//
// SÉPARATION STRICTE d'avec la vigilance Météo-France : ce flux ne touche jamais
// au bandeau de vigilance météo. Quand le niveau atteint « alerte » (2) ou plus,
// on publie une ACTUALITÉ distincte (source: 'vigieau') + push + Facebook, via les
// briques actu existantes. Calqué sur routes/meteo.js (dédup signature + verrou).

const router = require("express").Router();
const { fetchVigieauStatus, vigieauSignature, buildDroughtActu, droughtImageUrl } = require("../lib/vigieau");
const { readNews, writeNews } = require("../lib/store");
const { sendActuPush, publishActuToFacebook } = require("../lib/actu");
const { redisGet, redisSet, redisSetex, redisSetNxEx, redisDel } = require("../lib/redis");
const { AUTO_POST_DROUGHT_ALERTS } = require("../config");

const LAST_KEY = "mat:vigieau:last";          // dernière signature postée (dédup durable)
const RACE_TTL_S = 2 * 3600;                  // verrou anti-course (court)

function _claimKey(sig) { return `mat:vigieau:claim:${sig}`; }

async function _claim(sig, force) {
  const key = _claimKey(sig);
  if (force) { await redisSetex(key, RACE_TTL_S, { at: new Date().toISOString() }); return true; }
  const claim = await redisSetNxEx(key, { at: new Date().toISOString() }, RACE_TTL_S);
  // true = réservé → agir ; false = déjà réservé → s'abstenir ; null = Redis indéterminé → agir.
  return claim !== false;
}
async function _release(sig) { try { await redisDel(_claimKey(sig)); } catch (_) {} }

// Crée l'actualité sécheresse (liste actus) + push + Facebook.
async function _publishDroughtActu(status) {
  const { title, description } = buildDroughtActu(status);
  const imageUrl = droughtImageUrl(status.level); // carte 1200×630 par niveau (ou « fin »)
  const actus = await readNews();
  const actu = {
    id: Date.now(),
    title,
    description,
    date: new Date().toLocaleDateString("fr-FR"),
    dateISO: new Date().toISOString().slice(0, 10),
    photo: imageUrl,
    source: "vigieau",
  };
  actus.unshift(actu);
  if (actus.length > 30) actus.splice(30);
  await writeNews(actus);

  const push = await sendActuPush(title, description, imageUrl, actu.id).catch((e) => {
    console.warn("Sécheresse push:", e.message);
    return null;
  });

  let fb = null;
  if (AUTO_POST_DROUGHT_ALERTS) {
    // Image par URL (pas de #MAT dans le texte) → pas de ré-ingestion par le webhook.
    fb = await publishActuToFacebook(title, description, null, null, null, imageUrl).catch((e) => {
      console.warn("Sécheresse Facebook:", e.message);
      return null;
    });
  }
  return { actuId: actu.id, push, fb };
}

// ── Statut courant (public) ──────────────────────────────────
router.get("/eau/restrictions", async (req, res) => {
  try {
    const status = await fetchVigieauStatus();
    res.set("Access-Control-Allow-Origin", "*");
    res.json(status);
  } catch (e) {
    res.set("Access-Control-Allow-Origin", "*");
    res.status(503).json({ level: null, reason: "error", detail: e.message });
  }
});

// ── Vérification + publication (cron) ────────────────────────
router.get("/eau/restrictions/check", async (req, res) => {
  const force = req.query.force === "1" || req.query.force === "true";
  try {
    const status = await fetchVigieauStatus();

    // Niveau indéterminé (API injoignable, 409, corps invalide) : on ne poste rien,
    // on ne touche pas au dernier état mémorisé.
    if (status.level == null) {
      console.log(`🚱 VigiEau : statut indéterminé (${status.reason || "?"}) — aucune action`);
      return res.json({ status: "unknown", detail: status.reason || null });
    }

    const last = await redisGet(LAST_KEY); // { sig, level, at }
    const lastLevel = last && typeof last.level === "number" ? last.level : 0;
    const sig = vigieauSignature(status);

    // Montée / changement d'arrêté au niveau alerte (2) et plus.
    if (status.level >= 2) {
      if (!force && last && last.sig === sig) {
        return res.json({ status: "duplicate", level: status.level });
      }
      if (!(await _claim(sig, force))) {
        return res.json({ status: "duplicate", level: status.level });
      }
      try {
        const out = await _publishDroughtActu(status);
        await redisSet(LAST_KEY, { sig, level: status.level, at: new Date().toISOString() });
        console.log(`🚱 VigiEau : actu sécheresse publiée (niveau ${status.level})`);
        return res.json({ status: "published", level: status.level, ...out });
      } catch (e) {
        await _release(sig);
        throw e;
      }
    }

    // Levée : on était en alerte (≥2), on repasse sous le seuil → actu « fin des restrictions ».
    if (lastLevel >= 2 && status.level < 2) {
      const liftSig = `lift|${sig}`;
      if (force || !last || last.sig !== liftSig) {
        if (await _claim(liftSig, force)) {
          try {
            const out = await _publishDroughtActu(status);
            await redisSet(LAST_KEY, { sig: liftSig, level: status.level, at: new Date().toISOString() });
            console.log("🚱 VigiEau : fin des restrictions publiée");
            return res.json({ status: "lifted", level: status.level, ...out });
          } catch (e) {
            await _release(liftSig);
            throw e;
          }
        }
      }
    }

    // Sous le seuil (vigilance ou aucune) sans transition à notifier : on mémorise l'état.
    await redisSet(LAST_KEY, { sig, level: status.level, at: new Date().toISOString() });
    return res.json({ status: "below-threshold", level: status.level });
  } catch (e) {
    console.error("🚱 VigiEau check error:", e.message);
    res.status(500).json({ error: "Contrôle sécheresse impossible", detail: e.message });
  }
});

module.exports = router;
