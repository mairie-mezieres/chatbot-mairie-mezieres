// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { adminAuth } = require("../lib/middleware");
const { readNews, writeNews, readSubs, memGet, memSet } = require("../lib/store");
const { redisGet, redisSet } = require("../lib/redis");
const { uploadActuImageToCloudinary, deleteActuImageFromCloudinary } = require("../lib/cloudinary");
const { publishActuToFacebook, sendActuPush } = require("../lib/actu");
const { getGoogleCalendarClient, upsertGoogleCalendarEvent } = require("../lib/calendar");

const PUSH_HISTORY_KEY = 'mat:push:history';
const PUSH_SCHEDULED_KEY = 'mat:push:scheduled';

// ── Miroir mémoire des listes programmées (push + actus) ─────
// Les deux crons ci-dessous tournent toutes les minutes (précision d'envoi à
// la minute), mais leurs listes sont vides l'immense majorité du temps :
// relire Redis à chaque tick coûtait ~2 880 commandes/jour à lui seul
// (~29 % du quota Upstash gratuit). On lit donc un miroir mémoire, mis à
// jour immédiatement par les routes admin qui créent/annulent une
// programmation (instance unique), et re-synchronisé depuis Redis toutes
// les SCHED_MEM_TTL pour couvrir un redémarrage ou une écriture perdue.
const SCHED_MEM_TTL = 10 * 60 * 1000;
async function readScheduled(key) {
  const c = memGet(key);
  if (c !== undefined) return c;
  const v = (await redisGet(key)) || [];
  memSet(key, v, SCHED_MEM_TTL);
  return v;
}
async function writeScheduled(key, d) {
  memSet(key, d, SCHED_MEM_TTL);
  await redisSet(key, d);
}

// ── Cœur de publication multi-canal (réutilisé : immédiat + programmé) ──
// Publie une actu sur les canaux choisis. Lève une erreur taguée (er.cloudFail /
// er.fbFail) en cas d'échec atomique, avec rollback de l'image Cloudinary si elle
// vient d'être uploadée. imageBase64 = upload + post photo multipart ; imageUrl =
// image déjà hébergée (post photo par URL — cas des publications programmées).
async function publishActu(opts) {
  const {
    title, description,
    imageBase64 = null, imageUrl = null, photoPublicId = null,
    eventDate = null, eventLocation = null,
    publishFacebook = true, sendPush = true, createCalendar = true
  } = opts || {};

  const cleanTitle = String(title).trim().substring(0, 150);
  const cleanDescription = String(description || "").trim().substring(0, 3000);
  const result = { ok: true, actu: null, facebook: null, cloudinary: null, push: null, calendar: null, warnings: [] };

  // 1. Image : upload Cloudinary si base64 fourni (sinon URL déjà hébergée).
  let finalPhotoUrl = imageUrl || null;
  let finalPhotoPublicId = photoPublicId || null;
  if (imageBase64) {
    try {
      const upload = await uploadActuImageToCloudinary(imageBase64);
      finalPhotoUrl = upload.secure_url || upload.url || finalPhotoUrl;
      finalPhotoPublicId = upload.public_id || finalPhotoPublicId;
      result.cloudinary = { ok: true, public_id: upload.public_id, asset_id: upload.asset_id || null, secure_url: upload.secure_url || upload.url || null };
    } catch (e) {
      const er = new Error("Cloudinary: " + e.message); er.cloudFail = true; throw er;
    }
  }

  // 2. Facebook (atomique : rollback de l'image fraîchement uploadée si échec).
  if (publishFacebook) {
    try {
      result.facebook = await publishActuToFacebook(cleanTitle, cleanDescription, imageBase64, eventDate, eventLocation, finalPhotoUrl);
    } catch (e) {
      if (imageBase64 && finalPhotoPublicId) { try { await deleteActuImageFromCloudinary(finalPhotoPublicId); } catch (_) {} }
      const er = new Error("Facebook: " + e.message); er.fbFail = true; throw er;
    }
  }

  // 3. Stockage Redis (affichage PWA).
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

  // 4. Push.
  if (sendPush) {
    try { result.push = await sendActuPush(cleanTitle, cleanDescription, finalPhotoUrl, actu.id); }
    catch (e) { result.warnings.push("Push: " + e.message); result.push = { ok: false, error: e.message }; }
  }

  // 5. Google Agenda.
  if (createCalendar && eventDate) {
    try { result.calendar = await upsertGoogleCalendarEvent(cleanTitle, cleanDescription, eventDate, eventLocation); }
    catch (e) { result.warnings.push("Calendar: " + e.message); result.calendar = { ok: false, error: e.message }; }
  }

  return result;
}

// ── Route : publier une actualité (multi-canal, immédiat) ───
router.post("/admin/actus/add", adminAuth, async (req, res) => {
  const {
    title, description, imageBase64, imageUrl,
    eventDate, eventLocation,
    publishFacebook = true, sendPush = true, createCalendar = true
  } = req.body || {};

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "title requis" });
  }
  if (publishFacebook && !imageBase64) {
    return res.status(400).json({ error: "imageBase64 requis pour publier sur Facebook avec image" });
  }

  try {
    const result = await publishActu({ title, description, imageBase64, imageUrl, eventDate, eventLocation, publishFacebook, sendPush, createCalendar });
    res.json(result);
  } catch (e) {
    if (e.cloudFail) return res.status(500).json({ ok: false, error: e.message });
    if (e.fbFail) return res.status(502).json({ ok: false, error: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
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
  const scheduled = await readScheduled(PUSH_SCHEDULED_KEY);
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
  await writeScheduled(PUSH_SCHEDULED_KEY, scheduled);
  res.json({ ok: true, notif });
});

router.delete("/admin/push/schedule/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const scheduled = await readScheduled(PUSH_SCHEDULED_KEY);
  await writeScheduled(PUSH_SCHEDULED_KEY, scheduled.filter(n => n.id !== id));
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
    const scheduled = await readScheduled(PUSH_SCHEDULED_KEY);
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
    await writeScheduled(PUSH_SCHEDULED_KEY, remaining);
  } catch (e) { console.warn('Cron push schedulé:', e.message); }
}, 60 * 1000);

// ── Publications programmées (différées) ────────────────────
const ACTUS_SCHEDULED_KEY = 'mat:actus:scheduled';
const ACTUS_SCHEDULED_MAX_RETRIES = 3;

// Programmer une publication : l'image est hébergée maintenant (Cloudinary), la
// diffusion (Facebook + push + agenda, selon les canaux) a lieu à la date choisie.
router.post("/admin/actus/schedule", adminAuth, async (req, res) => {
  const {
    title, description, imageBase64, imageUrl,
    eventDate, eventLocation,
    publishFacebook = true, sendPush = true, createCalendar = true,
    scheduledAt
  } = req.body || {};

  if (!title || !String(title).trim()) return res.status(400).json({ error: "title requis" });
  if (!scheduledAt) return res.status(400).json({ error: "scheduledAt requis" });
  const when = new Date(scheduledAt);
  if (isNaN(when.getTime())) return res.status(400).json({ error: "scheduledAt invalide" });
  if (when.getTime() <= Date.now()) return res.status(400).json({ error: "La date de programmation doit être dans le futur" });

  // Héberger l'image dès maintenant (évite de stocker du base64 lourd en Redis).
  let photoUrl = imageUrl || null;
  let photoPublicId = null;
  if (imageBase64) {
    try {
      const up = await uploadActuImageToCloudinary(imageBase64);
      photoUrl = up.secure_url || up.url || photoUrl;
      photoPublicId = up.public_id || null;
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Cloudinary: " + e.message });
    }
  }

  const scheduled = await readScheduled(ACTUS_SCHEDULED_KEY);
  const draft = {
    id: Date.now(),
    scheduledAt: when.toISOString(),
    title: String(title).trim().substring(0, 150),
    description: String(description || "").trim().substring(0, 3000),
    photoUrl, photoPublicId,
    eventDate: eventDate || null,
    eventLocation: eventLocation ? String(eventLocation).substring(0, 200) : null,
    publishFacebook: !!publishFacebook,
    sendPush: !!sendPush,
    createCalendar: !!createCalendar,
    status: 'pending',
    retries: 0,
    createdAt: new Date().toISOString()
  };
  scheduled.push(draft);
  if (scheduled.length > 50) scheduled.splice(0, scheduled.length - 50);
  await writeScheduled(ACTUS_SCHEDULED_KEY, scheduled);
  res.json({ ok: true, scheduled: draft });
});

// Lister les publications programmées (en attente + échecs).
router.get("/admin/actus/scheduled", adminAuth, async (req, res) => {
  const scheduled = await readScheduled(ACTUS_SCHEDULED_KEY);
  const list = scheduled
    .filter(s => s.status !== 'sent')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  res.json({ scheduled: list });
});

// Annuler une publication programmée (+ nettoyage de l'image hébergée).
router.delete("/admin/actus/scheduled/:id", adminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const scheduled = await readScheduled(ACTUS_SCHEDULED_KEY);
  const target = scheduled.find(s => s.id === id);
  if (target && target.photoPublicId) {
    try { await deleteActuImageFromCloudinary(target.photoPublicId); } catch (_) {}
  }
  await writeScheduled(ACTUS_SCHEDULED_KEY, scheduled.filter(s => s.id !== id));
  res.json({ ok: true, deleted: id });
});

// ── Cron : diffusion des publications programmées (toutes les minutes) ──
setInterval(async () => {
  try {
    const now = Date.now();
    const scheduled = await readScheduled(ACTUS_SCHEDULED_KEY);
    const due = scheduled.filter(s => s.status === 'pending' && new Date(s.scheduledAt).getTime() <= now);
    if (!due.length) return;
    for (const draft of due) {
      // Marquer "envoyé" AVANT la diffusion pour éviter une double publication.
      draft.status = 'sent';
      draft.sentAt = new Date().toISOString();
      try {
        await publishActu({
          title: draft.title, description: draft.description,
          imageUrl: draft.photoUrl, photoPublicId: draft.photoPublicId,
          eventDate: draft.eventDate, eventLocation: draft.eventLocation,
          publishFacebook: draft.publishFacebook, sendPush: draft.sendPush, createCalendar: draft.createCalendar
        });
        console.log(`📅 Publication programmée diffusée : "${draft.title}"`);
      } catch (e) {
        draft.status = 'pending';
        draft.sentAt = null;
        draft.retries = (draft.retries || 0) + 1;
        if (draft.retries >= ACTUS_SCHEDULED_MAX_RETRIES) {
          draft.status = 'failed';
          draft.failedAt = new Date().toISOString();
          draft.failedReason = String((e && e.message) || e).slice(0, 200);
          console.warn(`Publication programmée abandonnée: "${draft.title}" — ${draft.failedReason}`);
        } else {
          console.warn(`Publication programmée erreur (tentative ${draft.retries}/${ACTUS_SCHEDULED_MAX_RETRIES}):`, e.message);
        }
      }
    }
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const remaining = scheduled.filter(s => s.status !== 'sent' || new Date(s.scheduledAt).getTime() > cutoff);
    await writeScheduled(ACTUS_SCHEDULED_KEY, remaining);
  } catch (e) { console.warn('Cron publication programmée:', e.message); }
}, 60 * 1000);

module.exports = router;
