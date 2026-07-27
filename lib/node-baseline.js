// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
"use strict";

/**
 * Socle de versions Node.js considérées comme sûres, par ligne de release.
 *
 * Pourquoi une table locale plutôt qu'un appel à nodejs.org ? Voir ADR-0010 :
 * le diagnostic doit rester déterministe et hors-ligne (les tests ne font aucun
 * appel réseau sortant réel) et ne doit pas dépendre de la disponibilité d'un
 * service tiers pour dire si le runtime est à jour.
 *
 * ⚠️ ENTRETIEN — ce fichier est le point unique à mettre à jour à chaque
 * publication de sécurité Node.js (la veille hebdomadaire les signale, cf.
 * `app-mezieres/veille/historique-techno.md`) :
 *   1. Reporter la version corrective de chaque ligne dans MIN_SAFE_BY_LINE.
 *   2. Mettre BASELINE_UPDATED à la date du jour.
 *   3. Remettre PENDING_ADVISORY à `null` une fois les versions connues.
 *   4. Redéployer le backend (Render ne reconstruit pas tout seul : cf.
 *      GUIDE-ADMIN.md §8) — sinon le diagnostic signalera l'écart, ce qui est
 *      précisément le but.
 */

/** Date de dernière révision manuelle de ce socle (AAAA-MM-JJ). */
const BASELINE_UPDATED = "2026-07-27";

/** Où vérifier les versions correctives. */
const BASELINE_SOURCE = "https://nodejs.org/en/security/";

/**
 * Version minimale sûre par ligne majeure, à la date BASELINE_UPDATED.
 * Ce sont les dernières versions publiées à cette date — la publication de
 * sécurité du 27/07/2026 (cf. PENDING_ADVISORY) n'était pas encore sortie.
 */
const MIN_SAFE_BY_LINE = Object.freeze({
  22: "22.23.1",
  24: "24.18.0",
  26: "26.5.0",
});

/** Lignes encore maintenues en sécurité à la date BASELINE_UPDATED. */
const SUPPORTED_LINES = Object.freeze([22, 24, 26]);

/**
 * Publication de sécurité annoncée dont les versions correctives ne sont pas
 * encore connues. Tant que ce champ n'est pas `null`, le diagnostic reste en
 * « warn » même si le runtime respecte MIN_SAFE_BY_LINE : l'annonce dit qu'une
 * faille HIGH existe, on ne peut simplement pas encore nommer la version qui la
 * corrige. Mettre à `null` dès que MIN_SAFE_BY_LINE a été mis à jour.
 */
const PENDING_ADVISORY = Object.freeze({
  date: "2026-07-27",
  severity: "HIGH",
  lines: Object.freeze([22, 24, 26]),
  url: "https://nodejs.org/en/blog/vulnerability/july-2026-security-releases",
});

/**
 * Découpe une version Node en [major, minor, patch].
 * Tolère le préfixe « v » et les suffixes de pré-version (« -rc.1 »).
 * @returns {number[]|null} null si la chaîne n'est pas exploitable.
 */
function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compare deux versions sémantiques.
 * @returns {number|null} <0 si a<b, 0 si égales, >0 si a>b ; null si illisible.
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Évalue une version de Node contre le socle.
 *
 * @param {string} [version] version à évaluer (défaut : le runtime courant).
 * @returns {{status:'ok'|'warn'|'danger', message:string, details:object}}
 */
function checkNodeVersion(version = process.version) {
  const parsed = parseVersion(version);
  const current = parsed ? parsed.join(".") : null;
  const line = parsed ? parsed[0] : null;
  const minSafe = line != null ? MIN_SAFE_BY_LINE[line] || null : null;

  const details = {
    current: version,
    line,
    min_safe: minSafe,
    baseline_updated: BASELINE_UPDATED,
    source: BASELINE_SOURCE,
    pending_advisory: PENDING_ADVISORY,
  };

  if (!parsed) {
    return {
      status: "warn",
      message: `Version Node illisible : ${version}`,
      details,
    };
  }

  if (!SUPPORTED_LINES.includes(line)) {
    return {
      status: "danger",
      message:
        `Node ${current} — la ligne ${line}.x n'est plus maintenue en sécurité. ` +
        `Migrer vers une ligne supportée (${SUPPORTED_LINES.join(", ")}).`,
      details,
    };
  }

  const cmp = compareVersions(current, minSafe);
  if (cmp !== null && cmp < 0) {
    return {
      status: "danger",
      message:
        `Node ${current} est antérieur au socle de sécurité ${minSafe}. ` +
        `Redéployer le backend pour récupérer la version corrective (GUIDE-ADMIN.md §8).`,
      details,
    };
  }

  if (PENDING_ADVISORY && PENDING_ADVISORY.lines.includes(line)) {
    return {
      status: "warn",
      message:
        `Node ${current} — publication de sécurité ${PENDING_ADVISORY.severity} ` +
        `annoncée le ${PENDING_ADVISORY.date} pour la ligne ${line}.x, versions ` +
        `correctives pas encore publiées. Vérifier ${BASELINE_SOURCE} puis mettre ` +
        `à jour lib/node-baseline.js et redéployer.`,
      details,
    };
  }

  return {
    status: "ok",
    message: `Node ${current} — conforme au socle de sécurité (≥ ${minSafe})`,
    details,
  };
}

module.exports = {
  BASELINE_UPDATED,
  BASELINE_SOURCE,
  MIN_SAFE_BY_LINE,
  SUPPORTED_LINES,
  PENDING_ADVISORY,
  parseVersion,
  compareVersions,
  checkNodeVersion,
};
