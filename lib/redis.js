// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const axios = require("axios");
const { REDIS_URL, REDIS_TOKEN, UPSTASH_EMAIL, UPSTASH_API_KEY, UPSTASH_REDIS_DB_ID } = require("../config");

// Suivi du quota journalier Upstash (10 000 req/jour)
// Quand 429 reçu, on bascule en mode dégradé jusqu'à minuit UTC
let _redis429Active = false;
let _redis429ClearAt = 0;

function _isRedis429() {
  if (_redis429Active && Date.now() >= _redis429ClearAt) {
    _redis429Active = false;
    console.log('✅ Redis quota 429 expiré — reprise du mode normal');
  }
  return _redis429Active;
}

function _setRedis429() {
  if (!_redis429Active) {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    _redis429ClearAt = midnight.getTime();
    _redis429Active = true;
    console.warn('🔴 Redis quota journalier dépassé (429) — mode dégradé jusqu\'à minuit UTC');
  }
}

async function redisGet(key) {
  if (!REDIS_URL) return null;
  try {
    const r = await axios.get(
      `${REDIS_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 8000 }
    );
    const val = r.data.result;
    if (val === null || val === undefined) return null;
    return JSON.parse(val);
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    console.warn(`Redis GET ${key}:`, e.message);
    return null;
  }
}

async function redisSet(key, value) {
  if (!REDIS_URL) return;
  try {
    const encoded = encodeURIComponent(key);
    await axios.post(
      `${REDIS_URL}/set/${encoded}`,
      JSON.stringify(value),
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" }, timeout: 8000 }
    );
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    console.warn(`Redis SET ${key}:`, e.message);
  }
}

async function redisSetex(key, ttlSeconds, value) {
  if (!REDIS_URL) return;
  try {
    const encoded = encodeURIComponent(key);
    await axios.post(
      `${REDIS_URL}/setex/${encoded}/${ttlSeconds}`,
      JSON.stringify(value),
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" }, timeout: 8000 }
    );
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    console.warn(`Redis SETEX ${key}:`, e.message);
  }
}

async function redisDel(key) {
  if (!REDIS_URL) return false;
  try {
    const r = await axios.get(
      `${REDIS_URL}/del/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 8000 }
    );
    return (r.data?.result || 0) > 0;
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    console.warn(`Redis DEL ${key}:`, e.message);
    return false;
  }
}

async function redisPipeline(commands) {
  if (!REDIS_URL) return [];
  try {
    const r = await axios.post(
      `${REDIS_URL}/pipeline`,
      commands,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" }, timeout: 8000 }
    );
    return r.data || [];
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    console.warn("Redis pipeline:", e.message);
    return [];
  }
}

async function redisSismember(key, member) {
  if (!REDIS_URL) return false;
  if (_isRedis429()) return false;
  try {
    const r = await axios.get(
      `${REDIS_URL}/sismember/${encodeURIComponent(key)}/${encodeURIComponent(String(member))}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 8000 }
    );
    return (r.data?.result || 0) === 1;
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    console.warn(`Redis SISMEMBER ${key}:`, e.message);
    return false;
  }
}

async function redisSadd(key, member) {
  if (!REDIS_URL) return 0;
  if (_isRedis429()) return 0;
  try {
    const r = await axios.get(
      `${REDIS_URL}/sadd/${encodeURIComponent(key)}/${encodeURIComponent(String(member))}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 8000 }
    );
    return r.data?.result || 0;
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    console.warn(`Redis SADD ${key}:`, e.message);
    return 0;
  }
}

async function redisSrem(key, member) {
  if (!REDIS_URL) return 0;
  if (_isRedis429()) return 0;
  try {
    const r = await axios.get(
      `${REDIS_URL}/srem/${encodeURIComponent(key)}/${encodeURIComponent(String(member))}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 8000 }
    );
    return r.data?.result || 0;
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    console.warn(`Redis SREM ${key}:`, e.message);
    return 0;
  }
}

async function redisLRange(key, start, stop) {
  if (!REDIS_URL) return [];
  try {
    const r = await axios.get(
      `${REDIS_URL}/lrange/${encodeURIComponent(key)}/${start}/${stop}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, timeout: 8000 }
    );
    return (r.data?.result || []).map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(Boolean);
  } catch(e) {
    if (e.response?.status === 429) _setRedis429();
    console.warn(`Redis LRANGE ${key}:`, e.message);
    return [];
  }
}

async function getUpstashRedisStats() {
  if (!UPSTASH_EMAIL || !UPSTASH_API_KEY || !UPSTASH_REDIS_DB_ID) return null;

  try {
    const basic = Buffer.from(`${UPSTASH_EMAIL}:${UPSTASH_API_KEY}`).toString("base64");
    const r = await axios.get(
      `https://api.upstash.com/v2/redis/stats/${UPSTASH_REDIS_DB_ID}`,
      {
        headers: { Authorization: `Basic ${basic}` },
        timeout: 8000
      }
    );
    return r.data || null;
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  redisGet, redisSet, redisSetex, redisDel, redisPipeline, redisLRange,
  redisSismember, redisSadd, redisSrem,
  getUpstashRedisStats,
  _isRedis429, _setRedis429,
};
