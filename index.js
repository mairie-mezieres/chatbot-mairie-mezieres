/*
 * MAT — Mézières Avec Toi
 * Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
 * Licence MIT — voir LICENSE
 *
 * index.js — Point d'entrée d'exécution : démarre le serveur HTTP et les tâches
 * planifiées (polling météo/sécheresse, rappels déchets, arrêt gracieux).
 * La construction de l'app Express (middleware + routes) vit dans app.js, pour
 * permettre les tests d'intégration sans déclencher ces effets de bord.
 */

const app = require("./app");
const { _sendDechetsReminder } = app;

const axios = require("axios");
const { logServerError } = require("./lib/logger");
const { redisGet, redisSet } = require("./lib/redis");
const { initEntreprisesIfEmpty, flushStatsNow } = require("./lib/store");
const { refreshCalendarCache, refreshRemiCache, flushMelQuotas } = require("./lib/mel");
const { WEATHER_CHECK_INTERVAL_MS, DROUGHT_CHECK_INTERVAL_MS } = require("./config");

// ── Capture des erreurs Node.js non gérées → logs admin + Sentry ─────
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err.message);
  logServerError('uncaughtException', err.message, err.stack?.slice(0, 100));
  if (process.env.SENTRY_DSN) require('@sentry/node').captureException(err);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('💥 unhandledRejection:', msg);
  logServerError('unhandledRejection', msg);
  if (process.env.SENTRY_DSN) require('@sentry/node').captureException(reason instanceof Error ? reason : new Error(msg));
});

// ── Démarrage du serveur ──────────────────────────────────────
const PORT = process.env.PORT || 3000;

const _server = app.listen(PORT, async () => {
  console.log(`🚀 MAT Serveur v6.5 démarré sur le port ${PORT}`);
  console.log(`📱 PWA MEL    : /mel`);
  console.log(`📰 Facebook   : feed only`);
  console.log(`🚨 Signalement: /signal`);
  console.log(`🔔 Push       : /push/subscribe`);
  console.log(`🌦️ Météo      : /meteo/commune`);
  console.log(`⚠️ Vigilance  : /meteo/vigilance`);

  // Initialisation des données par défaut
  initEntreprisesIfEmpty().catch(e => console.warn("Entreprises init:", e.message));

  // Délai de 20s avant les init réseau pour laisser le DNS Render se stabiliser
  setTimeout(() => {
    refreshCalendarCache().catch(e => console.warn("Calendar cache init:", e.message));
    refreshRemiCache().catch(e => console.warn("Remi cache init:", e.message));
  }, 20000);

  // Weather check initial après 30s (DNS + réseau garantis stables)
  setTimeout(() => {
    axios.get(`http://127.0.0.1:${PORT}/meteo/alertes/check`)
      .catch(e => console.warn("Weather check initial:", e.message));

    // Puis polling toutes les WEATHER_CHECK_INTERVAL_MS
    setInterval(async () => {
      try {
        await axios.get(`http://127.0.0.1:${PORT}/meteo/alertes/check`);
      } catch (e) {
        console.warn("Weather check auto:", e.message);
      }
    }, WEATHER_CHECK_INTERVAL_MS);
  }, 30000);

  // Sécheresse VigiEau — check initial après 40s, puis polling lent (la sécheresse
  // évolue au plus une fois par jour). Flux séparé de la vigilance météo.
  setTimeout(() => {
    axios.get(`http://127.0.0.1:${PORT}/eau/restrictions/check`)
      .catch(e => console.warn("Sécheresse check initial:", e.message));

    setInterval(async () => {
      try {
        await axios.get(`http://127.0.0.1:${PORT}/eau/restrictions/check`);
      } catch (e) {
        console.warn("Sécheresse check auto:", e.message);
      }
    }, DROUGHT_CHECK_INTERVAL_MS);
  }, 40000);
});

// ── Rappels déchets quotidiens (fenêtre 18h–21h, heure de Paris) ─────
// La logique d'envoi (_sendDechetsReminder) et la route /cron/dechets vivent
// dans app.js ; ici on ne gère que le planificateur interne.
let _dechetsLastSent = null; // évite les Redis GETs répétés pendant la fenêtre du soir

setInterval(async () => {
  try {
    const pNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const h = pNow.getHours();
    // Fenêtre élargie 18h–21h : si le serveur redémarre à 18h30 (redéploiement Render),
    // la notification peut encore être envoyée jusqu'à 21h.
    if (h < 18 || h > 21) return;
    const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
    if (_dechetsLastSent === today) return; // court-circuit en mémoire
    const lastSent = await redisGet('mat:dechets:lastSent');
    if (lastSent === today) { _dechetsLastSent = today; return; }
    // Envoi AVANT de marquer la journée comme faite : si l'envoi échoue
    // (Redis en hoquet, lecture des abonnés KO…), on n'écrit pas le dedup
    // et on réessaie au prochain tick (toutes les 5 min, jusqu'à 21h) plutôt
    // que de perdre définitivement le rappel du jour. Cohérent avec la météo.
    await _sendDechetsReminder();
    _dechetsLastSent = today;
    await redisSet('mat:dechets:lastSent', today);
  } catch(e) { console.warn('Dechets reminder:', e.message); }
}, 5 * 60 * 1000);

// ── Graceful shutdown ─────────────────────────────────────────
// Render envoie SIGTERM ~30 s avant kill -9. On en profite pour :
//  - arrêter d'accepter de nouvelles connexions (server.close)
//  - flusher les caches stats dirty restés en mémoire
//  - laisser les requêtes en cours se terminer (timeout 25 s safety)
let _shuttingDown = false;
async function _gracefulShutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`🔻 ${sig} reçu — fermeture gracieuse…`);
  try {
    await flushStatsNow();
    console.log("   ✓ mat:stats / mat:ia:stats flushés");
    await flushMelQuotas();
    console.log("   ✓ mat:mel:quotas flushé");
  } catch (e) {
    console.warn("   ⚠️ flush shutdown:", e.message);
  }
  if (_server && typeof _server.close === "function") {
    _server.close(() => process.exit(0));
    setTimeout(() => { console.warn("   ⏰ timeout 25 s — exit forcé"); process.exit(1); }, 25000).unref();
  } else {
    process.exit(0);
  }
}
process.on("SIGTERM", () => _gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => _gracefulShutdown("SIGINT"));
