// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { adminAuth } = require("../lib/middleware");
const { readNews, writeNews, readSignals, writeSignals, readStats, writeStats, readIaStats, writeIaStats } = require("../lib/store");
const { deleteActuImageFromCloudinary } = require("../lib/cloudinary");
const { redisDel } = require("../lib/redis");
const { logAudit } = require("../lib/logger");

// ── Route : purge données par date ───────────────────────────
router.post("/admin/purge", adminAuth, async (req, res) => {
  const { type, beforeDate } = req.body || {};
  if (!type || !beforeDate) return res.status(400).json({ error: "type et beforeDate requis" });

  let deleted = 0;
  const cloudinaryResults = [];

  async function cleanupActusImages(actusToDelete = []) {
    for (const actu of actusToDelete) {
      if (!actu.photoPublicId) continue;
      try {
        const r = await deleteActuImageFromCloudinary(actu.photoPublicId);
        cloudinaryResults.push({
          id: actu.id,
          publicId: actu.photoPublicId,
          result: r?.result || "ok"
        });
      } catch (e) {
        cloudinaryResults.push({
          id: actu.id,
          publicId: actu.photoPublicId,
          error: e.message
        });
      }
    }
  }

  try {
    if (type === "actus") {
      const actus = await readNews();
      const toDelete = actus.filter(a => (a.dateISO || "") < beforeDate);
      const filtered = actus.filter(a => (a.dateISO || "") >= beforeDate);
      await cleanupActusImages(toDelete);
      deleted = actus.length - filtered.length;
      await writeNews(filtered);

    } else if (type === "signals") {
      const signals = await readSignals();
      const filtered = signals.filter(s => (s.dateISO || "") >= beforeDate);
      deleted = signals.length - filtered.length;
      await writeSignals(filtered);

    } else if (type === "stats_parjour") {
      const stats = await readStats();
      const keys = Object.keys(stats.parJour || {}).filter(d => d < beforeDate);
      keys.forEach(k => delete stats.parJour[k]);
      deleted = keys.length;
      await writeStats(stats);

    } else if (type === "ia_stats_daily") {
      const ia = await readIaStats();
      const keys = Object.keys(ia.daily || {}).filter(d => d < beforeDate);
      keys.forEach(k => delete ia.daily[k]);
      deleted = keys.length;
      await writeIaStats(ia);

    } else if (type === "ia_categories_parjour") {
      const stats = await readStats();
      const cats = (stats.iaCategories || {}).parJour || {};
      const keys = Object.keys(cats).filter(d => d < beforeDate);
      keys.forEach(k => delete cats[k]);
      deleted = keys.length;
      await writeStats(stats);

    } else if (type === "all_before") {
      const stats = await readStats();
      const ia = await readIaStats();
      const cutoffMonth = beforeDate.slice(0, 7);

      const actus = await readNews();
      const oldActus = actus.filter(a => (a.dateISO || "") < beforeDate);
      const filteredActus = actus.filter(a => (a.dateISO || "") >= beforeDate);
      await cleanupActusImages(oldActus);
      deleted += actus.length - filteredActus.length;
      await writeNews(filteredActus);

      const signals = await readSignals();
      const filteredSignals = signals.filter(s => (s.dateISO || "") >= beforeDate);
      deleted += signals.length - filteredSignals.length;
      await writeSignals(filteredSignals);

      for (const key of Object.keys(stats.parJour || {}).filter(d => d < beforeDate)) { delete stats.parJour[key]; deleted++; }
      if (stats.uniqueUsers?.byDay) for (const key of Object.keys(stats.uniqueUsers.byDay).filter(d => d < beforeDate)) { delete stats.uniqueUsers.byDay[key]; deleted++; }
      if (stats.uniqueUsers?.byMonth) for (const key of Object.keys(stats.uniqueUsers.byMonth).filter(m => m < cutoffMonth)) { delete stats.uniqueUsers.byMonth[key]; deleted++; }
      if (stats.iaCategories?.parJour) for (const key of Object.keys(stats.iaCategories.parJour).filter(d => d < beforeDate)) { delete stats.iaCategories.parJour[key]; deleted++; }
      if (stats.deviceStats) {
        const ds = stats.deviceStats;
        for (const key of Object.keys(ds.appOpensByDay || {}).filter(d => d < beforeDate)) { delete ds.appOpensByDay[key]; deleted++; }
        for (const key of Object.keys(ds.daySeen || {}).filter(d => d < beforeDate)) { delete ds.daySeen[key]; deleted++; }
        for (const key of Object.keys(ds.byDay || {}).filter(d => d < beforeDate)) { delete ds.byDay[key]; deleted++; }
        for (const key of Object.keys(ds.byMonth || {}).filter(m => m < cutoffMonth)) { delete ds.byMonth[key]; deleted++; }
        for (const key of Object.keys(ds.monthSeen || {}).filter(m => m < cutoffMonth)) { delete ds.monthSeen[key]; deleted++; }
        for (const key of Object.keys(ds.appOpensByMonth || {}).filter(m => m < cutoffMonth)) { delete ds.appOpensByMonth[key]; deleted++; }
      }

      for (const key of Object.keys(ia.daily || {}).filter(d => d < beforeDate)) { delete ia.daily[key]; deleted++; }
      await writeStats(stats);
      await writeIaStats(ia);

      // Purge des questions MEL anonymes (clés journalières Redis list)
      const cutoff = new Date(beforeDate);
      const oldest = new Date(cutoff);
      oldest.setDate(oldest.getDate() - 90);
      for (let d = new Date(oldest); d < cutoff; d.setDate(d.getDate() + 1)) {
        const dayKey = `mat:mel:questions:${d.toISOString().slice(0, 10)}`;
        if (await redisDel(dayKey)) deleted++;
      }

    } else if (type === "mel_questions") {
      const cutoff = new Date(beforeDate);
      const oldest = new Date(cutoff);
      oldest.setDate(oldest.getDate() - 90);
      for (let d = new Date(oldest); d < cutoff; d.setDate(d.getDate() + 1)) {
        const dayKey = `mat:mel:questions:${d.toISOString().slice(0, 10)}`;
        if (await redisDel(dayKey)) deleted++;
      }

    } else {
      return res.status(400).json({ error: "type inconnu" });
    }

    logAudit("Purge données", `type=${type} avant=${beforeDate} → ${deleted} supprimé(s)`).catch(() => {});
    const extra = cloudinaryResults.length ? { cloudinary: cloudinaryResults } : {};
    res.json({ ok: true, deleted, ...extra });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
