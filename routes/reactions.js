// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { readAdminSettings, readNews, writeNews } = require("../lib/store");
const { redisGet, redisSet, redisSismember, redisSadd, redisSrem, _isRedis429 } = require("../lib/redis");
const { inEnum } = require("../lib/validate");

// ─── Helpers ────────────────────────────────────────────────────────────────

function getDeviceId(req) {
  const raw = (req.headers["x-device-id"] || "").toString().trim();
  // Accepte uniquement les device-ids MAT valides (format mat-xxxxx ou mat-xxxxx-xxx-xxx)
  return /^[\w-]{4,100}$/.test(raw) ? raw : null;
}

async function reactionsAllowed() {
  // Quota Redis dépassé (429) : on coupe les réactions pour éviter que les
  // compteurs ne gonflent sans déduplication (sismember renvoie false en
  // mode dégradé, ce qui ferait incrémenter à chaque clic sans pouvoir annuler).
  if (_isRedis429()) return false;
  try {
    const s = await readAdminSettings();
    return s.reactionsEnabled !== false;
  } catch (e) { return true; }
}

// ─── Config publique ─────────────────────────────────────────────────────────

router.get("/config/features", async (req, res) => {
  if (_isRedis429()) return res.json({ reactionsEnabled: false });
  try {
    const s = await readAdminSettings();
    res.json({ reactionsEnabled: s.reactionsEnabled !== false });
  } catch (e) {
    res.json({ reactionsEnabled: true });
  }
});

// ─── Likes actualités ────────────────────────────────────────────────────────
// Le compteur est stocké directement dans le JSON mat:actus (champ a.likes).
// Le Redis Set mat:likes:actu:{id} sert uniquement à la déduplication par device.

router.get("/actu/:id/likes", async (req, res) => {
  try {
    const id = req.params.id;
    const deviceId = getDeviceId(req);
    const liked = deviceId ? await redisSismember("mat:likes:actu:" + id, deviceId) : false;
    // Le count vient du JSON actus — on le lit ici pour la vue détail
    const actus = await readNews();
    const actu = actus.find(a => String(a.id) === String(id));
    res.json({ count: actu ? (actu.likes || 0) : 0, liked });
  } catch (e) {
    res.json({ count: 0, liked: false });
  }
});

router.post("/actu/:id/like", async (req, res) => {
  if (!await reactionsAllowed()) return res.status(503).json({ error: "Réactions désactivées" });
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "device-id requis" });

  try {
    const id = req.params.id;
    const key = "mat:likes:actu:" + id;
    const alreadyLiked = await redisSismember(key, deviceId);

    if (alreadyLiked) {
      await redisSrem(key, deviceId);
    } else {
      await redisSadd(key, deviceId);
    }
    const liked = !alreadyLiked;

    // Met à jour le compteur dans le JSON actus
    const actus = await readNews();
    const idx = actus.findIndex(a => String(a.id) === String(id));
    if (idx >= 0) {
      actus[idx].likes = Math.max(0, (actus[idx].likes || 0) + (liked ? 1 : -1));
      await writeNews(actus);
    }
    const count = idx >= 0 ? actus[idx].likes : 0;
    res.json({ count, liked });
  } catch (e) {
    console.error("POST /actu/:id/like:", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ─── RSVP événements ─────────────────────────────────────────────────────────
// Compteur stocké dans mat:rsvp:event:{uid}:count (clé simple GET/SET).
// Redis Set mat:rsvp:event:{uid} pour la déduplication.

const RSVP_COUNT_KEY = uid => "mat:rsvp:event:" + uid + ":count";
const RSVP_SET_KEY   = uid => "mat:rsvp:event:" + uid;

router.get("/event/:uid/rsvp", async (req, res) => {
  try {
    const uid = req.params.uid;
    const deviceId = getDeviceId(req);
    const count = (await redisGet(RSVP_COUNT_KEY(uid))) || 0;
    const rsvp = deviceId ? await redisSismember(RSVP_SET_KEY(uid), deviceId) : false;
    res.json({ count, rsvp });
  } catch (e) {
    res.json({ count: 0, rsvp: false });
  }
});

router.post("/event/:uid/rsvp", async (req, res) => {
  if (!await reactionsAllowed()) return res.status(503).json({ error: "Réactions désactivées" });
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "device-id requis" });

  try {
    const uid = req.params.uid;
    const setKey   = RSVP_SET_KEY(uid);
    const countKey = RSVP_COUNT_KEY(uid);

    const alreadyRsvp = await redisSismember(setKey, deviceId);
    if (alreadyRsvp) {
      await redisSrem(setKey, deviceId);
    } else {
      await redisSadd(setKey, deviceId);
    }
    const rsvp = !alreadyRsvp;

    const current = (await redisGet(countKey)) || 0;
    const newCount = Math.max(0, current + (rsvp ? 1 : -1));
    await redisSet(countKey, newCount);

    res.json({ count: newCount, rsvp });
  } catch (e) {
    console.error("POST /event/:uid/rsvp:", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ─── « Le saviez-vous ? » — répartition des réponses ─────────────────────────
// Alimente la ligne « X % des Macérien(ne)s ont répondu comme vous ». Même
// motif que les RSVP ci-dessus : un Set Redis pour dédupliquer par appareil,
// un compteur. Le nombre de clés est borné par la taille du corpus (quelques
// centaines d'entrées dans app-mezieres/data/saviez-vous.json), il n'y a donc
// pas de croissance non bornée à purger.
//
// Le contenu du fait N'EST PAS ici : il vit dans le dépôt frontend, versionné
// et relu. Le backend ne connaît que des identifiants et des compteurs.

const SV_SET_KEY   = id => "mat:sv:votants:" + id;
const SV_COUNT_KEY = id => "mat:sv:count:" + id;

// Les identifiants viennent du corpus frontend (« calc-orleans », « plu-approbation »…).
// safeId() de lib/validate.js ne vaut que pour des entiers : on valide ici le
// format textuel, sur le modèle de getDeviceId ci-dessus.
function svId(raw) {
  const s = (raw || "").toString().trim();
  return /^[a-z0-9-]{2,64}$/i.test(s) ? s : null;
}

async function svCounts(id) {
  const d = await redisGet(SV_COUNT_KEY(id));
  return {
    oui: Number(d && d.oui) || 0,
    non: Number(d && d.non) || 0
  };
}

router.get("/saviezvous/:id", async (req, res) => {
  try {
    const id = svId(req.params.id);
    if (!id) return res.status(400).json({ error: "identifiant invalide" });
    const deviceId = getDeviceId(req);
    const c = await svCounts(id);
    const moi = deviceId ? await redisSismember(SV_SET_KEY(id), deviceId) : false;
    res.json({ oui: c.oui, non: c.non, moi });
  } catch (e) {
    // Best-effort : le frontend masque simplement le pourcentage.
    res.json({ oui: 0, non: 0, moi: false });
  }
});

router.post("/saviezvous/:id", async (req, res) => {
  if (!await reactionsAllowed()) return res.status(503).json({ error: "Réactions désactivées" });

  const id = svId(req.params.id);
  if (!id) return res.status(400).json({ error: "identifiant invalide" });

  const reponse = inEnum((req.body || {}).reponse, ["oui", "non"]);
  if (!reponse) return res.status(400).json({ error: "réponse attendue : oui ou non" });

  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "device-id requis" });

  try {
    // Une seule réponse par appareil et par fait : on ne retire jamais, à la
    // différence d'un RSVP. La répartition doit rester le reflet des premières
    // intuitions, pas d'un vote qu'on corrige après avoir lu la réponse.
    const deja = await redisSismember(SV_SET_KEY(id), deviceId);
    const c = await svCounts(id);
    if (deja) return res.json(c);

    await redisSadd(SV_SET_KEY(id), deviceId);
    c[reponse] = c[reponse] + 1;
    await redisSet(SV_COUNT_KEY(id), c);

    res.json(c);
  } catch (e) {
    console.error("POST /saviezvous/:id:", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

module.exports = router;
