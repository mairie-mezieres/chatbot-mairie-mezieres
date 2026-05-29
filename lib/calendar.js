// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

// ── Google Calendar : créer/remplacer événement ──────────────
let _googleCalendarClient = null;
function getGoogleCalendarClient() {
  if (_googleCalendarClient) return _googleCalendarClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
    : process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const { google } = require("googleapis");
    const credentials = JSON.parse(raw);
    const auth = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ["https://www.googleapis.com/auth/calendar"]
    );
    _googleCalendarClient = google.calendar({ version: "v3", auth });
    return _googleCalendarClient;
  } catch (e) {
    console.warn("Google Calendar init fail:", e.message);
    return null;
  }
}

async function upsertGoogleCalendarEvent(title, description, eventDate, eventLocation) {
  const calendar = getGoogleCalendarClient();
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendar || !calendarId) {
    throw new Error("Google Calendar non configuré");
  }

  // Chercher les événements du jour pour détecter un doublon
  const eventDt = new Date(eventDate);
  const dayStart = new Date(eventDt); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(eventDt); dayEnd.setHours(23, 59, 59, 999);

  const existing = await calendar.events.list({
    calendarId,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime"
  });

  // Détection doublon : similarité > 0.6 sur le titre normalisé
  const stringSimilarity = require("string-similarity");
  const normalize = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").trim();
  const target = normalize(title);
  let deletedCount = 0;

  for (const ev of existing.data.items || []) {
    const evTitle = normalize(ev.summary);
    const similarity = stringSimilarity.compareTwoStrings(target, evTitle);
    if (similarity > 0.6) {
      try {
        await calendar.events.delete({ calendarId, eventId: ev.id });
        deletedCount++;
        console.log(`🗑️ Doublon supprimé: "${ev.summary}" (sim=${similarity.toFixed(2)})`);
      } catch (e) {
        console.warn(`Échec suppression doublon ${ev.id}:`, e.message);
      }
    }
  }

  // Créer le nouvel événement
  const hasTime = /T\d{2}:\d{2}/.test(eventDate);
  // Pass Paris-local datetime strings without UTC conversion.
  // When dateTime has no offset (no Z), Google Calendar uses the timeZone field
  // to interpret it as local Paris time — avoids the +2h UTC shift on UTC servers.
  const startStr = hasTime
    ? eventDate.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/, '$1:00')
    : eventDate.slice(0, 10);
  // +Z treats startStr as UTC for arithmetic only; toISOString gives correct day rollover
  const endStr = hasTime
    ? (() => { const d = new Date(startStr + 'Z'); d.setTime(d.getTime() + 3600000); return d.toISOString().slice(0, 19); })()
    : startStr;

  const eventBody = {
    summary: title,
    description: description || "",
    location: eventLocation || undefined,
    start: hasTime ? { dateTime: startStr, timeZone: "Europe/Paris" } : { date: startStr },
    end:   hasTime ? { dateTime: endStr,   timeZone: "Europe/Paris" } : { date: endStr }
  };

  const created = await calendar.events.insert({ calendarId, requestBody: eventBody });
  return { ok: true, event_id: created.data.id, html_link: created.data.htmlLink, deleted_duplicates: deletedCount };
}

module.exports = { getGoogleCalendarClient, upsertGoogleCalendarEvent };
