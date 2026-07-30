// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";
//
// Restrictions sécheresse — API officielle VigiEau (api.vigieau.gouv.fr).
//
// Ce module est VOLONTAIREMENT séparé de la vigilance Météo-France (lib/meteo.js) :
// une alerte sécheresse ne doit jamais occuper le bandeau de vigilance météo. Côté
// habitant, elle se matérialise par une ACTUALITÉ distincte (source: 'vigieau') +
// la ligne « Restrictions » de la section Eau de l'overlay météo (frontend).
//
// On réutilise les briques actu existantes (sendActuPush, publishActuToFacebook)
// pour ne pas dupliquer la logique push / Facebook.

const axios = require("axios");
const { VIGIEAU_COMMUNE_INSEE, VIGIEAU_LAT, VIGIEAU_LON } = require("../config");

const VIGIEAU_API = "https://api.vigieau.gouv.fr/api";

// Échelle de gravité VigiEau (croissante). On tolère plusieurs noms de champs et
// orthographes côté API (comme le frontend mat-eau8.js).
//   1 = vigilance (aucune interdiction, économies recommandées)
//   2 = alerte (premières restrictions réelles)
//   3 = alerte renforcée
//   4 = crise (usages essentiels uniquement)
const SEVERITY = { 1: "vigilance", 2: "alerte", 3: "alerte renforcée", 4: "crise" };

function _severityFromRaw(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (s.indexOf("crise") >= 0) return 4;
  if (s.indexOf("renforc") >= 0) return 3;
  if (s.indexOf("alerte") >= 0) return 2;
  if (s.indexOf("vigilance") >= 0) return 1;
  return 0;
}

function _zoneSeverity(z) {
  const raw = [z.niveauGravite, z.niveauAlerte, z.niveau, z.niveauRestriction, z.type]
    .filter(Boolean)
    .join(" ");
  return _severityFromRaw(raw);
}

function severityLabel(level) {
  return SEVERITY[level] || null;
}

// ── Consignes (usages restreints) de la zone la plus grave ───────────────────
// L'endpoint liste /zones renvoie un résumé ; le détail /zones/{id} porte les
// `usages` (consignes par usage). On en extrait les plus contraignants.
async function _fetchZoneConsignes(zoneId) {
  if (!zoneId) return [];
  try {
    const r = await axios.get(`${VIGIEAU_API}/zones/${encodeURIComponent(zoneId)}`, {
      headers: { Accept: "application/json" },
      timeout: 8000,
    });
    const usages = Array.isArray(r.data?.usages) ? r.data.usages : [];
    // Priorité aux interdictions, puis réductions, puis le reste.
    const rank = (u) => {
      const n = String(u.niveauRestriction || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (n.indexOf("interdiction") >= 0) return 0;
      if (n.indexOf("reduction") >= 0 || n.indexOf("reduit") >= 0) return 1;
      return 2;
    };
    return usages
      .filter((u) => u && u.nom && rank(u) < 2)
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 4)
      .map((u) => ({
        usage: String(u.nom).trim(),
        restriction: String(u.niveauRestriction || "").trim(),
      }));
  } catch (_) {
    return [];
  }
}

// ── Une interrogation /zones (pour une combinaison de paramètres) ────────────
// Retourne { level, zones, worst } si déterminé, { level: null, ambiguous?, reason }
// sinon. `worst` est la zone brute la plus grave (pour arrêté + consignes).
async function _queryZonesStatus(params) {
  let r;
  try {
    r = await axios.get(`${VIGIEAU_API}/zones`, {
      params,
      headers: { Accept: "application/json" },
      timeout: 8000,
      validateStatus: () => true,
    });
  } catch (e) {
    return { level: null, reason: "network", detail: e.message };
  }

  // 409 : plusieurs zones de même type au point/commune interrogé → indéterminable.
  if (r.status === 409) return { level: null, ambiguous: true, reason: "multi-zone" };
  if (r.status < 200 || r.status >= 300) return { level: null, reason: "http", detail: r.status };

  const data = r.data;
  const zones = Array.isArray(data) ? data : Array.isArray(data?.zones) ? data.zones : null;
  if (!Array.isArray(zones)) return { level: null, reason: "shape" };

  let level = 0;
  let worst = null;
  const active = zones.map((z) => {
    const sev = _zoneSeverity(z);
    // À gravité égale, on privilégie une zone PORTANT un arrêté puis, à défaut,
    // le plus petit id : sans cet ordre, la zone « la plus grave » (et donc
    // l'arrêté de la signature) pouvait changer d'un cycle à l'autre au gré de
    // l'ordre de l'API — et faire repartir une notification identique.
    if (sev > level || (sev === level && sev > 0 && _preferZone(z, worst))) { level = sev; worst = z; }
    return {
      id: z.id || z.idZone || null,
      nom: z.nom || null,
      type: z.type || null,
      niveau: sev,
      arrete: (z.arrete && (z.arrete.id || z.arrete.numero)) || null,
    };
  });

  return { level, zones: active, worst };
}

// Départage deux zones de même gravité, de façon déterministe.
function _preferZone(z, current) {
  if (!current) return true;
  const aArr = (z.arrete && (z.arrete.id || z.arrete.numero)) || "";
  const bArr = (current.arrete && (current.arrete.id || current.arrete.numero)) || "";
  if (!!aArr !== !!bArr) return !!aArr;
  return String(z.id || z.idZone || "") < String(current.id || current.idZone || "");
}

// ── Statut sécheresse courant de la commune ──────────────────────────────────
// Retourne :
//   { level, label, zones, consignes, arreteId, complete, source }  si déterminé
//   { level: null, ambiguous?, reason }                             si indéterminé
//
// `complete` = TOUTES les requêtes ont abouti. Une lecture partielle (une seule
// des deux requêtes exploitable) ne peut que SOUS-estimer le niveau : elle sert
// à alerter (on ne rate pas une montée) mais jamais à constater une baisse.
// On ne renvoie JAMAIS un faux « aucune restriction » : seul un tableau de zones
// explicitement vide vaut level 0.
//
// DEUX requêtes en parallèle, car l'API officielle a deux chemins de résolution
// qui peuvent diverger (ADR-0009) :
//   1. par coordonnées (lon/lat du bourg + commune) — géométrique, c'est le chemin
//      utilisé par vigieau.gouv.fr quand un habitant saisit son adresse ;
//   2. par commune seule — index commune→zones, qui a déjà « oublié » la zone AEP
//      (eau potable) : constaté le 15/07/2026, site « alerte renforcée » (AEP) vs
//      commune « vigilance ».
// On retient le niveau LE PLUS GRAVE des réponses exploitables, pour ne jamais
// sous-estimer les restrictions.
async function fetchVigieauStatus(insee) {
  const commune = insee || VIGIEAU_COMMUNE_INSEE || "45203";
  const attempts = [];
  if (Number.isFinite(VIGIEAU_LAT) && Number.isFinite(VIGIEAU_LON)) {
    attempts.push({ lon: VIGIEAU_LON, lat: VIGIEAU_LAT, commune, profil: "particulier" });
  }
  attempts.push({ commune, profil: "particulier" });

  const results = await Promise.all(attempts.map(_queryZonesStatus));
  const usable = results.filter((s) => s.level != null);
  // Aucune réponse exploitable : on remonte l'échec de la requête prioritaire.
  if (usable.length === 0) return results[0];

  let best = usable[0];
  for (const s of usable) if (s.level > best.level) best = s;

  const worst = best.worst;
  const arreteId = worst ? (worst.arrete?.id || worst.arrete?.numero || null) : null;
  const consignes = best.level >= 2 && worst ? await _fetchZoneConsignes(worst.id || worst.idZone) : [];

  return {
    level: best.level,
    label: severityLabel(best.level),
    zones: best.zones,
    consignes,
    arreteId,
    complete: usable.length === attempts.length,
    source: "vigieau",
  };
}

// Signature de déduplication durable (verrou anti-course + traçabilité).
function vigieauSignature(s) {
  if (!s || s.level == null) return "";
  return [Number(s.level), s.arreteId || ""].join("|");
}

// ── Décision : faut-il notifier ? ────────────────────────────────────────────
// Fonction PURE (aucun Redis, aucun réseau) — testable, et seul endroit où se
// décide l'envoi d'une actu/push sécheresse.
//
// Règles, nées du bug du 30/07/2026 (deux notifications « crise » à un jour
// d'intervalle alors que le niveau n'avait jamais bougé) :
//
//  1. **Niveau inchangé → aucune notification.** Auparavant la déduplication
//     portait sur `niveau|arrêté` : un simple changement d'arrêté (ou une zone
//     « la plus grave » différente parce qu'une des deux requêtes avait échoué)
//     republiait une actu au texte identique.
//  2. **Montée → notification immédiate** (à partir du niveau 2), même sur une
//     lecture partielle : une lecture partielle ne peut que sous-estimer, donc
//     ce qu'elle voit est réellement en vigueur.
//  3. **Baisse → il faut une lecture COMPLÈTE, confirmée `DESCENT_CONFIRMATIONS`
//     fois de suite.** Une requête VigiEau en échec ou un index commune→zones
//     momentanément amnésique faisait passer le niveau de 4 à 2 (voire 0 →
//     fausse « fin des restrictions »), puis le cycle suivant le refaisait
//     monter → notification en boucle. Tant que la baisse n'est pas confirmée,
//     on ne mémorise même pas le niveau lu (`memorize: false`), sinon le retour
//     au niveau réel serait vu comme une montée.
const DESCENT_CONFIRMATIONS = 2;

function decideDroughtAction({ status, last, pending, force } = {}) {
  const none = (reason, extra) => Object.assign({ action: "none", reason, memorize: true, pending: null }, extra || {});
  if (!status || status.level == null) return { action: "none", reason: "unknown", memorize: false, pending: pending || null };

  const level = Number(status.level);
  if (force) return { action: "publish", reason: "force", memorize: true, pending: null };

  const lastLevel = last && typeof last.level === "number" ? last.level : null;

  // Première mesure connue : on notifie si on est déjà au-dessus du seuil.
  if (lastLevel === null) {
    return level >= 2
      ? { action: "publish", reason: "first-alert", memorize: true, pending: null }
      : none("below-threshold");
  }

  if (level === lastLevel) return none("unchanged");

  // Montée.
  if (level > lastLevel) {
    return level >= 2
      ? { action: "publish", reason: "escalation", memorize: true, pending: null }
      : none("below-threshold");
  }

  // Baisse : jamais sur une lecture partielle.
  if (!status.complete) {
    return { action: "none", reason: "descent-incomplete", memorize: false, pending: pending || null };
  }
  const count = pending && pending.level === level ? Number(pending.count || 0) + 1 : 1;
  if (count < DESCENT_CONFIRMATIONS) {
    return {
      action: "none",
      reason: "descent-pending",
      memorize: false,
      pending: { level, count, since: (pending && pending.level === level && pending.since) || new Date().toISOString() },
    };
  }
  return {
    action: "publish",
    reason: level < 2 ? "lifted" : "de-escalation",
    memorize: true,
    pending: null,
  };
}

// ── Visuel d'illustration (carte 1200×630) par niveau ────────────────────────
// Mêmes principes que vigilanceImageUrl (lib/meteo.js) : images hébergées sur le
// site, générées par app-mezieres/scripts/generate-secheresse-cards.js. Un niveau
// < 2 correspond ici à une LEVÉE de restrictions → carte « fin » (verte).
const DROUGHT_IMG_BASE = (process.env.DROUGHT_IMG_BASE || "https://mezieres-lez-clery.fr/img/secheresse").replace(/\/+$/, "");
const _IMG_SLUG = { 2: "alerte", 3: "alerte-renforcee", 4: "crise" };
function droughtImageUrl(level) {
  const l = Number(level || 0);
  const slug = l >= 2 ? (_IMG_SLUG[l] || "alerte") : "fin";
  return `${DROUGHT_IMG_BASE}/secheresse-${slug}.png`;
}

// ── Construction de l'actualité sécheresse (montée OU levée) ──────────────────
const LEVEL_EMOJI = { 1: "🟡", 2: "🟠", 3: "🔴", 4: "🟣" };

function buildDroughtActu(status) {
  const level = Number(status.level || 0);

  // Levée des restrictions (retour sous le seuil d'alerte).
  if (level < 2) {
    return {
      title: "✅ Sécheresse — fin des restrictions d'eau",
      description:
        "Les restrictions sécheresse sur la commune sont levées. " +
        "Merci d'avoir contribué aux économies d'eau. " +
        "Suivi en temps réel : https://vigieau.gouv.fr",
    };
  }

  const emoji = LEVEL_EMOJI[level] || "🚱";
  const lvl = severityLabel(level) || "alerte";
  const title = `${emoji} Sécheresse — ${lvl.charAt(0).toUpperCase() + lvl.slice(1)} : restrictions d'eau en vigueur`;

  const lines = [];
  if (level === 2) lines.push("Des restrictions d'usage de l'eau sont en vigueur sur la commune.");
  else if (level === 3) lines.push("Des restrictions renforcées d'usage de l'eau sont en vigueur sur la commune.");
  else lines.push("Niveau CRISE : seuls les usages prioritaires (santé, sécurité, eau potable) sont autorisés.");

  if (Array.isArray(status.consignes) && status.consignes.length) {
    lines.push("");
    lines.push("Principales mesures :");
    status.consignes.forEach((c) => {
      lines.push(`• ${c.usage}${c.restriction ? " — " + c.restriction : ""}`);
    });
  }

  lines.push("");
  lines.push("Toutes les consignes pour votre adresse : https://vigieau.gouv.fr");

  return { title, description: lines.join("\n") };
}

module.exports = {
  VIGIEAU_API,
  DESCENT_CONFIRMATIONS,
  fetchVigieauStatus,
  vigieauSignature,
  decideDroughtAction,
  severityLabel,
  buildDroughtActu,
  droughtImageUrl,
};
