// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const axios = require("axios");
const { PAGE_ACCESS_TOKEN } = require("../config");
const { resolveFacebookPageId } = require("./facebook");
const { readSubs, writeSubs, purgeEndpointsEverywhere, recordPushHistory } = require("./store");
const { logServerError } = require("./logger");
const webpush = require("./webpush");

// Un échec du POST photo n'autorise un repli « texte seul » que si Facebook a
// explicitement REJETÉ la requête (réponse HTTP 4xx = aucun post créé). En cas
// de timeout / erreur réseau / 5xx, le post a PU être créé côté Facebook : un
// repli texte produirait alors un doublon (un post avec image + un sans). On
// relève donc l'erreur pour que l'admin vérifie la page avant de réessayer.
function _photoFailAllowsTextFallback(err) {
  const status = err && err.response && err.response.status;
  return typeof status === "number" && status >= 400 && status < 500;
}
function _ambiguousPhotoError(err) {
  const detail = err.response?.data?.error?.message || err.message;
  const e = new Error("Publication photo incertaine (délai ou réseau) — vérifiez la page Facebook avant de réessayer : " + detail);
  e.ambiguousPhoto = true;
  return e;
}

// Plafond d'images par actualité. Facebook accepte jusqu'à 10 attachements sur
// un post ; la limite est ici ergonomique (un habitant ne balaie pas 10 photos)
// et tient aussi le corps de la requête admin sous la limite de 6 Mo d'app.js.
const MAX_ACTU_PHOTOS = 6;

// Normalise une entrée « image » en tableau. L'admin envoie un tableau depuis la
// v4.109, mais l'ancienne forme (une chaîne) reste acceptée : `routes/eau.js`
// l'utilise toujours, et un client non mis à jour ne doit pas cesser de publier.
function normalizePhotoInputs(value) {
  const arr = Array.isArray(value) ? value : (value ? [value] : []);
  const out = [];
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s || out.includes(s)) continue;   // même photo choisie deux fois
    out.push(s);
    if (out.length >= MAX_ACTU_PHOTOS) break;
  }
  return out;
}

// Images d'une actu, quelle que soit sa forme de stockage.
// ⚠️ Les actus publiées AVANT la v4.109 n'ont que `photo` / `photoPublicId` :
// elles doivent continuer à s'afficher et, surtout, à libérer leur image sur
// Cloudinary à la suppression. Toute lecture des images d'une actu passe par
// cette fonction — sinon une moitié du parc est oubliée en silence.
function actuPhotoList(actu) {
  if (!actu) return [];
  if (Array.isArray(actu.photos) && actu.photos.length) {
    return actu.photos
      .filter(p => p && p.url)
      .map(p => ({ url: p.url, publicId: p.publicId || null }));
  }
  if (actu.photo) return [{ url: actu.photo, publicId: actu.photoPublicId || null }];
  return [];
}

function _b64ToBuffer(dataUri) {
  return Buffer.from(String(dataUri).replace(/^data:image\/\w+;base64,/, ""), "base64");
}

// Envoi d'une photo NON PUBLIÉE (`published=false`) : elle n'apparaît pas sur la
// page et sert uniquement d'attachement au post créé juste après.
// ⚠️ C'est ce qui rend l'échec d'un envoi ici SANS conséquence visible : un
// timeout peut laisser une photo orpheline invisible, jamais un post en double.
// L'ambiguïté (voir _ambiguousPhotoError) ne concerne donc que le POST /feed
// final, qui est la seule requête créant quelque chose de public.
async function _uploadUnpublishedPhoto(pageId, item) {
  if (item.base64) {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("source", _b64ToBuffer(item.base64), { filename: "photo.jpg", contentType: "image/jpeg" });
    form.append("published", "false");
    form.append("access_token", PAGE_ACCESS_TOKEN);
    const r = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/photos`,
      form,
      { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity }
    );
    return r.data.id;
  }
  const r = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
    url: item.url,
    published: false,
    access_token: PAGE_ACCESS_TOKEN
  });
  return r.data.id;
}

// ── Publier une actu sur Facebook (sans #MAT) ───────────────
// imageBase64 : photo(s) en data URL (upload multipart) — chaîne ou tableau.
// À défaut, imageUrl permet de publier par URL (utilisé par les publications
// programmées : les images sont hébergées sur Cloudinary à la programmation,
// postées par URL à l'heure dite).
// Une seule image → POST /photos avec le message (comportement historique,
// inchangé). Plusieurs → envois non publiés puis POST /feed avec attached_media,
// seule façon d'obtenir UN post portant toutes les photos (n posts séparés
// noieraient le mur de la page et casseraient le lien unique vers l'actu).
async function publishActuToFacebook(title, description, imageBase64, eventDate, eventLocation, imageUrl) {
  const pageId = await resolveFacebookPageId();
  if (!pageId || !PAGE_ACCESS_TOKEN) {
    throw new Error("Page Facebook ou token manquant");
  }

  const lines = [];
  lines.push(`📢 ${String(title || '').trim()}`);
  if (description) {
    const cleaned = String(description)
      .replace(/\r/g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .join('\n\n')
      .substring(0, 2200);
    if (cleaned) lines.push(cleaned);
  }
  if (eventDate) {
    const d = new Date(eventDate);
    const dateStr = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const hasTime = /T\d{2}:\d{2}/.test(eventDate);
    const timeStr = hasTime ? ` à ${d.getHours().toString().padStart(2,'0')}h${d.getMinutes().toString().padStart(2,'0')}` : "";
    lines.push(`📅 ${dateStr}${timeStr}`);
    if (eventLocation) lines.push(`📍 ${String(eventLocation).trim()}`);
  }
  const message = lines.join('\n\n').substring(0, 2800);

  const postTextOnly = async () => {
    const r = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
      message,
      access_token: PAGE_ACCESS_TOKEN
    });
    return { ok: true, mode: 'feed', post_id: r.data.id, fallbackUsed: false };
  };

  // Les base64 priment sur les URL (mêmes priorités qu'avant la v4.109).
  const b64List = normalizePhotoInputs(imageBase64);
  const urlList = normalizePhotoInputs(imageUrl);
  const items = b64List.length
    ? b64List.map(b => ({ base64: b }))
    : urlList.map(u => ({ url: u }));

  // ── Plusieurs photos : un seul post, toutes les images en attachement ──
  const postMultiPhoto = async () => {
    const fbids = [];
    const refus = [];
    for (const it of items) {
      try {
        const id = await _uploadUnpublishedPhoto(pageId, it);
        if (id) fbids.push(id);
      } catch (e) {
        // Sans conséquence publique (photo non publiée) : on note et on continue.
        refus.push(e.response?.data?.error?.message || e.message);
      }
    }
    if (!fbids.length) {
      const textOnly = await postTextOnly();
      return { ...textOnly, fallbackUsed: true, fallbackReason: "aucune photo acceptée par Facebook : " + refus.join(" / ") };
    }
    try {
      const body = { message, access_token: PAGE_ACCESS_TOKEN };
      fbids.forEach((id, i) => { body[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
      const r = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/feed`, body);
      return {
        ok: true,
        mode: 'photos',
        post_id: r.data.id,
        photo_ids: fbids,
        photo_count: fbids.length,
        // fallbackUsed reste FAUX ici : le post porte bien des photos. Une photo
        // refusée sur cinq se dit par skippedPhotos, pas par « repli texte » —
        // sinon le récapitulatif de l'admin annonce un post sans image alors
        // qu'il en a quatre.
        fallbackUsed: false,
        skippedPhotos: refus.length,
        skippedReason: refus.length ? refus.join(" / ") : undefined
      };
    } catch (feedErr) {
      if (!_photoFailAllowsTextFallback(feedErr)) throw _ambiguousPhotoError(feedErr);
      console.warn('⚠️ Post multi-photos Facebook rejeté (4xx), fallback texte:', feedErr.response?.data || feedErr.message);
      const textOnly = await postTextOnly();
      return { ...textOnly, fallbackUsed: true, fallbackReason: feedErr.response?.data?.error?.message || feedErr.message };
    }
  };

  try {
    if (items.length > 1) {
      return await postMultiPhoto();
    }
    if (b64List.length) {
      try {
        const imageBuffer = _b64ToBuffer(b64List[0]);
        const FormData = require("form-data");
        const form = new FormData();
        form.append("source", imageBuffer, { filename: "photo.jpg", contentType: "image/jpeg" });
        form.append("message", message);
        form.append("access_token", PAGE_ACCESS_TOKEN);
        const r = await axios.post(
          `https://graph.facebook.com/v19.0/${pageId}/photos`,
          form,
          { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity }
        );
        return {
          ok: true,
          mode: 'photo',
          post_id: r.data.post_id || r.data.id,
          photo_id: r.data.id,
          photo_url: `https://graph.facebook.com/${r.data.id}/picture`,
          fallbackUsed: false
        };
      } catch (photoErr) {
        if (!_photoFailAllowsTextFallback(photoErr)) throw _ambiguousPhotoError(photoErr);
        console.warn('⚠️ Photo Facebook rejetée (4xx), fallback texte:', photoErr.response?.data || photoErr.message);
        const textOnly = await postTextOnly();
        return { ...textOnly, fallbackUsed: true, fallbackReason: photoErr.response?.data?.error?.message || photoErr.message };
      }
    } else if (urlList.length) {
      try {
        const r = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
          url: urlList[0],
          message,
          access_token: PAGE_ACCESS_TOKEN
        });
        return {
          ok: true,
          mode: 'photo',
          post_id: r.data.post_id || r.data.id,
          photo_id: r.data.id,
          photo_url: `https://graph.facebook.com/${r.data.id}/picture`,
          fallbackUsed: false
        };
      } catch (photoErr) {
        if (!_photoFailAllowsTextFallback(photoErr)) throw _ambiguousPhotoError(photoErr);
        console.warn('⚠️ Photo (URL) Facebook rejetée (4xx), fallback texte:', photoErr.response?.data || photoErr.message);
        const textOnly = await postTextOnly();
        return { ...textOnly, fallbackUsed: true, fallbackReason: photoErr.response?.data?.error?.message || photoErr.message };
      }
    }
    return await postTextOnly();
  } catch (e) {
    console.error("❌ publishActuToFacebook:", e.response?.data || e.message);
    // Visible dans l'onglet 🪲 Logs de l'admin (module facebook) — sans lui,
    // un échec de publication sortante n'apparaissait que dans les logs Render.
    logServerError("facebook", "Publication actu échouée: " + (e.response?.data?.error?.message || e.message));
    throw new Error(e.response?.data?.error?.message || e.message);
  }
}

// ── Payload push pour une actu ────────────────────────────────
function buildActuPushPayload(title, description, photoUrl, actuId) {
  const safeId = actuId != null ? String(actuId) : "";
  const detailHash = safeId ? `./#actu=${encodeURIComponent(safeId)}` : "./#notifs";

  return JSON.stringify({
    title: `MAT — ${String(title || "").substring(0, 60)}`,
    body: String(description || title || "").substring(0, 150),
    icon: "./icon-192.png",
    badge: "./icon-badge.png",
    image: photoUrl || undefined,
    actions: [{ action: "detail", title: "Détail" }],
    data: {
      url: detailHash,
      listUrl: "./#notifs",
      actuId: safeId || null,
      open: safeId ? "actu" : "notifs"
    }
  });
}

// ── Envoyer notification push pour une actu ──────────────────
async function sendActuPush(title, description, photoUrl, actuId) {
  const subs = await readSubs();
  if (!subs.length) return { sent: 0, failed: 0, total: 0 };

  const payload = buildActuPushPayload(title, description, photoUrl, actuId);

  let sent = 0, failed = 0;
  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 86400 });
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }
  if (dead.length) {
    const alive = subs.filter(s => !dead.includes(s.endpoint));
    await writeSubs(alive);
    purgeEndpointsEverywhere(dead).catch(() => {});
  }
  await recordPushHistory({ type: 'actu', title: (title || '').substring(0, 80), sent, total: subs.length, dead: dead.length });
  return { sent, failed, total: subs.length };
}

module.exports = {
  publishActuToFacebook,
  buildActuPushPayload,
  sendActuPush,
  normalizePhotoInputs,
  actuPhotoList,
  MAX_ACTU_PHOTOS
};
