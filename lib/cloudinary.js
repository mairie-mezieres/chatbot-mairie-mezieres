// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const cloudinary = require("cloudinary").v2;
const { CLOUDINARY_NAME, CLOUDINARY_KEY, CLOUDINARY_SECRET, CLOUDINARY_ENABLED } = require("../config");

if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: CLOUDINARY_NAME,
    api_key: CLOUDINARY_KEY,
    api_secret: CLOUDINARY_SECRET,
    secure: true
  });
  console.log("✅ Cloudinary configuré");
}

function getDataUriMimeType(dataUri = "") {
  const m = String(dataUri).match(/^data:([^;]+);base64,/i);
  return (m?.[1] || "image/jpeg").toLowerCase();
}

async function uploadEntrepriseLogoToCloudinary(imageBase64) {
  if (!imageBase64) return null;
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");
  const mimeType = getDataUriMimeType(imageBase64);
  return await cloudinary.uploader.upload(imageBase64, {
    folder: "mat/entreprises",
    resource_type: "image",
    overwrite: false,
    unique_filename: true,
    format: mimeType.includes("png") ? "png" : "jpg"
  });
}

async function uploadActuImageToCloudinary(imageBase64) {
  if (!imageBase64) return null;
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");

  const mimeType = getDataUriMimeType(imageBase64);
  return await cloudinary.uploader.upload(imageBase64, {
    folder: "mat/actus",
    resource_type: "image",
    overwrite: false,
    invalidate: false,
    use_filename: false,
    unique_filename: true,
    format: mimeType.includes("png") ? "png" : undefined
  });
}

async function uploadMascotToCloudinary(imageBase64) {
  if (!imageBase64) return null;
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");

  const mimeType = getDataUriMimeType(imageBase64);
  return await cloudinary.uploader.upload(imageBase64, {
    folder: "mat/mascotte",
    resource_type: "image",
    overwrite: false,
    invalidate: false,
    use_filename: false,
    unique_filename: true,
    format: mimeType.includes("png") ? "png" : undefined
  });
}

async function uploadGaleriePhotoToCloudinary(imageBase64) {
  if (!imageBase64) return null;
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");

  const mimeType = getDataUriMimeType(imageBase64);
  return await cloudinary.uploader.upload(imageBase64, {
    folder: "mat/galerie",
    resource_type: "image",
    overwrite: false,
    invalidate: false,
    use_filename: false,
    unique_filename: true,
    format: mimeType.includes("png") ? "png" : undefined
  });
}

async function deleteGaleriePhotoFromCloudinary(publicId) {
  if (!publicId) return { result: "skipped" };
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");

  return await cloudinary.uploader.destroy(publicId, {
    resource_type: "image",
    type: "upload",
    invalidate: true
  });
}

// Documents du PLUi-H-D : des PDF, pas des images.
// ⚠️ resource_type "raw" est obligatoire — en "image", Cloudinary applique aux PDF
// ses restrictions de transformation et la livraison est bloquée sur le plan gratuit.
// L'extension .pdf doit figurer dans le public_id : c'est elle qui détermine le
// Content-Type servi, donc l'ouverture dans le navigateur plutôt qu'un téléchargement
// de fichier binaire anonyme.
async function uploadPluiDocToCloudinary(fileB64) {
  if (!fileB64) return null;
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");

  return await cloudinary.uploader.upload(fileB64, {
    folder: "mat/plui",
    resource_type: "raw",
    public_id: "plui-" + Date.now() + ".pdf",
    overwrite: false,
    invalidate: false,
    use_filename: false
  });
}

// ⚠️ L'`secure_url` renvoyé par l'upload NE SUFFIT PAS : Cloudinary bloque par
// défaut la livraison des « types de médias restreints » (PDF et ZIP en tête) et
// répond **401** sur l'URL nue — le document s'envoie bien, mais personne ne peut
// l'ouvrir. Le contournement documenté est la **signature de l'URL** : une URL
// signée est délivrée même quand le type est restreint, sans rien changer dans la
// console Cloudinary.
//
// L'URL est donc construite à la lecture (`GET /docs/plui`) à partir du seul
// `publicId`, et jamais stockée : les documents déjà envoyés avant ce correctif
// sont réparés sans migration, et une rotation de la clé Cloudinary ne laisse pas
// derrière elle des liens morts en base.
function pluiDocUrl(publicId) {
  if (!publicId || !CLOUDINARY_ENABLED) return null;
  return cloudinary.url(publicId, {
    resource_type: "raw",
    type: "upload",
    secure: true,
    sign_url: true
  });
}

async function deletePluiDocFromCloudinary(publicId) {
  if (!publicId) return { result: "skipped" };
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");

  return await cloudinary.uploader.destroy(publicId, {
    resource_type: "raw",
    type: "upload",
    invalidate: true
  });
}

async function deleteActuImageFromCloudinary(publicId) {
  if (!publicId) return { result: "skipped" };
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");

  return await cloudinary.uploader.destroy(publicId, {
    resource_type: "image",
    type: "upload",
    invalidate: true
  });
}

// ── Vidéo / son d'une actualité (v4.130) ─────────────────────
// ⛔ Le fichier ne transite PAS par ce serveur : 100 Mo en base64 dans un JSON
// dépasseraient de loin la limite de 6 Mo d'app.js (et la mémoire de Render).
// L'admin envoie directement à Cloudinary avec une signature fabriquée ici ;
// le backend ne reçoit ensuite que le `public_id` et relit la ressource chez
// Cloudinary (taille, format) au lieu de croire ce que dit le navigateur.
// ⚠️ Cloudinary range l'AUDIO sous `resource_type: "video"` : c'est ce type,
// et lui seul, qui sert à l'envoi, à la relecture et à la suppression.
const { ACTU_MEDIA_FOLDER } = require("./actu-media");

function signActuMediaUpload(nowMs = Date.now()) {
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");
  const timestamp = Math.floor(nowMs / 1000);
  const params = { folder: ACTU_MEDIA_FOLDER, timestamp };
  return {
    cloudName: CLOUDINARY_NAME,
    apiKey: CLOUDINARY_KEY,
    timestamp,
    folder: ACTU_MEDIA_FOLDER,
    signature: cloudinary.utils.api_sign_request(params, CLOUDINARY_SECRET),
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUDINARY_NAME)}/video/upload`
  };
}

async function getActuMediaResource(publicId) {
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");
  return await cloudinary.api.resource(publicId, { resource_type: "video", type: "upload" });
}

// Image d'attente d'une vidéo : la première image, fabriquée par Cloudinary.
// Sans elle, `preload="none"` laisse un rectangle noir muet dans la carte.
function actuMediaPosterUrl(publicId) {
  if (!publicId || !CLOUDINARY_ENABLED) return null;
  return cloudinary.url(publicId, {
    resource_type: "video", type: "upload", format: "jpg", secure: true,
    transformation: [{ start_offset: "0", width: 1000, crop: "limit" }]
  });
}

async function deleteActuMediaFromCloudinary(publicId) {
  if (!publicId) return { result: "skipped" };
  if (!CLOUDINARY_ENABLED) throw new Error("Cloudinary non configuré");
  return await cloudinary.uploader.destroy(publicId, {
    resource_type: "video",
    type: "upload",
    invalidate: true
  });
}

module.exports = {
  CLOUDINARY_ENABLED,
  ACTU_MEDIA_FOLDER,
  signActuMediaUpload,
  getActuMediaResource,
  actuMediaPosterUrl,
  deleteActuMediaFromCloudinary,
  getDataUriMimeType,
  uploadEntrepriseLogoToCloudinary,
  uploadActuImageToCloudinary,
  deleteActuImageFromCloudinary,
  uploadMascotToCloudinary,
  uploadGaleriePhotoToCloudinary,
  deleteGaleriePhotoFromCloudinary,
  uploadPluiDocToCloudinary,
  deletePluiDocFromCloudinary,
  pluiDocUrl,
};
