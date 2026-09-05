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
const { filterRealProfils } = require("../lib/partager");
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

  // Kit de réplication « Partager » : visites/prompts du jour + profils
  // de communes collectés à la génération du prompt (routes/stats-public.js)
  const partagerVisitesToday = parJour[today]?.partager_visite || 0;
  const partagerPromptsToday = parJour[today]?.partager_prompt || 0;
  const partagerVisitesTotal = services.partager_visite || 0;
  const partagerPromptsTotal = services.partager_prompt || 0;
  // Les profils d'essai (« ville test », « Cancale »…) sont écartés : ils
  // arriveraient sinon dans ce mail comme de vraies communes intéressées.
  const partagerProfils = filterRealProfils(
    await redisLRange('mat:partager:profils', 0, 499).catch(() => [])
  );
  const partagerProfilsToday = partagerProfils.filter(p => String(p.date || '').startsWith(today));

  // Services actifs aujourd'hui (hors mel, installation, app_open traités séparément)
  const SVC_LABELS = {
    meteo:'🌦️ Météo', actualites:'📰 Actualités', agenda:'📅 Agenda',
    carburant:'⛽ Carburant', events_locaux:'🎭 Événements locaux',
    dechets:'🗑️ Déchets', sondages:'📊 Sondages', docs:'📄 Documents',
    nums:'📞 Numéros utiles', remi:'🚌 Bus Rémi', conseil:'🏛️ Conseil municipal',
    signalement:'🚨 Signalement', contact:'💬 Contact mairie', idees:'💡 Idées citoyennes',
    app_resume:'↩️ Retours avant-plan', jeu:'🎮 Jeu du moment',
    transport:'🚌 Transport', urbanisme:'🏗️ Urbanisme', service_public:'🏛️ Service public',
    meteoalert:'⚠️ Alerte météo'
  };
  // ⚠️ Mise en forme du mail : tout style s'écrit en attribut `style=`, toute mise en
  // page repose sur des <table>. Un bloc <style> avec des classes CSS est supprimé par
  // une bonne partie des clients de messagerie (Gmail selon le type de compte,
  // Outlook.com, Yahoo, applis mobiles) : le mail arrive alors sans aucune mise en
  // forme — c'est-à-dire en texte brut. `display:grid` et `display:flex` sont ignorés
  // par Outlook (moteur Word). Ne pas réintroduire de classe ni de feuille de style.
  const FONT = 'font-family:Arial,Helvetica,sans-serif';
  const esc  = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const svcList = Object.entries(parJour[today] || {})
    .filter(([k, v]) => v > 0 && k !== 'mel' && k !== 'installation' && k !== 'app_open')
    .sort(([,a],[,b]) => b - a);
  const svcRows = svcList
    .map(([k, v], i) => `<tr style="background:${i % 2 ? '#f4f0ea' : '#ffffff'}"><td style="${FONT};font-size:13px;padding:4px 8px">${esc(SVC_LABELS[k] || k)}</td><td style="${FONT};font-size:13px;padding:4px 8px;font-weight:700;text-align:right">${v}</td></tr>`)
    .join('');

  const dateLabel = new Date(today + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  // Équivalent de l'ancienne classe .card
  const card = (title, inner) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e2ddd8;border-radius:12px;margin-bottom:16px">
  <tr><td style="padding:20px">
    <div style="${FONT};color:#2d6a4f;font-size:16px;font-weight:700;margin:0 0 12px">${title}</div>
    ${inner}
  </td></tr>
</table>`;

  // Une pastille de chiffre (ancienne classe .stat). `lbl` peut porter du HTML :
  // le retour à la ligne et la tendance produits par trendLbl.
  const statCell = (val, lbl, bg, w) =>
    `<td width="${w}%" valign="top" style="padding:5px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg || '#d8f3dc'};border-radius:8px">
        <tr><td align="center" style="${FONT};padding:12px">
          <div style="font-size:24px;font-weight:900;color:#1a3d2b;line-height:1.2">${val}</div>
          <div style="font-size:11px;color:#2d6a4f;line-height:1.5;padding-top:4px">${lbl}</div>
        </td></tr>
      </table>
    </td>`;

  // Remplace `display:grid` : une <table> de `cols` colonnes. Les entrées falsy sont
  // ignorées, ce qui permet de garder les pastilles conditionnelles.
  const statGrid = (cells, cols = 2) => {
    const list = cells.filter(Boolean);
    if (!list.length) return '';
    const w = Math.round(100 / cols);
    let rows = '';
    for (let i = 0; i < list.length; i += cols) {
      const slice = list.slice(i, i + cols);
      rows += '<tr>'
        + slice.map(([val, lbl, bg]) => statCell(val, lbl, bg, w)).join('')
        + `<td width="${w}%" style="padding:5px"></td>`.repeat(cols - slice.length)
        + '</tr>';
    }
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
  };

  const trendLbl = (lbl, a, b, ref) =>
    b > 0 ? `${lbl}<br><span style="font-size:10px;color:#5a7065">${trend(a, b)} ${ref}</span>` : lbl;
  const redisBg = redisPctDay !== null && redisPctDay >= 80 ? '#fee2e2'
                : redisPctDay !== null && redisPctDay >= 60 ? '#fef3c7' : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAT — Statistiques du ${today}</title>
</head>
<body style="margin:0;padding:0;background:#f4f0ea;${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f0ea">
<tr><td align="center" style="padding:20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px">
<tr><td>

<div style="${FONT};color:#1a3d2b;font-size:22px;font-weight:700;margin:0 0 4px">📊 MAT — Statistiques</div>
<div style="${FONT};color:#5a7065;font-size:13px;margin:0 0 20px">${dateLabel}</div>

${card('👤 Fréquentation', statGrid([
  [uToday,      trendLbl("Visiteurs uniques aujourd'hui", uToday, uYest, 'vs hier')],
  [uMonth,      trendLbl('Visiteurs uniques ce mois', uMonth, uPrevM, 'vs mois préc.')],
  [accessToday, trendLbl("Accès app aujourd'hui", accessToday, accessYest, 'vs hier')],
  [accessMonth, 'Accès app ce mois']
]))}

${settings.melUsageStatsEnabled !== false ? card('💬 MEL — Chat IA', `
  ${statGrid([
    [melToday, trendLbl("Questions aujourd'hui", melToday, melYest, 'vs hier')],
    [melTotal, 'Total depuis le début'],
    [iaEurMonth > 0 ? '€' + iaEurMonth.toFixed(2) : '—', 'Coût IA ce mois']
  ], 3)}
  ${Object.keys(iaCatsToday).length > 0 ? `<div style="margin-top:12px"><strong style="${FONT};font-size:13px;color:#2d6a4f">Catégories aujourd'hui :</strong>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:6px">${
      Object.entries(iaCatsToday).sort(([,a],[,b])=>b-a).map(([k,v],i)=>`<tr style="background:${i % 2 ? '#f4f0ea' : '#ffffff'}"><td style="${FONT};font-size:13px;padding:3px 8px">${esc(IA_LABELS[k]||k)}</td><td style="${FONT};font-size:13px;padding:3px 8px;font-weight:700;text-align:right">${v}</td></tr>`).join('')
    }</table></div>` : ''}
  ${melLogs.length > 0 ? `<div style="margin-top:12px"><strong style="${FONT};font-size:13px;color:#2d6a4f">Questions du jour (${melLogs.length}) :</strong><div style="margin-top:6px">${
    melLogs.map(q => { const txt = typeof q === 'object' ? (q.q || '') : q; return `<div style="${FONT};background:#f4f0ea;border-radius:6px;padding:6px 10px;margin:4px 0;font-size:13px;color:#2d2d2d">${esc(txt)}</div>`; }).join('')
  }</div></div>` : ''}`) : ''}

${svcRows ? card('🛠️ Services utilisés aujourd\'hui',
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${svcRows}</table>`) : ''}

${card('🔔 Abonnements push', statGrid([
  [subs.length, 'Abonnés notifications'],
  decSubs.length > 0 ? [decSubs.length, 'Abonnés rappels déchets'] : null,
  [installToday > 0 ? `${installToday} / ${installTotal}` : installTotal,
   installToday > 0 ? "Installations aujourd'hui / total" : 'Installations PWA (total)']
]))}

${partagerVisitesTotal > 0 || partagerPromptsTotal > 0 || partagerProfils.length > 0 ? card('🧩 Kit réplication « Partager »', `
  ${statGrid([
    [partagerVisitesToday > 0 ? `${partagerVisitesToday} / ${partagerVisitesTotal}` : partagerVisitesTotal,
     partagerVisitesToday > 0 ? "Visites page aujourd'hui / total" : 'Visites page (total)'],
    [partagerPromptsToday > 0 ? `${partagerPromptsToday} / ${partagerPromptsTotal}` : partagerPromptsTotal,
     partagerPromptsToday > 0 ? "Prompts générés aujourd'hui / total" : 'Prompts générés (total)']
  ])}
  ${partagerProfilsToday.length > 0 ? `<div style="margin-top:12px"><strong style="${FONT};font-size:13px;color:#2d6a4f">Communes intéressées aujourd'hui (${partagerProfilsToday.length}) :</strong>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:6px">
      <thead><tr style="background:#f3f4f6">
        <th style="${FONT};font-size:13px;text-align:left;padding:4px 8px">Commune</th>
        <th style="${FONT};font-size:13px;text-align:right;padding:4px 8px">Habitants</th>
        <th style="${FONT};font-size:13px;text-align:right;padding:4px 8px">Budget</th>
        <th style="${FONT};font-size:13px;text-align:left;padding:4px 8px">Niveau info.</th>
      </tr></thead>
      <tbody>${partagerProfilsToday.map((p, i) => `
        <tr style="background:${i % 2 ? '#f4f0ea' : '#ffffff'}">
          <td style="${FONT};font-size:13px;padding:4px 8px">${esc(p.commune || '—')}${p.sovereign ? ' 🇫🇷' : ''}</td>
          <td style="${FONT};font-size:13px;padding:4px 8px;text-align:right">${p.population != null ? Number(p.population).toLocaleString('fr-FR') : '—'}</td>
          <td style="${FONT};font-size:13px;padding:4px 8px;text-align:right">${p.budget != null ? esc(p.budget) + ' €/mois' : '—'}</td>
          <td style="${FONT};font-size:13px;padding:4px 8px">${p.niveau === 'intermediaire' ? 'Intermédiaire' : 'Débutant'}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>` : `<p style="${FONT};color:#6b7280;font-style:italic;font-size:13px;margin:10px 0 0">Aucun nouveau profil de commune aujourd'hui${partagerProfils.length > 0 ? ` (${partagerProfils.length} collecté${partagerProfils.length > 1 ? 's' : ''} au total)` : ''}.</p>`}`) : ''}

${card('⚡ Redis Upstash', statGrid([
  [redisCmdDay !== null ? redisCmdDay : '—',
   `Commandes aujourd'hui${redisPctDay !== null ? ' (' + redisPctDay + '% du quota)' : ''}`, redisBg],
  [redisCmdMonth !== null ? redisCmdMonth : '—', 'Commandes ce mois']
]))}

${card('🤖 Questions posées à MEL', melQuestions.length === 0
  ? `<p style="${FONT};color:#6b7280;font-style:italic;font-size:13px;margin:0">Pas de question posée aujourd'hui.</p>`
  : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">
      <thead><tr style="background:#f3f4f6">
        <th style="${FONT};font-size:13px;text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb">Question</th>
        <th style="${FONT};font-size:13px;text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb">Réponse MEL</th>
        <th style="${FONT};font-size:13px;text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb">Catégorie</th>
      </tr></thead>
      <tbody>${melQuestions.map((q, i) => `
        <tr style="background:${i % 2 === 0 ? '#ffffff' : '#f9fafb'}">
          <td style="${FONT};font-size:13px;padding:6px 8px;border-bottom:1px solid #f3f4f6">${esc(q.q)}</td>
          <td style="${FONT};font-size:13px;padding:6px 8px;border-bottom:1px solid #f3f4f6;color:#374151">${q.a ? esc(q.a) : '<span style="color:#9ca3af;font-style:italic">—</span>'}</td>
          <td style="${FONT};font-size:13px;padding:6px 8px;border-bottom:1px solid #f3f4f6;color:#6b7280">${esc(q.cat)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`)}

${pendingSignals.length > 0 || pendingIdeas.length > 0 ? card('📋 En attente de traitement', statGrid([
  pendingSignals.length > 0 ? [pendingSignals.length, '🚨 Signalements en attente', '#fef3c7'] : null,
  pendingIdeas.length   > 0 ? [pendingIdeas.length,   '💡 Idées en attente',        '#fef3c7'] : null
])) : ''}

<div style="${FONT};color:#5a7065;font-size:12px;text-align:center;margin-top:16px">MAT · Mézières-lez-Cléry · ${new Date().toLocaleDateString('fr-FR', { timeZone:'Europe/Paris' })}</div>

</td></tr></table>
</td></tr></table>
</body></html>`;

  // Variante texte : un client qui n'affiche que le `text/plain` (préférence de
  // l'utilisateur, montre connectée, lecteur d'écran) reçoit un rapport lisible
  // plutôt qu'un HTML dépouillé.
  const pct = redisPctDay !== null ? ` (${redisPctDay}% du quota)` : '';
  const text = [
    `MAT — Statistiques du ${dateLabel}`,
    '',
    'FRÉQUENTATION',
    `- Visiteurs uniques aujourd'hui : ${uToday}${uYest > 0 ? ` (${trend(uToday, uYest)} vs hier)` : ''}`,
    `- Visiteurs uniques ce mois : ${uMonth}${uPrevM > 0 ? ` (${trend(uMonth, uPrevM)} vs mois préc.)` : ''}`,
    `- Accès app aujourd'hui : ${accessToday}${accessYest > 0 ? ` (${trend(accessToday, accessYest)} vs hier)` : ''}`,
    `- Accès app ce mois : ${accessMonth}`,
    ...(settings.melUsageStatsEnabled !== false ? [
      '',
      'MEL — CHAT IA',
      `- Questions aujourd'hui : ${melToday}${melYest > 0 ? ` (${trend(melToday, melYest)} vs hier)` : ''}`,
      `- Total depuis le début : ${melTotal}`,
      `- Coût IA ce mois : ${iaEurMonth > 0 ? '€' + iaEurMonth.toFixed(2) : '—'}`
    ] : []),
    ...(svcList.length ? ['', "SERVICES UTILISÉS AUJOURD'HUI",
      ...svcList.map(([k, v]) => `- ${SVC_LABELS[k] || k} : ${v}`)] : []),
    '',
    'ABONNEMENTS PUSH',
    `- Abonnés notifications : ${subs.length}`,
    ...(decSubs.length > 0 ? [`- Abonnés rappels déchets : ${decSubs.length}`] : []),
    `- Installations PWA : ${installToday > 0 ? `${installToday} aujourd'hui / ${installTotal} au total` : installTotal}`,
    '',
    'REDIS UPSTASH',
    `- Commandes aujourd'hui : ${redisCmdDay !== null ? redisCmdDay + pct : '—'}`,
    `- Commandes ce mois : ${redisCmdMonth !== null ? redisCmdMonth : '—'}`,
    '',
    'QUESTIONS POSÉES À MEL',
    ...(melQuestions.length === 0
      ? ["- Pas de question posée aujourd'hui."]
      : melQuestions.map(q => `- ${String(q.q || '').trim()}${q.cat ? ` [${q.cat}]` : ''}`)),
    ...(pendingSignals.length > 0 || pendingIdeas.length > 0 ? ['', 'EN ATTENTE DE TRAITEMENT',
      ...(pendingSignals.length > 0 ? [`- Signalements : ${pendingSignals.length}`] : []),
      ...(pendingIdeas.length   > 0 ? [`- Idées : ${pendingIdeas.length}`]          : [])] : []),
    '',
    `MAT · Mézières-lez-Cléry · ${new Date().toLocaleDateString('fr-FR', { timeZone:'Europe/Paris' })}`
  ].join('\n');

  try {
    await axios.post('https://api.resend.com/emails', {
      from: process.env.RESEND_FROM || 'MAT Stats <onboarding@resend.dev>',
      to:   [DAILY_STATS_EMAIL],
      subject: `📊 MAT — Stats du ${today}`,
      html,
      text
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
