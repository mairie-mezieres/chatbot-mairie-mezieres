// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { adminAuth } = require("../lib/middleware");
const { readNews, writeNews, readSubs } = require("../lib/store");
const { redisGet, redisSet } = require("../lib/redis");
const { uploadActuImageToCloudinary, deleteActuImageFromCloudinary } = require("../lib/cloudinary");
const { publishActuToFacebook, sendActuPush } = require("../lib/actu");
const { getGoogleCalendarClient, upsertGoogleCalendarEvent } = require("../lib/calendar");

const PUSH_HISTORY_KEY = 'mat:push:history';

// ── Route : publier une actualité (multi-canal) ─────────────
router.post("/admin/actus/add", adminAuth, async (req, res) => {
  const {
    title,
    description,
    imageBase64,           // data URL : "data:image/jpeg;base64,..."
    imageUrl,              // URL externe (fallback si pas d'upload)
    eventDate,             // ISO : "2026-05-15T18:30" ou "2026-05-15"
    eventLocation,
    publishFacebook = true,
    sendPush = true,
    createCalendar = true  // automatiquement false si pas de eventDate
  } = req.body || {};

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "title requis" });
  }

  if (publishFacebook && !imageBase64) {
    return res.status(400).json({ error: "imageBase64 requis pour publier sur Facebook avec image" });
  }

  const cleanTitle = String(title).trim().substring(0, 150);
  const cleanDescription = String(description || "").trim().substring(0, 3000);

  const result = {
    ok: true,
    actu: null,
    facebook: null,
    cloudinary: null,
    push: null,
    calendar: null,
    warnings: []
  };

  // 1. Uploader l'image vers Cloudinary en premier pour stocker une URL stable + public_id supprimable
  let finalPhotoUrl = imageUrl || null;
  let finalPhotoPublicId = null;
  if (imageBase64) {
    try {
      const upload = await uploadActuImageToCloudinary(imageBase64);
      finalPhotoUrl = upload.secure_url || upload.url || finalPhotoUrl;
      finalPhotoPublicId = upload.public_id || null;
      result.cloudinary = {
        ok: true,
        public_id: upload.public_id,
        asset_id: upload.asset_id || null,
        secure_url: upload.secure_url || upload.url || null
      };
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Cloudinary: " + e.message });
    }
  }

  // 2. Publier sur Facebook avec image quand imageBase64 est fourni.
  //    Si l'image Facebook échoue, on annule la création pour éviter une actu partielle.
  if (publishFacebook) {
    try {
      const fbResult = await publishActuToFacebook(
        cleanTitle,
        cleanDescription,
        imageBase64,
        eventDate,
        eventLocation
      );
      result.facebook = fbResult;
    } catch (e) {
      if (finalPhotoPublicId) {
        try { await deleteActuImageFromCloudinary(finalPhotoPublicId); } catch (_) {}
      }
      return res.status(502).json({ ok: false, error: "Facebook: " + e.message });
    }
  }

  // 3. Stocker l'actu dans Redis (pour affichage dans la PWA)
  const actus = await readNews();
  const actu = {
    id: Date.now(),
    title: cleanTitle,
    description: cleanDescription || null,
    date: new Date().toLocaleDateString("fr-FR"),
    dateISO: new Date().toISOString().slice(0, 10),
    photo: finalPhotoUrl,
    photoPublicId: finalPhotoPublicId,
    eventDate: eventDate || null,
    eventLocation: eventLocation || null,
    source: "admin"
  };
  actus.unshift(actu);
  if (actus.length > 30) actus.splice(30);
  await writeNews(actus);
  result.actu = actu;

  // 4. Envoyer notification push
  if (sendPush) {
    try {
      result.push = await sendActuPush(cleanTitle, cleanDescription, finalPhotoUrl, actu.id);
    } catch (e) {
      result.warnings.push("Push: " + e.message);
      result.push = { ok: false, error: e.message };
    }
  }

  // 5. Créer/remplacer événement Google Agenda
  if (createCalendar && eventDate) {
    try {
      result.calendar = await upsertGoogleCalendarEvent(
        cleanTitle,
        cleanDescription,
        eventDate,
        eventLocation
      );
    } catch (e) {
      result.warnings.push("Calendar: " + e.message);
      result.calendar = { ok: false, error: e.message };
    }
  }

  res.json(result);
});

// ── Modifier une actu (titre, desc, date, lieu + re-publication optionnelle) ──
router.patch("/admin/actus/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { title, description, eventDate, eventLocation, publishFacebook, sendPush, createCalendar } = req.body || {};
  const actus = await readNews();
  const idx = actus.findIndex(a => a.id === id);
  if (idx < 0) return res.status(404).json({ error: "Actu non trouvée" });
  const actu = { ...actus[idx] };
  if (title       !== undefined) actu.title         = String(title).trim().substring(0, 150);
  if (description !== undefined) actu.description   = String(description || "").trim().substring(0, 3000) || null;
  if (eventDate   !== undefined) actu.eventDate      = eventDate || null;
  if (eventLocation !== undefined) actu.eventLocation = eventLocation ? String(eventLocation).substring(0, 200) : null;
  actus[idx] = actu;
  await writeNews(actus);
  const result = { ok: true, actu, facebook: null, push: null, calendar: null, warnings: [] };
  if (publishFacebook) {
    try { result.facebook = await publishActuToFacebook(actu.title, actu.description, null, actu.eventDate, actu.eventLocation); }
    catch (e) { result.warnings.push("Facebook: " + e.message); result.facebook = { ok: false, error: e.message }; }
  }
  if (sendPush) {
    try { result.push = await sendActuPush(actu.title, actu.description, actu.photo, actu.id); }
    catch (e) { result.warnings.push("Push: " + e.message); result.push = { ok: false, error: e.message }; }
  }
  if (createCalendar && actu.eventDate) {
    try { result.calendar = await upsertGoogleCalendarEvent(actu.title, actu.description, actu.eventDate, actu.eventLocation); }
    catch (e) { result.warnings.push("Calendar: " + e.message); result.calendar = { ok: false, error: e.message }; }
  }
  res.json(result);
});

// ── Notifications push programmées ──────────────────────────
router.post("/admin/push/schedule", adminAuth, async (req, res) => {
  const { title, body, photoUrl, scheduledAt, actuId } = req.body || {};
  if (!title || !scheduledAt) return res.status(400).json({ error: "title et scheduledAt requis" });
  const scheduled = (await redisGet('mat:push:scheduled')) || [];
  const notif = {
    id: Date.now(),
    actuId: actuId || null,
    title: String(title).substring(0, 150),
    body: String(body || "").substring(0, 300),
    photoUrl: photoUrl || null,
    scheduledAt: new Date(scheduledAt).toISOString(),
    sent: false,
    sentAt: null
  };
  scheduled.push(notif);
  await redisSet('mat:push:scheduled', scheduled);
  res.json({ ok: true, notif });
});

router.delete("/admin/push/schedule/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const scheduled = (await redisGet('mat:push:scheduled')) || [];
  await redisSet('mat:push:scheduled', scheduled.filter(n => n.id !== id));
  res.json({ ok: true });
});

// Historique des envois push (50 derniers) + nb d'abonnés vivants actuels
router.get("/admin/push/history", adminAuth, async (req, res) => {
  const [history, subs] = await Promise.all([
    redisGet(PUSH_HISTORY_KEY),
    readSubs()
  ]);
  res.json({ history: history || [], aliveSubs: subs.length });
});

// ── Route : lister événements calendar d'un jour donné (doublon check) ──
router.get("/admin/calendar/day", adminAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date requise (YYYY-MM-DD)" });

  const calendar = getGoogleCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendar || !calendarId) {
    return res.json({ ok: false, events: [], error: "Calendar non configuré" });
  }

  try {
    const dayStart = new Date(date + "T00:00:00");
    const dayEnd = new Date(date + "T23:59:59");
    const list = await calendar.events.list({
      calendarId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime"
    });
    const events = (list.data.items || []).map(e => ({
      id: e.id,
      summary: e.summary,
      description: e.description,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location
    }));
    res.json({ ok: true, events });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Cron : envoi des notifications push programmées (toutes les minutes) ──
const PUSH_SCHEDULED_MAX_RETRIES = 3;
setInterval(async () => {
  try {
    const now = Date.now();
    const scheduled = (await redisGet('mat:push:scheduled')) || [];
    const due = scheduled.filter(n => !n.sent && !n.failed && new Date(n.scheduledAt).getTime() <= now);
    if (!due.length) return;
    for (const notif of due) {
      // Marquer "envoyé" AVANT l'envoi pour ne pas retenter en boucle si
      // sendActuPush (ou readSubs sous-jacent) lance. Restauré si l'envoi
      // échoue, et plafonné par PUSH_SCHEDULED_MAX_RETRIES pour éviter les
      // notifications fantômes en cas de hiccup persistant.
      notif.sent = true;
      notif.sentAt = new Date().toISOString();
      try {
        await sendActuPush(notif.title, notif.body, notif.photoUrl, notif.actuId);
        console.log(`🔔 Push programmé envoyé : "${notif.title}"`);
      } catch (e) {
        notif.sent = false;
        notif.sentAt = null;
        notif.retries = (notif.retries || 0) + 1;
        if (notif.retries >= PUSH_SCHEDULED_MAX_RETRIES) {
          notif.failed = true;
          notif.failedAt = new Date().toISOString();
          notif.failedReason = String((e && e.message) || e).slice(0, 200);
          console.warn(`Push programmé abandonné après ${notif.retries} tentatives: "${notif.title}" — ${notif.failedReason}`);
        } else {
          console.warn(`Push programmé erreur (tentative ${notif.retries}/${PUSH_SCHEDULED_MAX_RETRIES}):`, e.message);
        }
      }
    }
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const remaining = scheduled.filter(n => (!n.sent && !n.failed) || new Date(n.scheduledAt).getTime() > cutoff);
    await redisSet('mat:push:scheduled', remaining);
  } catch (e) { console.warn('Cron push schedulé:', e.message); }
}, 60 * 1000);

module.exports = router;
