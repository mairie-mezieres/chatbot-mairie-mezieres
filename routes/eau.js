// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
//
// Restrictions sécheresse (VigiEau) — endpoints publics + cron de vérification.
//
// SÉPARATION STRICTE d'avec la vigilance Météo-France : ce flux ne touche jamais
// au bandeau de vigilance météo. Quand le niveau atteint « alerte » (2) ou plus,
// on publie une ACTUALITÉ distincte (source: 'vigieau') + push + Facebook, via les
// briques actu existantes.
//
// Ce qui déclenche (ou non) une notification est décidé par `decideDroughtAction`
// (lib/vigieau.js, fonction pure) : montée notifiée tout de suite, niveau inchangé
// jamais renotifié, baisse seulement sur lecture complète et confirmée. Ici on ne
// garde que la persistance (Redis + miroir mémoire) et le verrou anti-course.

const router = require("express").Router();
const { fetchVigieauStatus, vigieauSignature, decideDroughtAction, buildDroughtActu, droughtImageUrl } = require("../lib/vigieau");
const { readNews, writeNews } = require("../lib/store");
const { sendActuPush, publishActuToFacebook } = require("../lib/actu");
const { redisGet, redisSet, redisSetex, redisSetNxEx, redisDel } = require("../lib/redis");
const { AUTO_POST_DROUGHT_ALERTS } = require("../config");

const LAST_KEY = "mat:vigieau:last";          // dernier niveau notifié (dédup durable)
const PENDING_KEY = "mat:vigieau:pending";    // baisse en cours de confirmation
const RACE_TTL_S = 2 * 3600;                  // verrou anti-course (court)

// Miroir mémoire des deux clés (même principe que les listes programmées, ADR-0007) :
// `redisGet` renvoie `null` aussi bien pour « clé absente » que pour « Redis en
// hoquet (429, timeout) ». Sans ce miroir, un hoquet Redis effaçait la mémoire du
// dernier niveau notifié et relançait une notification identique.
let _lastMem = null;
let _pendingMem = null;

async function _readLast() {
  const v = await redisGet(LAST_KEY);
  if (v) _lastMem = v;
  return v || _lastMem;
}
async function _writeLast(v) {
  _lastMem = v;
  await redisSet(LAST_KEY, v).catch(() => {});
}
async function _readPending() {
  const v = await redisGet(PENDING_KEY);
  if (v) _pendingMem = v;
  return v || _pendingMem;
}
async function _writePending(v) {
  _pendingMem = v;
  if (v) await redisSet(PENDING_KEY, v).catch(() => {});
  else await redisDel(PENDING_KEY).catch(() => {});
}

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

    const [last, pending] = await Promise.all([_readLast(), _readPending()]);
    const sig = vigieauSignature(status);
    const decision = decideDroughtAction({ status, last, pending, force });
    const memorized = { sig, level: status.level, at: new Date().toISOString() };

    // Rien à notifier : niveau inchangé, sous le seuil, ou baisse pas encore
    // confirmée (dans ce dernier cas on garde en mémoire le niveau notifié —
    // `memorize: false` — pour ne pas voir le retour au niveau réel comme une
    // montée et renotifier).
    if (decision.action !== "publish") {
      if (decision.memorize) await _writeLast(memorized);
      await _writePending(decision.pending);
      if (decision.reason !== "unchanged" && decision.reason !== "below-threshold") {
        console.log(`🚱 VigiEau : niveau ${status.level} — ${decision.reason} (aucune notification)`);
      }
      return res.json({ status: decision.reason, level: status.level, complete: !!status.complete });
    }

    // Verrou anti-course : deux instances ne publient pas la même transition.
    if (!(await _claim(sig, force))) {
      return res.json({ status: "duplicate", level: status.level });
    }
    try {
      const out = await _publishDroughtActu(status);
      await _writeLast(memorized);
      await _writePending(null);
      console.log(`🚱 VigiEau : actu sécheresse publiée (niveau ${status.level}, ${decision.reason})`);
      return res.json({ status: "published", reason: decision.reason, level: status.level, ...out });
    } catch (e) {
      await _release(sig);
      throw e;
    }
  } catch (e) {
    console.error("🚱 VigiEau check error:", e.message);
    res.status(500).json({ error: "Contrôle sécheresse impossible", detail: e.message });
  }
});

module.exports = router;
