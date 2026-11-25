// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
//
// Vidéo ou son d'une actualité (v4.130) — ce qui doit rester vrai
// ────────────────────────────────────────────────────────────────
// ⛔ Un média temporel rend applicables les critères RGAA 4.1 à 4.13, classés
//    jusqu'ici « non applicables » (app-mezieres, ADR-0057). L'application reste
//    totalement conforme parce que la publication est REFUSÉE ici, côté serveur,
//    sans l'engagement d'accessibilité de la mairie :
//      - vidéo → sous-titres incrustés dans l'image (critère 4.3), et rien
//                d'important seulement montré à l'écran (4.1 / 4.5 « si
//                nécessaire » : l'audio porte alors toute l'information) ;
//      - son   → le texte de l'actu reprend ce qui est dit (critère 4.1), donc
//                une description non vide.
//    Une case à cocher dans l'admin ne suffirait pas : un client non à jour, ou
//    un appel direct à l'API, publierait sans elle.
// ⛔ Le genre (vidéo / son) se déduit du FORMAT relu chez Cloudinary, jamais
//    de ce qu'annonce le navigateur : un MP3 déclaré « vidéo » s'afficherait
//    dans un lecteur vidéo vide, avec une promesse de sous-titres sans objet.
// ⚠️ Toute suppression d'actu passe par `actuMediaPublicIds` — même piège que
//    les photos (ADR-0039) : un fichier de 100 Mo oublié coûte cher au quota.
"use strict";

const ACTU_MEDIA_FOLDER = "mat/actus-media";
// Plafond d'un fichier vidéo sur l'offre gratuite de Cloudinary.
const MAX_ACTU_MEDIA_BYTES = 100 * 1024 * 1024;

const AUDIO_FORMATS = ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"];
const VIDEO_FORMATS = ["mp4", "m4v", "mov", "webm"];

const ENGAGEMENTS = {
  video: "sous-titres-incrustes",
  audio: "transcription-dans-le-texte"
};

const PUBLIC_ID_RE = /^mat\/actus-media\/[A-Za-z0-9_-]{1,120}$/;

function mediaKindFromFormat(format) {
  const f = String(format || "").toLowerCase();
  if (AUDIO_FORMATS.includes(f)) return "audio";
  if (VIDEO_FORMATS.includes(f)) return "video";
  return null;
}

function mediaError(message, { status = 400, discard = false } = {}) {
  const e = new Error(message);
  e.status = status;
  e.discard = discard;   // vrai = le fichier envoyé est inutilisable, à supprimer
  return e;
}

// `input` = ce qu'envoie l'admin : { publicId, accessibilite: true }.
// `deps.fetchResource(publicId)` relit la ressource chez Cloudinary ;
// `deps.posterUrl(publicId)` fabrique l'image d'attente d'une vidéo.
// Rend null s'il n'y a pas de média, l'objet à stocker sinon ; lève une
// erreur `{status, discard}` si le média est refusé.
async function resolveActuMedia(input, description, deps) {
  if (input == null || input === "") return null;
  if (typeof input !== "object") throw mediaError("Média invalide");
  const publicId = typeof input.publicId === "string" ? input.publicId.trim() : "";
  // Un identifiant hors de notre dossier n'est pas « à nous » : on refuse sans
  // rien supprimer (ce pourrait être un fichier légitime d'une autre rubrique).
  if (!PUBLIC_ID_RE.test(publicId)) throw mediaError("Identifiant de média invalide");

  if (input.accessibilite !== true) {
    throw mediaError("Accessibilité non confirmée : cochez la case correspondant au média (vidéo : sous-titres incrustés et tout l'essentiel dit à l'oral ; son : transcription dans le texte).", { discard: true });
  }

  let res;
  try { res = await deps.fetchResource(publicId); }
  catch (e) {
    const http = e && (e.http_code || (e.error && e.error.http_code));
    if (http === 404) throw mediaError("Média introuvable chez Cloudinary — l'envoi a-t-il abouti ?");
    throw mediaError("Cloudinary injoignable : " + ((e && (e.message || (e.error && e.error.message))) || e), { status: 502 });
  }
  const kind = mediaKindFromFormat(res && res.format);
  if (!kind) throw mediaError(`Format « ${(res && res.format) || "?"} » non accepté — MP4 ou WEBM pour une vidéo, MP3 ou M4A pour un son.`, { discard: true });
  const bytes = Number(res.bytes) || 0;
  if (bytes > MAX_ACTU_MEDIA_BYTES) throw mediaError("Fichier trop lourd (100 Mo maximum).", { discard: true });
  if (kind === "audio" && !String(description || "").trim()) {
    throw mediaError("Un son exige un texte d'actualité qui en reprend le contenu (transcription).", { discard: true });
  }
  const url = res.secure_url || null;
  if (!url) throw mediaError("Cloudinary n'a pas rendu d'adresse pour ce média", { status: 502 });

  const duration = Number(res.duration);
  return {
    kind,
    url,
    publicId,
    format: String(res.format).toLowerCase(),
    bytes,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    poster: kind === "video" && deps.posterUrl ? (deps.posterUrl(publicId) || null) : null,
    accessibilite: ENGAGEMENTS[kind]
  };
}

// Identifiants Cloudinary des médias d'une actu (ou d'un brouillon programmé).
function actuMediaPublicIds(actu) {
  const m = actu && actu.media;
  if (m && typeof m.publicId === "string" && PUBLIC_ID_RE.test(m.publicId)) return [m.publicId];
  return [];
}

module.exports = {
  ACTU_MEDIA_FOLDER,
  MAX_ACTU_MEDIA_BYTES,
  AUDIO_FORMATS,
  VIDEO_FORMATS,
  mediaKindFromFormat,
  resolveActuMedia,
  actuMediaPublicIds
};
