/*
 * MAT — Mézières Avec Toi
 * Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
 * Licence MIT — voir LICENSE
 *
 * lib/dates.js — Helpers de dates (Europe/Paris, jours fériés zone B).
 */

// ─── Date du jour à Paris (YYYY-MM-DD + YYYY-MM) ─────────────
function getParisDateParts() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = t => fmt.find(p => p.type === t)?.value || '';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return { day, month: day.slice(0, 7) };
}

// ─── Formatage d'une date d'alerte météo en français ─────────
function formatAlertDateFr(iso) {
  if (!iso) return "à préciser";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "à préciser";
  return d.toLocaleString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Jours fériés zone B (scolaire) ──────────────────────────
const FERIES_FIXES_B=['01-01','05-01','05-08','07-14','08-15','11-01','11-11','12-25'];
const FERIES_DATES_B=['2025-04-21','2025-05-29','2025-06-09','2026-04-06','2026-05-14','2026-05-25','2027-03-29','2027-05-17'];
function _isFerieDate(d){
  const mm=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');
  const iso=d.getFullYear()+'-'+mm+'-'+dd;
  return FERIES_FIXES_B.includes(mm+'-'+dd)||FERIES_DATES_B.includes(iso);
}

module.exports = { getParisDateParts, formatAlertDateFr, _isFerieDate, FERIES_FIXES_B, FERIES_DATES_B };
