// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

/**
 * Réplication Upstash → Upstash (sauvegarde / base de migration).
 *
 * Copie toutes les clés « mat:* » d'une base SOURCE vers une base CIBLE en
 * préservant le type (string / list / set / hash / zset) et le TTL.
 * Sémantique miroir : la cible reflète la source (les clés de même nom y sont
 * écrasées). Les valeurs sont copiées telles quelles (octets bruts), sans
 * interprétation : la copie est fidèle quelle que soit la façon dont l'app
 * a stocké la donnée.
 *
 * Variables d'environnement :
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN               (source — déjà présentes)
 *   TARGET_UPSTASH_REDIS_REST_URL / TARGET_UPSTASH_REDIS_REST_TOKEN (cible — à ajouter)
 *   REPLICATE_MATCH    (optionnel, défaut « mat:* »)
 *   REPLICATE_EXCLUDE  (optionnel, préfixes séparés par des virgules à ignorer,
 *                       ex. « mat:mel:count:,mat:mel:ipcount:,mat:notify:token: »)
 *
 * Usage CLI :
 *   node scripts/replicate-upstash.js            # réplique
 *   node scripts/replicate-upstash.js --dry-run  # inventaire seul, sans écriture
 *
 * NB : ne journalise jamais les valeurs (uniquement des compteurs) — les logs
 * peuvent être publics.
 */

const axios = require("axios");

const SRC_URL   = process.env.UPSTASH_REDIS_REST_URL;
const SRC_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DST_URL   = process.env.TARGET_UPSTASH_REDIS_REST_URL;
const DST_TOKEN = process.env.TARGET_UPSTASH_REDIS_REST_TOKEN;

const MATCH   = process.env.REPLICATE_MATCH || "mat:*";
const EXCLUDE = (process.env.REPLICATE_EXCLUDE || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Nombre d'éléments max par commande RPUSH/SADD/HSET/ZADD et de commandes par
// pipeline, pour borner la taille des requêtes et lisser la conso du quota.
const CHUNK = 100;

// Envoie un lot de commandes à l'endpoint /pipeline d'Upstash.
async function pipe(url, token, commands) {
  if (!commands.length) return [];
  const r = await axios.post(`${url}/pipeline`, commands, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    timeout: 20000,
  });
  return r.data || [];
}

// Exécute une commande unique et renvoie son résultat (lève en cas d'erreur).
async function one(url, token, args) {
  const [res] = await pipe(url, token, [args]);
  if (res && res.error) throw new Error(`${args[0]} : ${res.error}`);
  return res ? res.result : null;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Énumère toutes les clés de la source via SCAN (l'API REST Upstash le supporte).
async function scanAll() {
  const keys = [];
  let cursor = "0";
  do {
    const res = await one(SRC_URL, SRC_TOKEN, ["SCAN", cursor, "MATCH", MATCH, "COUNT", "500"]);
    cursor = String(res[0]);
    for (const k of res[1]) {
      if (!EXCLUDE.some((p) => k.startsWith(p))) keys.push(k);
    }
  } while (cursor !== "0");
  return keys;
}

// Récupère le type de chaque clé (par lots).
async function typesOf(keys) {
  const types = {};
  for (const batch of chunk(keys, CHUNK)) {
    const res = await pipe(SRC_URL, SRC_TOKEN, batch.map((k) => ["TYPE", k]));
    batch.forEach((k, i) => { types[k] = res[i] && res[i].result; });
  }
  return types;
}

// Construit les commandes d'écriture côté cible pour une clé donnée.
// Renvoie un tableau de commandes (DEL + recréation + PEXPIRE éventuel).
function writeCommands(key, type, value, pttl) {
  const cmds = [["DEL", key]];

  if (type === "string") {
    if (value === null) return [];           // clé disparue entre SCAN et lecture
    cmds.push(["SET", key, value]);
  } else if (type === "list") {
    for (const part of chunk(value, CHUNK)) cmds.push(["RPUSH", key, ...part]);
  } else if (type === "set") {
    for (const part of chunk(value, CHUNK)) cmds.push(["SADD", key, ...part]);
  } else if (type === "hash") {
    // value = [field1, val1, field2, val2, ...]
    for (const part of chunk(value, CHUNK * 2)) cmds.push(["HSET", key, ...part]);
  } else if (type === "zset") {
    // value = [member1, score1, member2, score2, ...] → ZADD score member
    const args = [];
    for (let i = 0; i < value.length; i += 2) args.push(value[i + 1], value[i]);
    for (const part of chunk(args, CHUNK * 2)) cmds.push(["ZADD", key, ...part]);
  } else {
    return []; // type inconnu / clé absente
  }

  if (typeof pttl === "number" && pttl > 0) cmds.push(["PEXPIRE", key, String(pttl)]);
  return cmds;
}

// Commande de lecture adaptée au type.
function readCommand(key, type) {
  switch (type) {
    case "string": return ["GET", key];
    case "list":   return ["LRANGE", key, "0", "-1"];
    case "set":    return ["SMEMBERS", key];
    case "hash":   return ["HGETALL", key];
    case "zset":   return ["ZRANGE", key, "0", "-1", "WITHSCORES"];
    default:       return null;
  }
}

/**
 * Réplique la source vers la cible.
 * @param {{dryRun?: boolean}} opts
 * @returns {Promise<{copied:number, byType:object, durationMs:number, dryRun:boolean}>}
 */
async function replicate(opts = {}) {
  const dryRun = !!opts.dryRun;
  const started = Date.now();

  if (!SRC_URL || !SRC_TOKEN) throw new Error("Source Upstash non configurée (UPSTASH_REDIS_REST_URL/TOKEN).");
  if (!dryRun && (!DST_URL || !DST_TOKEN)) throw new Error("Cible Upstash non configurée (TARGET_UPSTASH_REDIS_REST_URL/TOKEN).");

  const keys = await scanAll();
  const types = await typesOf(keys);

  const byType = {};
  for (const k of keys) { const t = types[k] || "?"; byType[t] = (byType[t] || 0) + 1; }

  if (dryRun) {
    return { copied: 0, byType, durationMs: Date.now() - started, dryRun: true };
  }

  let copied = 0;
  // On traite par lots de clés : lecture groupée (source) puis écriture groupée (cible).
  for (const batch of chunk(keys, CHUNK)) {
    const reads = batch.map((k) => readCommand(k, types[k])).filter(Boolean);
    const readableKeys = batch.filter((k) => readCommand(k, types[k]));
    const values = await pipe(SRC_URL, SRC_TOKEN, reads);
    const pttls  = await pipe(SRC_URL, SRC_TOKEN, readableKeys.map((k) => ["PTTL", k]));

    // Construit toutes les commandes d'écriture, sans scinder le groupe d'une clé.
    let buffer = [];
    const flush = async () => {
      if (!buffer.length) return;
      await pipe(DST_URL, DST_TOKEN, buffer);
      buffer = [];
    };
    for (let i = 0; i < readableKeys.length; i++) {
      const k = readableKeys[i];
      const cmds = writeCommands(k, types[k], values[i] ? values[i].result : null, pttls[i] ? pttls[i].result : -1);
      if (!cmds.length) continue;
      if (buffer.length + cmds.length > CHUNK) await flush();
      buffer.push(...cmds);
      copied++;
    }
    await flush();
  }

  return { copied, byType, durationMs: Date.now() - started, dryRun: false };
}

module.exports = { replicate };

// Exécution directe en CLI.
if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  replicate({ dryRun })
    .then((r) => {
      console.log(dryRun ? "🔍 Inventaire (dry-run) :" : "✅ Réplication terminée :");
      console.log(`   clés par type : ${JSON.stringify(r.byType)}`);
      if (!dryRun) console.log(`   clés copiées  : ${r.copied}`);
      console.log(`   durée         : ${r.durationMs} ms`);
    })
    .catch((e) => { console.error("❌ Réplication :", e.message); process.exit(1); });
}
