// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const axios = require("axios");
const { FACEBOOK_PAGE_ID, PAGE_ACCESS_TOKEN } = require("../config");

async function resolveFacebookPageId() {
  if (FACEBOOK_PAGE_ID) return FACEBOOK_PAGE_ID;
  if (!PAGE_ACCESS_TOKEN) return null;

  try {
    const pageInfo = await axios.get(
      `https://graph.facebook.com/v19.0/me?access_token=${PAGE_ACCESS_TOKEN}`
    );
    return pageInfo.data.id || null;
  } catch (e) {
    console.warn("Résolution page Facebook impossible:", e.message);
    return null;
  }
}

async function fetchFacebookFullPicture(postId) {
  if (!postId || !PAGE_ACCESS_TOKEN) return null;
  try {
    const r = await axios.get(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(postId)}?fields=full_picture&access_token=${PAGE_ACCESS_TOKEN}`
    );
    return r.data.full_picture || null;
  } catch (e) {
    console.warn("Récupération image Facebook impossible:", e.message);
    return null;
  }
}

// Toutes les images d'un post, dans l'ordre d'affichage (couverture en tête).
//
// ⚠️ `full_picture` ne rend QUE la couverture : sur un post à six photos, cinq
// disparaissaient sans le moindre signe — l'actu s'affichait normalement, avec
// une image. Les images d'un post multi-photos vivent dans
// `attachments.data[].subattachments.data[].media.image.src` ; un post à une
// seule image n'a pas de `subattachments`, son image est sur l'attachement
// lui-même. On garde `full_picture` en tout dernier recours (post partagé,
// aperçu de lien… : des formes où les attachements peuvent manquer).
async function fetchFacebookPostImages(postId) {
  if (!postId || !PAGE_ACCESS_TOKEN) return [];
  try {
    const r = await axios.get(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(postId)}` +
      `?fields=full_picture,attachments{media,subattachments{media}}` +
      `&access_token=${PAGE_ACCESS_TOKEN}`
    );
    const out = [];
    const add = (u) => {
      if (typeof u === "string" && u.trim() && !out.includes(u)) out.push(u);
    };
    for (const att of r.data?.attachments?.data || []) {
      const subs = att?.subattachments?.data || [];
      if (subs.length) {
        for (const sub of subs) add(sub?.media?.image?.src);
      } else {
        add(att?.media?.image?.src);
      }
    }
    if (!out.length) add(r.data?.full_picture);
    return out;
  } catch (e) {
    console.warn("Récupération des images Facebook impossible:", e.message);
    return [];
  }
}

module.exports = { resolveFacebookPageId, fetchFacebookFullPicture, fetchFacebookPostImages };
