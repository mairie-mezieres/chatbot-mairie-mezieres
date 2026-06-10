// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const { redisGet, redisSet } = require("./redis");

// ─── Cache mémoire serveur ─────────────────────────────────────
// Évite un aller-retour Redis pour les clés lues fréquemment mais rarement écrites.
// Pattern identique au cache stats/iaStats déjà en place.
const MEM_TTL_SHORT = 60_000;       // 60 s — actus, idées, docs, sondages, info-banner
const MEM_TTL_LONG  = 5 * 60_000;  // 5 min — admin settings, réponses MEL mises en cache

const _mem = {};
function memGet(key) {
  const e = _mem[key];
  if (!e || Date.now() > e.exp) { delete _mem[key]; return undefined; }
  return e.val;
}
function memSet(key, val, ttl) { _mem[key] = { val, exp: Date.now() + ttl }; }
function memDel(key)           { delete _mem[key]; }

async function readSubs()               { return (await redisGet("mat:subs")) || []; }
async function writeSubs(d)             { await redisSet("mat:subs", d); }

// ── Historique des envois push (50 derniers, pour stats admin) ──
const PUSH_HISTORY_KEY = 'mat:push:history';
const PUSH_HISTORY_MAX = 50;
async function recordPushHistory(entry) {
  try {
    const history = (await redisGet(PUSH_HISTORY_KEY)) || [];
    history.unshift({ ts: Date.now(), ...entry });
    if (history.length > PUSH_HISTORY_MAX) history.length = PUSH_HISTORY_MAX;
    await redisSet(PUSH_HISTORY_KEY, history);
  } catch (e) { console.error('❌ recordPushHistory:', e.message); }
}
async function readNews()  { const c=memGet("mat:actus");        if(c!==undefined)return c; const v=(await redisGet("mat:actus"))||[];        memSet("mat:actus",v,MEM_TTL_SHORT);        return v; }
async function writeNews(d){ memSet("mat:actus",d,MEM_TTL_SHORT);        await redisSet("mat:actus",d); }
async function readIdeas() { const c=memGet("mat:idees");        if(c!==undefined)return c; const v=(await redisGet("mat:idees"))||[];        memSet("mat:idees",v,MEM_TTL_SHORT);        return v; }
async function writeIdeas(d){ memSet("mat:idees",d,MEM_TTL_SHORT);       await redisSet("mat:idees",d); }
async function readSignals()            { return (await redisGet("mat:signals")) || []; }
async function writeSignals(d)          { await redisSet("mat:signals", d); }
async function readLastWeatherAlert()   { return await redisGet("mat:weather:last"); }
async function writeLastWeatherAlert(d) { await redisSet("mat:weather:last", { ...d, pushedAt: new Date().toISOString() }); }
async function readMeteoCache()       { return await redisGet("mat:meteo:cache"); }
async function writeMeteoCache(data)  { await redisSet("mat:meteo:cache", data); }
async function readSeenPosts()          { return (await redisGet("mat:seen_posts")) || {}; }
async function writeSeenPosts(d)        { await redisSet("mat:seen_posts", d); }
async function readMelCache()  { const c=memGet("mat:mel:cache");   if(c!==undefined)return c; const v=(await redisGet("mat:mel:cache"))||{}; memSet("mat:mel:cache",v,MEM_TTL_LONG);     return v; }
async function writeMelCache(d){ memSet("mat:mel:cache",d,MEM_TTL_LONG);      await redisSet("mat:mel:cache",d); }
async function readTempDocs()  { const c=memGet("mat:docs:temp");   if(c!==undefined)return c; const v=(await redisGet("mat:docs:temp"))||[];  memSet("mat:docs:temp",v,MEM_TTL_SHORT);    return v; }
async function writeTempDocs(d){ memSet("mat:docs:temp",d,MEM_TTL_SHORT);    await redisSet("mat:docs:temp",d); }
async function readSondages()  { const c=memGet("mat:sondages");    if(c!==undefined)return c; const v=(await redisGet("mat:sondages"))||[];   memSet("mat:sondages",v,MEM_TTL_SHORT);     return v; }
async function writeSondages(d){ memSet("mat:sondages",d,MEM_TTL_SHORT);     await redisSet("mat:sondages",d); }
async function readPhotos()    { const c=memGet("mat:photos");      if(c!==undefined)return c; const v=(await redisGet("mat:photos"))||[];     memSet("mat:photos",v,MEM_TTL_SHORT);       return v; }
async function writePhotos(d)  { memSet("mat:photos",d,MEM_TTL_SHORT);       await redisSet("mat:photos",d); }
async function readSondageResults(id)    { return (await redisGet("mat:sondage:results:" + id)) || {total:0,answers:{}}; }
async function writeSondageResults(id,d) { await redisSet("mat:sondage:results:" + id, d); }
async function readFeaturedDoc()  { const c=memGet("mat:docs:featured"); if(c!==undefined)return c; const v=await redisGet("mat:docs:featured");   memSet("mat:docs:featured",v,MEM_TTL_SHORT); return v; }
async function writeFeaturedDoc(d){ memSet("mat:docs:featured",d,MEM_TTL_SHORT); await redisSet("mat:docs:featured",d); }
async function readEntreprises()         { return (await redisGet("mat:entreprises")) || []; }
async function writeEntreprises(d)       { await redisSet("mat:entreprises", d); }

const _STATIC_ENTREPRISES = [
  { id:1,  nom:'Chai Amandine et Quentin',       activite:'Viticulture & dégustation',       description:'Chai viticole proposant dégustation et vente de vins. Amandine et Quentin vous accueillent dans leur domaine pour découvrir leurs productions.', siteWeb:'https://www.chaiamandineetquentin.fr/', gerant:'Amandine et Quentin', telephone:'', email:'', logo:'' },
  { id:2,  nom:'EMAN Coach',                     activite:'Coaching & développement personnel', description:'Accompagnement individuel et professionnel : coaching de vie, développement personnel et bilan de compétences.', siteWeb:'https://eman-coach.fr/',                  gerant:'', telephone:'', email:'', logo:'' },
  { id:3,  nom:'Horticulteur Gatelier',           activite:'Horticulture',                    description:'Exploitation horticole familiale à Mézières-lez-Cléry : plants, fleurs, légumes et produits horticoles de qualité.',                           siteWeb:'https://www.horticulteur-gatelier.fr/',  gerant:'Famille Gatelier', telephone:'', email:'', logo:'' },
  { id:4,  nom:'Hypnoser',                        activite:'Hypnothérapie',                   description:'Cabinet d\'hypnothérapie : accompagnement pour l\'arrêt du tabac, gestion du stress, phobies, confiance en soi et développement personnel.',    siteWeb:'https://www.hypnoser.fr/',              gerant:'', telephone:'', email:'', logo:'' },
  { id:5,  nom:'Les Fruits de la Masure',         activite:'Production fruitière & dégustation', description:'Producteur de fruits locaux à Mézières-lez-Cléry. Vente directe à la ferme et dégustation de produits du terroir.',                          siteWeb:'',                                      gerant:'', telephone:'', email:'', logo:'' },
  { id:6,  nom:'Novo Assainissement',             activite:'Assainissement & Plomberie',      description:'Spécialiste de l\'assainissement non collectif, débouchage, travaux de plomberie et entretien de fosses septiques.',                            siteWeb:'https://www.novo-assainissement.com/',   gerant:'', telephone:'', email:'', logo:'' },
  { id:7,  nom:'Pascal Foulon Photographies',     activite:'Photographie',                    description:'Photographe professionnel basé à Mézières-lez-Cléry. Reportages, portraits, paysages et événements.',                                          siteWeb:'https://www.pascalfoulon-photographies.com/', gerant:'Pascal Foulon', telephone:'', email:'', logo:'' },
];
async function initEntreprisesIfEmpty() {
  const raw = await redisGet("mat:entreprises");
  if (raw === null) {
    await writeEntreprises(_STATIC_ENTREPRISES);
    console.log(`🏪 Entreprises initialisées (${_STATIC_ENTREPRISES.length} entrées)`);
  }
}

async function readMelTreeConfig() {
  return await redisGet("mat:mel:tree:data");
}

async function writeMelTreeConfig(data) {
  await redisSet("mat:mel:tree:data", data);
}

function getDefaultAdminSettings() {
  return {
    detailedStatsEnabled: true,
    melUsageStatsEnabled: true,
    appOpenStatsEnabled: true,
    melQuestionLogEnabled: false,
    melEnabled: true,
    melDisabledMessage: "",
    reactionsEnabled: true
  };
}

async function readAdminSettings() {
  const c = memGet("mat:admin:settings");
  if (c !== undefined) return c;
  const saved = (await redisGet("mat:admin:settings")) || {};
  const merged = { ...getDefaultAdminSettings(), ...saved };
  memSet("mat:admin:settings", merged, MEM_TTL_LONG);
  return merged;
}

async function writeAdminSettings(settings) {
  const merged = { ...getDefaultAdminSettings(), ...(settings || {}) };
  memSet("mat:admin:settings", merged, MEM_TTL_LONG);
  await redisSet("mat:admin:settings", merged);
}

// ─── Cache mémoire stats (évite les lectures/écritures Redis à chaque appel MEL) ──
// Les stats sont bufferisées en mémoire et flushées vers Redis toutes les 5 minutes.
// Réduit drastiquement le nb de commandes Redis (plan gratuit Upstash = 10 000/jour).
let _statsCache    = null;  // cache mémoire de mat:stats
let _iaStatsCache  = null;  // cache mémoire de mat:ia:stats
let _statsDirty    = false; // mat:stats a été modifié depuis le dernier flush
let _iaStatsDirty  = false; // mat:ia:stats a été modifié depuis le dernier flush
const STATS_FLUSH_MS = 5 * 60 * 1000; // flush toutes les 5 minutes

async function readStats() {
  if (_statsCache !== null) return _statsCache;
  _statsCache = (await redisGet("mat:stats")) || {};
  return _statsCache;
}
async function writeStats(d) {
  _statsCache = d;
  _statsDirty = true;
  // Pas d'écriture Redis immédiate — le flush périodique s'en charge
}
async function readIaStats() {
  if (_iaStatsCache !== null) return _iaStatsCache;
  _iaStatsCache = (await redisGet("mat:ia:stats")) || {};
  return _iaStatsCache;
}
async function writeIaStats(d) {
  _iaStatsCache = d;
  _iaStatsDirty = true;
}

async function flushStatsNow() {
  if (_statsDirty && _statsCache !== null) {
    await redisSet("mat:stats", _statsCache);
    _statsDirty = false;
  }
  if (_iaStatsDirty && _iaStatsCache !== null) {
    await redisSet("mat:ia:stats", _iaStatsCache);
    _iaStatsDirty = false;
  }
}

// Flush périodique vers Redis (toutes les 5 min)
setInterval(async () => {
  try {
    await flushStatsNow();
  } catch(e) {
    console.warn("Stats flush Redis:", e.message);
  }
}, STATS_FLUSH_MS);

// ── Abonnements déchets + météo push ────────────────────────────
async function readDechetsSubs()  { return (await redisGet('mat:subs:dechets')) || []; }
async function writeDechetsSubs(d){ await redisSet('mat:subs:dechets', d); }
async function readMeteoSubs()    { return (await redisGet('mat:subs:meteo'))  || []; }
async function writeMeteoSubs(d)  { await redisSet('mat:subs:meteo', d); }

// Purge un ou plusieurs endpoints de l'ensemble des stores de subscriptions
// push (mat:subs, mat:subs:meteo, mat:subs:dechets). Appelée après détection
// d'erreurs 410/404 pour éviter qu'un endpoint expiré soit re-tenté via un
// autre canal (ex: météo encore vivante alors qu'actus a déjà nettoyé).
// Best-effort : toute erreur de purge est absorbée pour ne jamais bloquer
// le caller (le cleanup local au site appelant reste l'opération autoritaire).
// Les appels sont sérialisés via _purgeChain pour éviter que deux purges
// concurrentes (avec endpoints différents) se marchent dessus en
// read-filter-write last-wins, ce qui ré-introduirait l'un des endpoints
// que l'autre vient de supprimer.
let _purgeChain = Promise.resolve();
function purgeEndpointsEverywhere(endpoints) {
  if (!Array.isArray(endpoints) || !endpoints.length) return Promise.resolve();
  const deadSet = new Set(endpoints);
  const work = async () => {
    const stores = [
      ['mat:subs',         readSubs,         writeSubs],
      ['mat:subs:meteo',   readMeteoSubs,    writeMeteoSubs],
      ['mat:subs:dechets', readDechetsSubs,  writeDechetsSubs]
    ];
    for (const [name, read, write] of stores) {
      try {
        const all = await read();
        const kept = all.filter(s => !deadSet.has(s.endpoint));
        if (kept.length !== all.length) {
          await write(kept);
          console.log(`🧹 ${name}: purgé ${all.length - kept.length} endpoint(s) expiré(s)`);
        }
      } catch (e) {
        console.warn(`purgeEndpointsEverywhere(${name}):`, e.message);
      }
    }
  };
  _purgeChain = _purgeChain.then(work, work);
  return _purgeChain;
}

module.exports = {
  MEM_TTL_SHORT, MEM_TTL_LONG,
  memGet, memSet, memDel,
  readSubs, writeSubs,
  readDechetsSubs, writeDechetsSubs,
  readMeteoSubs, writeMeteoSubs,
  purgeEndpointsEverywhere,
  recordPushHistory,
  readNews, writeNews,
  readIdeas, writeIdeas,
  readStats, writeStats,
  readSignals, writeSignals,
  readLastWeatherAlert, writeLastWeatherAlert,
  readMeteoCache, writeMeteoCache,
  readSeenPosts, writeSeenPosts,
  readMelCache, writeMelCache,
  readIaStats, writeIaStats,
  readTempDocs, writeTempDocs,
  readSondages, writeSondages,
  readPhotos, writePhotos,
  readSondageResults, writeSondageResults,
  readFeaturedDoc, writeFeaturedDoc,
  readEntreprises, writeEntreprises,
  initEntreprisesIfEmpty,
  readMelTreeConfig, writeMelTreeConfig,
  getDefaultAdminSettings, readAdminSettings, writeAdminSettings,
  flushStatsNow,
};
