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

module.exports = {
  CLOUDINARY_ENABLED,
  getDataUriMimeType,
  uploadEntrepriseLogoToCloudinary,
  uploadActuImageToCloudinary,
  deleteActuImageFromCloudinary,
  uploadMascotToCloudinary,
  uploadGaleriePhotoToCloudinary,
  deleteGaleriePhotoFromCloudinary,
  uploadPluiDocToCloudinary,
  deletePluiDocFromCloudinary,
};
