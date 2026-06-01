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

module.exports = { resolveFacebookPageId, fetchFacebookFullPicture };
