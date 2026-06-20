// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const axios = require("axios");
const {
  OPEN_METEO_LAT, OPEN_METEO_LON, OPEN_METEO_TZ,
  METEOFRANCE_VIGILANCE_URL, METEOFRANCE_API_TOKEN,
  PAGE_ACCESS_TOKEN,
} = require("../config");
const { readMeteoCache, writeMeteoCache, readMeteoSubs, writeMeteoSubs, purgeEndpointsEverywhere, recordPushHistory } = require("./store");
const { redisSetex, redisSetNxEx, redisDel } = require("./redis");
const webpush = require("./webpush");
const { formatAlertDateFr } = require("./dates");
const { resolveFacebookPageId } = require("./facebook");

// ── Météo / Vigilance ─────────────────────────────────────────
const VIGILANCE_COLORS = {
  1: "vert",
  2: "jaune",
  3: "orange",
  4: "rouge",
};

const VIGILANCE_PHENOMENA = {
  1: "vent violent",
  2: "pluie-inondation",
  3: "orages",
  4: "crues",
  5: "neige-verglas",
  6: "canicule",
  7: "grand froid",
  8: "avalanches",
  9: "vagues-submersion",
};

// Slugs des visuels d'alerte (img/vigilance côté PWA) par phénomène.
const VIGILANCE_SLUGS = {
  1: "vent-violent", 2: "pluie-inondation", 3: "orages", 4: "crues",
  5: "neige-verglas", 6: "canicule", 7: "grand-froid", 8: "avalanches",
  9: "vagues-submersion",
};
const VIGILANCE_IMG_BASE = (process.env.VIGILANCE_IMG_BASE || "https://mezieres-lez-clery.fr/img/vigilance").replace(/\/+$/, "");

// URL de l'image illustrant une vigilance (phénomène × niveau), ou null (niveau ≤ 1).
// Repli sur l'image générique du niveau si le phénomène est inconnu.
function vigilanceImageUrl(vigilance) {
  const lvl = Number((vigilance && vigilance.level) || 0);
  const color = lvl >= 4 ? "rouge" : lvl === 3 ? "orange" : lvl === 2 ? "jaune" : null;
  if (!color) return null;
  const slug = VIGILANCE_SLUGS[Number(vigilance.phenomenon_id)] || null;
  return slug
    ? `${VIGILANCE_IMG_BASE}/vigilance-${slug}-${color}.png`
    : `${VIGILANCE_IMG_BASE}/vigilance-${color}.png`;
}

async function fetchOpenMeteoForecast() {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(OPEN_METEO_LAT)}` +
    `&longitude=${encodeURIComponent(OPEN_METEO_LON)}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,pressure_msl,precipitation,wind_gusts_10m` +
    `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,wind_gusts_10m,surface_pressure` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,uv_index_max,sunrise,sunset,wind_direction_10m_dominant,wind_gusts_10m_max` +
    `&past_days=1` +
    `&forecast_days=10` +
    `&timezone=${encodeURIComponent(OPEN_METEO_TZ)}`;

  const r = await axios.get(url, { timeout: 15000 });
  return r.data;
}

let _meteoCache = null;
let _meteoCacheTime = 0;
const METEO_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function getCachedMeteoForecast(options = {}) {
  const allowStale = options.allowStale !== false;
  const now = Date.now();

  // 1) Cache mémoire prioritaire
  if (_meteoCache && (now - _meteoCacheTime) < METEO_CACHE_TTL) {
    return {
      data: _meteoCache,
      stale: false,
      cacheTime: _meteoCacheTime,
      source: "memory"
    };
  }

  // 2) Cache Redis en secours
  const redisCached = await readMeteoCache();
  if (
    redisCached &&
    redisCached.data &&
    redisCached.cacheTime &&
    (now - redisCached.cacheTime) < METEO_CACHE_TTL
  ) {
    _meteoCache = redisCached.data;
    _meteoCacheTime = redisCached.cacheTime;
    return {
      data: _meteoCache,
      stale: false,
      cacheTime: _meteoCacheTime,
      source: "redis"
    };
  }

  // 3) Appel Open-Meteo seulement si nécessaire
  try {
    const data = await fetchOpenMeteoForecast();
    _meteoCache = data;
    _meteoCacheTime = now;
    await writeMeteoCache({
      data,
      cacheTime: now
    });
    return {
      data,
      stale: false,
      cacheTime: _meteoCacheTime,
      source: "open-meteo"
    };
  } catch (e) {
    // 4) Secours sur cache mémoire expiré
    if (allowStale && _meteoCache) {
      console.warn("⚠️ Open-Meteo indisponible, retour du cache mémoire périmé");
      return {
        data: _meteoCache,
        stale: true,
        cacheTime: _meteoCacheTime,
        source: "memory-stale"
      };
    }

    // 5) Secours sur cache Redis expiré
    if (allowStale && redisCached && redisCached.data) {
      console.warn("⚠️ Open-Meteo indisponible, retour du cache Redis périmé");
      _meteoCache = redisCached.data;
      _meteoCacheTime = redisCached.cacheTime || 0;
      return {
        data: redisCached.data,
        stale: true,
        cacheTime: redisCached.cacheTime || null,
        source: "redis-stale"
      };
    }

    throw e;
  }
}

async function fetchMeteoFranceVigilanceRaw() {
  if (!METEOFRANCE_VIGILANCE_URL) {
    throw new Error("METEOFRANCE_VIGILANCE_URL non configurée");
  }

  const headers = {};
  if (METEOFRANCE_API_TOKEN) {
    headers.apikey = METEOFRANCE_API_TOKEN;
  }

  const r = await axios.get(METEOFRANCE_VIGILANCE_URL, {
    headers,
    timeout: 15000,
  });

  return r.data;
}

function extractDepartmentVigilance(raw, deptCode = "45") {
  if (!raw || !raw.product || !Array.isArray(raw.product.periods)) return null;

  const periods = raw.product.periods;
  const now = Date.now();
  const UPCOMING_WINDOW_MS = 36 * 3600 * 1000; // inclure les alertes futures ≤ 36h

  // Collecter toutes les périodes actives OU à venir dans les 36h
  const candidates = periods.filter(p => {
    const begin = new Date(p.begin_validity_time).getTime();
    const end   = new Date(p.end_validity_time).getTime();
    if (Number.isNaN(begin) || Number.isNaN(end)) return false;
    return (now >= begin && now <= end) || (begin > now && begin <= now + UPCOMING_WINDOW_MS);
  });
  if (!candidates.length) candidates.push(periods[0]); // repli : première période disponible
  if (!candidates[0]) return null;

  // Extraire le résultat de chaque période candidate pour le département cible
  const textBlocks = Array.isArray(raw.product.text_bloc_items) ? raw.product.text_bloc_items : [];
  const matchingTexts = textBlocks
    .filter(t => String(t.domain_id) === String(deptCode))
    .map(t => t.text)
    .filter(Boolean);

  let best = null;

  for (const period of candidates) {
    const isUpcoming = new Date(period.begin_validity_time).getTime() > now;
    const deptDomain = (period.timelaps?.domain_ids || []).find(d => String(d.domain_id) === String(deptCode));
    if (!deptDomain) continue;
    const items = Array.isArray(deptDomain.phenomenon_items) ? deptDomain.phenomenon_items : [];
    if (!items.length) continue;

    const sorted = [...items].sort((a, b) => (Number(b.color_id || b.phenomenon_max_color_id || 0)) - (Number(a.color_id || a.phenomenon_max_color_id || 0)));
    const main = sorted[0];
    if (!main) continue;

    const color = Number(main.phenomenon_max_color_id || main.color_id || 1);
    if (best && color <= best.level) continue; // on garde le niveau le plus élevé

    const phenomenonId = Number(main.phenomenon_id || 0);
    let start = null;
    let end = null;

    if (Array.isArray(main.timelaps_items) && main.timelaps_items.length) {
      // On filtre les timelaps : bonne couleur ET dont l'end_time n'est pas
      // encore passé. Sans cette deuxième condition, une alerte qui finissait
      // à 19h restait retournée jusqu'à minuit (fin de la période MF), parce
      // que le filtre extérieur (begin/end_validity_time) se base sur la
      // période, pas sur le phénomène.
      const active = main.timelaps_items
        .filter(t => Number(t.color_id || 1) >= color && new Date(t.end_time || 0).getTime() > now)
        .sort((a, b) => new Date(a.begin_time) - new Date(b.begin_time));
      if (!active.length) continue; // tous les timelaps du phénomène sont terminés
      start = active[0].begin_time || null;
      end   = active[active.length - 1].end_time || null;
    }

    best = {
      department_code: String(deptCode),
      level: color,
      color_label: VIGILANCE_COLORS[color] || "vert",
      phenomenon_id: phenomenonId,
      phenomenon_label: VIGILANCE_PHENOMENA[phenomenonId] || "phénomène météo",
      start,
      end,
      upcoming: isUpcoming,
      title: `${VIGILANCE_COLORS[color] || "vert"} — ${VIGILANCE_PHENOMENA[phenomenonId] || "phénomène météo"}`,
      main_text: matchingTexts[0] || "",
      raw_period_name: period.echeance || null,
    };
  }

  return best;
}

async function sendWeatherPush(vigilance) {
  const allSubs = await readMeteoSubs();
  const level  = Number(vigilance.level || 2);
  const subs   = allSubs.filter(s => (Number(s.minLevel) || 2) <= level);
  if (!subs.length) return { sent: 0, total: allSubs.length };
  const LEVEL_ICONS  = { 2: '🟡', 3: '🟠', 4: '🔴' };
  const color  = vigilance.color_label || 'météo';
  const icon   = LEVEL_ICONS[level] || '⚠️';
  const phenom = vigilance.phenomenon_label || 'Alerte météo';
  const endTxt = vigilance.end ? formatAlertDateFr(vigilance.end) : '';
  const payload = JSON.stringify({
    title: `${icon} Vigilance ${color} — Loiret`,
    body:  endTxt ? `${phenom} · Fin ${endTxt}` : phenom,
    icon:  './icon-192.png',
    badge: './icon-badge.png',
    image: vigilanceImageUrl(vigilance) || undefined,
    data:  { url: './#meteo', open: 'meteo' }
  });
  const dead = [];
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 86400 });
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }
  if (dead.length) {
    await writeMeteoSubs(allSubs.filter(s => !dead.includes(s.endpoint)));
    purgeEndpointsEverywhere(dead).catch(() => {});
  }
  console.log(`🌩️ Météo push (vigilance ${color}, level≥${level}) → ${sent}/${subs.length} filtrés / ${allSubs.length} total (${dead.length} expirés purgés)`);
  await recordPushHistory({ type: 'meteo', title: `Vigilance ${color} — ${phenom}`, sent, total: subs.length, dead: dead.length });
  return { sent, total: subs.length };
}

async function publishWeatherAlertToFacebook(vigilance) {
  const pageId = await resolveFacebookPageId();
  if (!pageId || !PAGE_ACCESS_TOKEN) {
    throw new Error("Page Facebook ou token manquant");
  }

  const message =
`⚠️ Alerte météo – ${vigilance.phenomenon_label} ⚠️

Météo-France signale une vigilance ${vigilance.color_label} pour le Loiret.

Début : ${formatAlertDateFr(vigilance.start)}
Fin : ${formatAlertDateFr(vigilance.end)}

Soyez prudents et suivez les consignes de sécurité.

#MAT`;

  // Publier avec l'image d'alerte (phénomène × niveau) si disponible ;
  // repli automatique sur un post texte si la photo échoue (jamais bloquant).
  const imageUrl = vigilanceImageUrl(vigilance);
  if (imageUrl) {
    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${pageId}/photos`,
        { url: imageUrl, message, access_token: PAGE_ACCESS_TOKEN }
      );
      return message;
    } catch (e) {
      // Repli texte seulement si Facebook a explicitement rejeté la requête (4xx
      // = aucun post créé). Sur timeout / réseau / 5xx, le post a pu être créé →
      // pas de repli (sinon doublon : un post avec image + un sans).
      const status = e.response?.status;
      if (!(typeof status === "number" && status >= 400 && status < 500)) {
        console.error("❌ Photo vigilance Facebook — échec ambigu, pas de repli texte:", e.response?.data || e.message);
        throw new Error("Publication vigilance incertaine (délai ou réseau) — vérifiez la page Facebook : " + (e.response?.data?.error?.message || e.message));
      }
      console.warn("⚠️ Photo vigilance Facebook rejetée (4xx), fallback texte:", e.response?.data || e.message);
    }
  }

  await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/feed`,
    { message },
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );

  return message;
}

function isSameWeatherAlert(a, b) {
  if (!a || !b) return false;
  const sameType = (
    Number(a.level) === Number(b.level) &&
    String(a.phenomenon_id) === String(b.phenomenon_id)
  );
  if (!sameType) return false;
  // Bloquer la re-notification pendant 12h pour la même alerte
  const pushedAt = a.pushedAt ? new Date(a.pushedAt).getTime() : 0;
  return (Date.now() - pushedAt) < 12 * 3600 * 1000;
}

// ── Verrou anti-doublon de push (atomique) ───────────────────
// Empêche deux crons concurrents (cron interne /15 min + cron-job.org /30 min)
// de notifier deux fois la même alerte (niveau + phénomène). La réservation NX
// est atomique côté Redis : un seul process gagne, les autres voient « déjà
// réservé » et s'abstiennent. Remplace l'ancien « lire-puis-écrire » qui laissait
// une fenêtre de course pendant la durée de sendWeatherPush.
// Repli « fail-open » si Redis est indisponible : mieux vaut un doublon rare
// qu'une alerte de sécurité non envoyée.
const WEATHER_PUSH_CLAIM_TTL_S = 12 * 3600;
function _weatherPushClaimKey(v) {
  return `mat:weather:pushclaim:${Number(v.level)}:${Number(v.phenomenon_id)}`;
}
async function claimWeatherPush(vigilance, force) {
  const key = _weatherPushClaimKey(vigilance);
  if (force) {
    // Forçage admin : (re)pose la réservation et pousse.
    await redisSetex(key, WEATHER_PUSH_CLAIM_TTL_S, { pushedAt: new Date().toISOString() });
    return true;
  }
  const claim = await redisSetNxEx(key, { pushedAt: new Date().toISOString() }, WEATHER_PUSH_CLAIM_TTL_S);
  // true = réservation acquise → pousser ; false = déjà réservée → ignorer ;
  // null = Redis indéterminé → pousser (fail-open).
  return claim !== false;
}
async function releaseWeatherPushClaim(vigilance) {
  try { await redisDel(_weatherPushClaimKey(vigilance)); } catch (_) {}
}

module.exports = {
  VIGILANCE_COLORS,
  VIGILANCE_PHENOMENA,
  fetchOpenMeteoForecast,
  getCachedMeteoForecast,
  fetchMeteoFranceVigilanceRaw,
  extractDepartmentVigilance,
  sendWeatherPush,
  publishWeatherAlertToFacebook,
  isSameWeatherAlert,
  claimWeatherPush,
  releaseWeatherPushClaim,
};
