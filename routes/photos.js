// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
// Galerie photos communautaires : soumission par les habitants,
// modération mairie (status pending → approved), votes dédupliqués
// par device-id (même pattern que routes/idees.js).
"use strict";
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { readPhotos, writePhotos, readAdminSettings } = require("../lib/store");
const { adminAuth } = require("../lib/middleware");
const { redisSismember, redisSadd, redisSrem, _isRedis429 } = require("../lib/redis");
const { CLOUDINARY_ENABLED, uploadGaleriePhotoToCloudinary, deleteGaleriePhotoFromCloudinary } = require("../lib/cloudinary");

const MAX_PHOTOS = 300;

function getDeviceId(req) {
  const raw = (req.headers["x-device-id"] || "").toString().trim();
  return /^[\w-]{4,100}$/.test(raw) ? raw : null;
}

async function reactionsAllowed() {
  if (_isRedis429()) return false;
  try { const s = await readAdminSettings(); return s.reactionsEnabled !== false; }
  catch (e) { return true; }
}

const photoUploadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop d'envois, patientez avant de réessayer." }
});

// Vue publique d'une photo : on ne renvoie ni le deviceId du soumetteur
// ni le publicId Cloudinary.
function publicPhoto(p) {
  return { id: p.id, url: p.url, desc: p.desc, lieu: p.lieu, votes: p.votes || 0, date: p.date };
}

// ── Public ────────────────────────────────────────────────────

router.get("/photos", async (req, res) => {
  const photos = await readPhotos();
  const approved = photos.filter(p => p.status === "approved")
    .sort((a, b) => (b.votes || 0) - (a.votes || 0));
  res.json({ photos: approved.map(publicPhoto), count: approved.length });
});

router.post("/photos", photoUploadLimiter, async (req, res) => {
  const { desc, lieu, photoB64, deviceId } = req.body || {};
  if (!photoB64 || !String(photoB64).startsWith("data:image")) {
    return res.status(400).json({ error: "photoB64 requis (data:image/...)" });
  }
  if (!CLOUDINARY_ENABLED) return res.status(503).json({ error: "Stockage photos non configuré" });

  try {
    const up = await uploadGaleriePhotoToCloudinary(photoB64);
    const photos = await readPhotos();
    const photo = {
      id: Date.now(),
      url: up.secure_url,
      publicId: up.public_id,
      desc: desc ? String(desc).substring(0, 200) : "",
      lieu: lieu ? String(lieu).substring(0, 100) : "",
      votes: 0,
      status: "pending",
      date: new Date().toISOString(),
      ...(deviceId && /^[\w-]{4,100}$/.test(String(deviceId)) ? { deviceId: String(deviceId) } : {})
    };
    photos.unshift(photo);
    // Purge au-delà du plafond : les plus anciennes non approuvées d'abord,
    // sinon les plus anciennes tout court (les photos sont triées récentes en tête).
    while (photos.length > MAX_PHOTOS) {
      const idx = photos.findLastIndex(p => p.status !== "approved");
      photos.splice(idx >= 0 ? idx : photos.length - 1, 1);
    }
    await writePhotos(photos);
    console.log(`📸 Photo galerie soumise (#${photo.id}) — en attente de modération`);
    res.json({ success: true, id: photo.id, status: "pending" });
  } catch (e) {
    console.error("POST /photos:", e.message);
    res.status(500).json({ error: "Erreur lors de l'envoi" });
  }
});

router.post("/photos/:id/vote", async (req, res) => {
  if (!await reactionsAllowed()) return res.status(503).json({ error: "Réactions désactivées" });
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "device-id requis" });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "id invalide" });
  const key = "mat:votes:photo:" + id;

  try {
    const alreadyVoted = await redisSismember(key, deviceId);
    if (alreadyVoted) return res.status(409).json({ error: "Déjà voté", voted: true });

    const photos = await readPhotos();
    const idx = photos.findIndex(p => p.id === id && p.status === "approved");
    if (idx < 0) return res.status(404).json({ error: "Photo non trouvée" });

    await redisSadd(key, deviceId);
    photos[idx].votes = (photos[idx].votes || 0) + 1;
    await writePhotos(photos);
    res.json({ success: true, votes: photos[idx].votes, voted: true });
  } catch (e) {
    console.error("POST /photos/:id/vote:", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/photos/:id/vote", async (req, res) => {
  if (!await reactionsAllowed()) return res.status(503).json({ error: "Réactions désactivées" });
  const deviceId = getDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: "device-id requis" });

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "id invalide" });
  const key = "mat:votes:photo:" + id;

  try {
    const wasVoted = await redisSismember(key, deviceId);
    if (!wasVoted) return res.status(409).json({ error: "Pas encore voté", voted: false });

    const photos = await readPhotos();
    const idx = photos.findIndex(p => p.id === id && p.status === "approved");
    if (idx < 0) return res.status(404).json({ error: "Photo non trouvée" });

    await redisSrem(key, deviceId);
    photos[idx].votes = Math.max(0, (photos[idx].votes || 1) - 1);
    await writePhotos(photos);
    res.json({ success: true, votes: photos[idx].votes, voted: false });
  } catch (e) {
    console.error("DELETE /photos/:id/vote:", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Admin (modération) ────────────────────────────────────────

router.get("/admin/photos", adminAuth, async (req, res) => {
  const photos = await readPhotos();
  res.json({ photos, count: photos.length });
});

router.post("/admin/photos/:id/approve", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "id invalide" });
  const photos = await readPhotos();
  const idx = photos.findIndex(p => p.id === id);
  if (idx < 0) return res.status(404).json({ error: "Photo non trouvée" });
  photos[idx].status = "approved";
  await writePhotos(photos);
  console.log(`✅ Photo galerie #${id} approuvée`);
  res.json({ success: true });
});

router.delete("/admin/photos/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "id invalide" });
  const photos = await readPhotos();
  const idx = photos.findIndex(p => p.id === id);
  if (idx < 0) return res.status(404).json({ error: "Photo non trouvée" });
  const [removed] = photos.splice(idx, 1);
  await writePhotos(photos);
  if (removed.publicId) {
    deleteGaleriePhotoFromCloudinary(removed.publicId).catch(e =>
      console.warn("⚠️ Suppression Cloudinary échouée:", e.message));
  }
  console.log(`🗑️ Photo galerie #${id} supprimée`);
  res.json({ success: true });
});

module.exports = router;
