// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const axios = require("axios");
const {
  RESEND_API_KEY, DAILY_STATS_EMAIL, CRON_SECRET, AUTO_PUSH_WEATHER_MIN_LEVEL
} = require("../config");
const { adminAuth } = require("../lib/middleware");
const { redisGet, redisSet, redisLRange, getUpstashRedisStats } = require("../lib/redis");
const {
  readStats, readIaStats, readSubs, readDechetsSubs,
  readSignals, readIdeas, readAdminSettings
} = require("../lib/store");
const { calcIaCost } = require("../lib/stats");
const {
  fetchMeteoFranceVigilanceRaw, extractDepartmentVigilance,
  sendWeatherPush, weatherAlertSignature, claimWeatherPush, releaseWeatherPushClaim
} = require("../lib/meteo");

// ═══════════════════════════════════════════════════════════════
// EMAIL STATISTIQUES QUOTIDIENNES (Resend API)
// Variables : RESEND_API_KEY, DAILY_STATS_EMAIL
// ═══════════════════════════════════════════════════════════════

async function sendDailyStatsEmail() {
  if (!RESEND_API_KEY || !DAILY_STATS_EMAIL) return;

  const [stats, iaStats, subs, decSubs, signals, ideas, settings] = await Promise.all([
    readStats(), readIaStats(), readSubs(), readDechetsSubs(),
    readSignals(), readIdeas(), readAdminSettings()
  ]);

  const todayParis = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
  const today      = todayParis;
  const yesterday  = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() - 86400000));
  const month      = today.slice(0, 7);
  const prevMonth  = (() => { const d = new Date(today + 'T12:00:00Z'); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();

  const parJour  = stats.parJour  || {};
  const uniqueU  = stats.uniqueUsers || {};
  const services = stats.services || {};

  // Fréquentation
  const uToday   = (uniqueU.byDay   || {})[today]?.length   || 0;
  const uYest    = (uniqueU.byDay   || {})[yesterday]?.length || 0;
  const uMonth   = (uniqueU.byMonth || {})[month]?.length    || 0;
  const uPrevM   = (uniqueU.byMonth || {})[prevMonth]?.length || 0;
  const accessToday  = Object.values(parJour[today]     || {}).reduce((a,b) => a + Number(b||0), 0);
  const accessYest   = Object.values(parJour[yesterday] || {}).reduce((a,b) => a + Number(b||0), 0);
  const accessMonth  = Object.entries(parJour).filter(([d]) => d.startsWith(month)).reduce((s,[,v]) => s + Object.values(v||{}).reduce((a,b)=>a+Number(b||0),0), 0);
  const trend = (a, b) => b > 0 ? (a >= b ? `+${Math.round((a-b)/b*100)}%` : `-${Math.round((b-a)/b*100)}%`) : '';

  // MEL questions
  const melToday   = parJour[today]?.mel   || 0;
  const melYest    = parJour[yesterday]?.mel || 0;
  const melTotal   = services.mel || 0;
  const melLogs    = settings.melQuestionLogEnabled
    ? await redisLRange(`mat:mel:questions:${today}`, 0, 49).catch(() => [])
    : [];

  // IA catégories aujourd'hui
  const iaCatsToday = (stats.iaCategories?.parJour || {})[today] || {};
  const IA_LABELS   = { urbanisme:'🏗️ Urbanisme', dechets:'🗑️ Déchets', meteo:'🌦️ Météo', transport:'🚌 Transport', contact:'📞 Contact', autre:'❓ Autre' };

  // Coût IA du mois
  const monthIa = (iaStats.monthly || {})[month] || {};
  let iaEurMonth = 0;
  for (const [p, d] of Object.entries(monthIa)) { if (p !== '_total') iaEurMonth += d.costEur || 0; }

  // Redis
  let redisInfo = null;
  try { redisInfo = await getUpstashRedisStats(); } catch (_) {}
  if (redisInfo) console.log('[email] Upstash stats keys:', Object.keys(redisInfo).join(', '), '| values sample:', JSON.stringify(Object.fromEntries(Object.entries(redisInfo).filter(([,v])=>typeof v==='number').slice(0,8))));
  // dailyrequests est un tableau timeseries — utiliser les champs scalaires comme dans l'admin
  const redisCmdDay   = typeof redisInfo?.daily_net_commands === 'number'     ? redisInfo.daily_net_commands     : null;
  const redisCmdMonth = typeof redisInfo?.total_monthly_requests === 'number' ? redisInfo.total_monthly_requests : null;
  const redisPctDay   = redisCmdDay !== null ? Math.round(redisCmdDay / 10000 * 100) : null;

  // Questions MEL du jour
  const melQRaw = await redisLRange(`mat:mel:questions:${today}`, 0, -1).catch(() => []);
  const melQuestions = melQRaw.map(s => typeof s === 'object' ? s : (() => { try { return JSON.parse(s); } catch { return { q: String(s), cat: '' }; } })());

  // Signalements / idées en attente
  const pendingSignals = signals.filter(s => !s.status || s.status === 'pending' || s.status === 'new');
  const pendingIdeas   = ideas.filter(i => !i.status || i.status === 'pending' || i.status === 'new');

  // Installations PWA
  const installTotal = services.installation || 0;
  const installToday = parJour[today]?.installation || 0;

  // Services actifs aujourd'hui (hors mel, installation, app_open traités séparément)
  const SVC_LABELS = {
    meteo:'🌦️ Météo', actualites:'📰 Actualités', agenda:'📅 Agenda',
    carburant:'⛽ Carburant', events_locaux:'🎭 Événements locaux',
    dechets:'🗑️ Déchets', sondages:'📊 Sondages', docs:'📄 Documents',
    nums:'📞 Numéros utiles', remi:'🚌 Bus Rémi', conseil:'🏛️ Conseil municipal',
    signalement:'🚨 Signalement', contact:'💬 Contact mairie', idees:'💡 Idées citoyennes',
    app_resume:'↩️ Retours avant-plan',
    transport:'🚌 Transport', urbanisme:'🏗️ Urbanisme', service_public:'🏛️ Service public',
    meteoalert:'⚠️ Alerte météo'
  };
  const svcRows = Object.entries(parJour[today] || {})
    .filter(([k, v]) => v > 0 && k !== 'mel' && k !== 'installation' && k !== 'app_open')
    .sort(([,a],[,b]) => b - a)
    .map(([k, v]) => `<tr><td style="padding:4px 8px">${SVC_LABELS[k] || k}</td><td style="padding:4px 8px;font-weight:700;text-align:right">${v}</td></tr>`)
    .join('');

  const dateLabel = new Date(today + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const stat = (val, lbl, cls='') =>
    `<div class="stat${cls ? ' '+cls : ''}"><div class="stat-val">${val}</div><div class="stat-lbl">${lbl}</div></div>`;
  const redisCls = redisPctDay !== null && redisPctDay >= 80 ? 'danger' : redisPctDay !== null && redisPctDay >= 60 ? 'warn' : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body{font-family:system-ui,sans-serif;background:#f4f0ea;margin:0;padding:20px}
  .card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #e2ddd8}
  h1{color:#1a3d2b;font-size:1.4rem;margin:0 0 4px}
  .sub{color:#5a7065;font-size:0.85rem;margin-bottom:20px}
  h2{color:#2d6a4f;font-size:1rem;margin:0 0 12px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .stat{background:#d8f3dc;border-radius:8px;padding:12px;text-align:center}
  .stat-val{font-size:1.5rem;font-weight:900;color:#1a3d2b}
  .stat-lbl{font-size:0.70rem;color:#2d6a4f;margin-top:2px}
  .trend{font-size:0.65rem;color:#5a7065}
  .warn{background:#fef3c7}.danger{background:#fee2e2}
  table{width:100%;border-collapse:collapse;font-size:0.85rem}
  tr:nth-child(even){background:#f4f0ea}
  .foot{color:#5a7065;font-size:0.75rem;text-align:center;margin-top:16px}
  .q{background:#f4f0ea;border-radius:6px;padding:6px 10px;margin:4px 0;font-size:0.82rem;color:#2d2d2d}
</style></head>
<body>
<h1>📊 MAT — Statistiques</h1>
<div class="sub">${dateLabel}</div>

<div class="card">
  <h2>👤 Fréquentation</h2>
  <div class="grid">
    ${stat(uToday, `Visiteurs uniques aujourd'hui${uYest > 0 ? '<br><span class="trend">'+trend(uToday,uYest)+' vs hier</span>' : ''}`)}
    ${stat(uMonth, `Visiteurs uniques ce mois${uPrevM > 0 ? '<br><span class="trend">'+trend(uMonth,uPrevM)+' vs mois préc.</span>' : ''}`)}
    ${stat(accessToday, `Accès app aujourd'hui${accessYest > 0 ? '<br><span class="trend">'+trend(accessToday,accessYest)+' vs hier</span>' : ''}`)}
    ${stat(accessMonth, 'Accès app ce mois')}
  </div>
</div>

${settings.melUsageStatsEnabled !== false ? `<div class="card">
  <h2>💬 MEL — Chat IA</h2>
  <div class="grid3">
    ${stat(melToday, `Questions aujourd'hui${melYest > 0 ? '<br><span class="trend">'+trend(melToday,melYest)+' vs hier</span>' : ''}`)}
    ${stat(melTotal, 'Total depuis le début')}
    ${stat(iaEurMonth > 0 ? '€'+iaEurMonth.toFixed(2) : '—', 'Coût IA ce mois')}
  </div>
  ${Object.keys(iaCatsToday).length > 0 ? `<div style="margin-top:12px"><strong style="font-size:0.8rem;color:#2d6a4f">Catégories aujourd'hui :</strong><br><table style="margin-top:6px">${
    Object.entries(iaCatsToday).sort(([,a],[,b])=>b-a).map(([k,v])=>`<tr><td style="padding:3px 8px">${IA_LABELS[k]||k}</td><td style="padding:3px 8px;font-weight:700;text-align:right">${v}</td></tr>`).join('')
  }</table></div>` : ''}
  ${melLogs.length > 0 ? `<div style="margin-top:12px"><strong style="font-size:0.8rem;color:#2d6a4f">Questions du jour (${melLogs.length}) :</strong><div style="margin-top:6px;max-height:200px;overflow:auto">${
    melLogs.map(q => { const txt = typeof q === 'object' ? (q.q || '') : String(q); return `<div class="q">${txt.replace(/</g,'&lt;')}</div>`; }).join('')
  }</div></div>` : ''}
</div>` : ''}

${svcRows ? `<div class="card">
  <h2>🛠️ Services utilisés aujourd'hui</h2>
  <table>${svcRows}</table>
</div>` : ''}

<div class="card">
  <h2>🔔 Abonnements push</h2>
  <div class="grid">
    ${stat(subs.length, 'Abonnés notifications')}
    ${decSubs.length > 0 ? stat(decSubs.length, 'Abonnés rappels déchets') : ''}
    ${stat(installToday > 0 ? `${installToday} / ${installTotal}` : installTotal, installToday > 0 ? "Installations aujourd'hui / total" : 'Installations PWA (total)')}
  </div>
</div>

<div class="card">
  <h2>⚡ Redis Upstash</h2>
  <div class="grid">
    ${stat(redisCmdDay !== null ? redisCmdDay : '—', `Commandes aujourd'hui${redisPctDay !== null ? ' ('+redisPctDay+'% du quota)' : ''}`, redisCls)}
    ${stat(redisCmdMonth !== null ? redisCmdMonth : '—', 'Commandes ce mois')}
  </div>
</div>

<div class="card">
  <h2>🤖 Questions posées à MEL</h2>
  ${melQuestions.length === 0
    ? '<p style="color:#6b7280;font-style:italic;margin:0">Pas de question posée aujourd\'hui.</p>'
    : `<table style="width:100%;border-collapse:collapse;font-size:0.82rem">
        <thead><tr style="background:#f3f4f6">
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb">Question</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb">Réponse MEL</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;white-space:nowrap">Catégorie</th>
        </tr></thead>
        <tbody>${melQuestions.map((q,i) => `
          <tr style="background:${i%2===0?'#fff':'#f9fafb'}">
            <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6">${String(q.q||'').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;color:#374151">${q.a ? String(q.a).replace(/</g,'&lt;').replace(/>/g,'&gt;') : '<span style="color:#9ca3af;font-style:italic">—</span>'}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;white-space:nowrap;color:#6b7280">${String(q.cat||'').replace(/</g,'&lt;')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
  }
</div>

${pendingSignals.length > 0 || pendingIdeas.length > 0 ? `<div class="card">
  <h2>📋 En attente de traitement</h2>
  <div class="grid">
    ${pendingSignals.length > 0 ? stat(pendingSignals.length, '🚨 Signalements en attente', 'warn') : ''}
    ${pendingIdeas.length   > 0 ? stat(pendingIdeas.length,   '💡 Idées en attente', 'warn')        : ''}
  </div>
</div>` : ''}

<div class="foot">MAT · Mézières-lez-Cléry · ${new Date().toLocaleDateString('fr-FR', { timeZone:'Europe/Paris' })}</div>
</body></html>`;

  try {
    await axios.post('https://api.resend.com/emails', {
      from: process.env.RESEND_FROM || 'MAT Stats <onboarding@resend.dev>',
      to:   [DAILY_STATS_EMAIL],
      subject: `📊 MAT — Stats du ${today}`,
      html
    }, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
  } catch(e) {
    const resendMsg = e.response?.data?.message || e.response?.data?.name || JSON.stringify(e.response?.data);
    const status = e.response?.status;
    throw new Error(`Resend ${status}: ${resendMsg || e.message}`);
  }

  console.log(`📧 Email stats quotidien envoyé à ${DAILY_STATS_EMAIL}`);
}

// Envoi quotidien à partir de 22h heure de Paris (vérification toutes les 5 min)
// Fenêtre large : toute heure >= 22h, dédup Redis évite le double-envoi même si le serveur se réveille tard
let _dailyStatsSentToday = null;
setInterval(async () => {
  try {
    if (!RESEND_API_KEY || !DAILY_STATS_EMAIL) return;
    const pNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    if (pNow.getHours() < 22) return;
    const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
    if (_dailyStatsSentToday === today) return;
    const lastSent = await redisGet('mat:daily:stats:sent');
    if (lastSent === today) { _dailyStatsSentToday = today; return; }
    await sendDailyStatsEmail();
    _dailyStatsSentToday = today;
    await redisSet('mat:daily:stats:sent', today);
  } catch(e) { console.warn('Daily stats email:', e.message); }
}, 5 * 60 * 1000).unref?.();

// Helper partagé : envoyer les stats (avec dédup sauf si force=true)
async function _triggerDailyStats(force) {
  if (!RESEND_API_KEY)  throw new Error('RESEND_API_KEY non configuré sur Render');
  if (!DAILY_STATS_EMAIL) throw new Error('DAILY_STATS_EMAIL non configuré');
  const today = new Intl.DateTimeFormat('sv', { timeZone: 'Europe/Paris' }).format(new Date());
  if (!force) {
    const lastSent = await redisGet('mat:daily:stats:sent');
    if (lastSent === today) return { skipped: true, reason: 'Déjà envoyé aujourd\'hui' };
  }
  await sendDailyStatsEmail();
  _dailyStatsSentToday = today;
  await redisSet('mat:daily:stats:sent', today);
  return { sent: true, to: DAILY_STATS_EMAIL };
}

// Endpoint admin (panel admin)
router.get("/admin/stats-email", adminAuth, async (req, res) => {
  try {
    const result = await _triggerDailyStats(req.query.force === '1');
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/email-config", adminAuth, async (req, res) => {
  try {
    const lastSent = await redisGet('mat:daily:stats:sent');
    res.json({
      resendConfigured: !!RESEND_API_KEY,
      emailConfigured: !!DAILY_STATS_EMAIL,
      email: DAILY_STATS_EMAIL || null,
      lastSent: lastSent || null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/upstash-raw", adminAuth, async (req, res) => {
  try {
    const raw = await getUpstashRedisStats();
    res.json({ ok: true, raw });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint cron — accessible avec ?key=CRON_SECRET (pour cron-job.org)
// Configurer CRON_SECRET dans les variables d'env Render
router.get("/cron/stats", async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET)
    return res.status(401).json({ error: 'Clé cron invalide' });
  try {
    const result = await _triggerDailyStats(req.query.force === '1');
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cron vigilance météo — à appeler toutes les 30 min via cron-job.org
// URL : /cron/meteo?key=CRON_SECRET
router.get("/cron/meteo", async (req, res) => {
  if (!CRON_SECRET || req.query.key !== CRON_SECRET)
    return res.status(401).json({ error: 'Clé cron invalide' });
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    const raw = await fetchMeteoFranceVigilanceRaw();
    const vigilance = extractDepartmentVigilance(raw, "45");

    if (!vigilance || Number(vigilance.level) < AUTO_PUSH_WEATHER_MIN_LEVEL) {
      return res.json({ ok: true, status: "no-alert", level: vigilance?.level ?? null });
    }

    // Une seule notification par alerte distincte : pas de re-push tant que la
    // signature (niveau+phénomène+fin) ne change pas. Partagé avec /meteo/alertes/check
    // via mat:weather:last:push ; claimWeatherPush = garde anti-course.
    const lastPush = await redisGet("mat:weather:last:push");
    if (!force && lastPush && weatherAlertSignature(lastPush) === weatherAlertSignature(vigilance)) {
      return res.json({ ok: true, status: "duplicate", level: vigilance.level, upcoming: vigilance.upcoming ?? false });
    }
    if (!await claimWeatherPush(vigilance, force)) {
      return res.json({ ok: true, status: "duplicate", level: vigilance.level, upcoming: vigilance.upcoming ?? false });
    }

    let pushResult;
    try {
      pushResult = await sendWeatherPush(vigilance);
      await redisSet("mat:weather:last:push", { ...vigilance, pushedAt: new Date().toISOString() });
    } catch (pe) {
      await releaseWeatherPushClaim(vigilance); // libère pour réessayer
      throw pe;
    }

    res.json({
      ok: true,
      status: "pushed",
      level: vigilance.level,
      upcoming: vigilance.upcoming ?? false,
      phenomenon: vigilance.phenomenon_label,
      push: pushResult
    });
  } catch(e) {
    console.error("❌ /cron/meteo:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
