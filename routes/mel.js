// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
const router = require("express").Router();
const { melLimiter, dlog } = require("../lib/middleware");
const { readAdminSettings } = require("../lib/store");
const {
  generateMelReply, trackMelStats, trackMelQuestion,
  _melDeviceId, _detectInjection, _checkMelAccess, _recordMelUse, _blockMelDevice,
  MEL_DAILY_LIMIT
} = require("../lib/mel");

// ── Proxy MEL pour la PWA ─────────────────────────────────────
const MEL_ALLOWED_ROLES = new Set(["user", "assistant"]);
router.post("/mel", melLimiter, async (req, res) => {
  const { messages, category, extraCtx } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error:"messages[] requis" });
  }
  // Validation stricte : on n'accepte que les rôles 'user' et 'assistant'.
  // Bloque les tentatives d'injection via {role:'system', content:'...'} qui
  // pourraient sinon être transmises à l'IA comme instruction système.
  // Les entrées malformées sont silencieusement filtrées.
  const validMessages = messages.filter(m =>
    m && typeof m === "object" && MEL_ALLOWED_ROLES.has(m.role)
  );
  if (!validMessages.length) {
    return res.status(400).json({ error: "messages[] doit contenir au moins une entrée {role:'user'|'assistant', content:string}" });
  }

  const melSettings = await readAdminSettings();
  if (melSettings.melEnabled === false) {
    const msg = melSettings.melDisabledMessage ||
      "Le chat MEL est temporairement indisponible. Contactez la mairie au 02 38 45 61 76 😊";
    return res.status(503).json({ error: "disabled", reply: msg });
  }

  const deviceId = _melDeviceId(req);

  // Vérification quota + blocage
  const access = await _checkMelAccess(deviceId);
  if (!access.ok) {
    if (access.reason === "blocked")
      return res.status(403).json({ error:"blocked", reply:"Votre accès au chat a été suspendu pour utilisation abusive. Contactez la mairie si nécessaire : 02 38 45 61 76 😊" });
    if (access.reason === "quota")
      return res.status(429).json({ error:"quota", reply:`Vous avez atteint la limite de ${MEL_DAILY_LIMIT} questions par jour. Revenez demain ! 😊` });
  }

  try {
    const MAX_MSG_LENGTH = 2000;
    const history = validMessages.slice(-8).map(m => ({
      role: m.role,
      content: (typeof m.content === "string" ? m.content : String(m.content || "")).slice(0, MAX_MSG_LENGTH)
    }));
    const lastUser = history.filter(m => m.role === "user").slice(-1)[0]?.content || "";

    // Détection prompt injection (sur tout l'historique)
    const allUserContent = history.filter(m => m.role === "user").map(m => m.content).join(' ');
    if (_detectInjection(allUserContent)) {
      await _blockMelDevice(deviceId, "injection");
      console.warn(`🚨 Injection MEL [${deviceId}]: "${lastUser.substring(0, 120)}"`);
      return res.status(403).json({ error:"blocked", reply:"Votre accès au chat a été suspendu. Contactez la mairie si nécessaire : 02 38 45 61 76 😊" });
    }

    await _recordMelUse(deviceId);
    await trackMelStats(lastUser);
    const result = await generateMelReply(lastUser, history, category || "autre", extraCtx || "");
    await trackMelQuestion(lastUser, category, result.reply);
    dlog(`📱 PWA MEL [${category||"autre"}] via ${result.provider}`);
    const showElus = (result.reply || "").includes("[SHOW_ELUS]");
    const showUrbanisme = (result.reply || "").includes("[SHOW_URBANISME]");
    const cleanReply = (result.reply || "")
      .replace("[SHOW_ELUS]", "")
      .replace("[SHOW_URBANISME]", "")
      .trim();
    res.json({ reply: cleanReply, provider: result.provider, showElus, showUrbanisme });
  } catch(e) {
    console.error("❌ MEL proxy:", e.message);
    res.json({ reply:"Je rencontre une difficulté technique. Contactez la mairie au 02 38 45 61 76 ou mairie@mezieres-lez-clery.fr 😊", provider:"fallback" });
  }
});


module.exports = router;
