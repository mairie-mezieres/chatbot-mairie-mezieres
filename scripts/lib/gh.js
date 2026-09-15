/**
 * Socle GitHub commun aux scripts d'hygiène du dépôt.
 *
 * Deux consommateurs : `scripts/suivi-depot.js` (constate et annote) et
 * `scripts/dependabot-auto-merge.js` (fusionne, sous conditions). Ils partagent
 * la lecture de l'état de CI — et c'est précisément ce qu'il ne faut PAS
 * dupliquer : un suivi qui déclare « CI verte » pendant qu'un auto-merge lit
 * « rouge », ou l'inverse, serait une divergence invisible sur la décision la
 * plus lourde des deux (fusionner).
 *
 * ⚠️ `SUIVI_DRY_RUN=1` neutralise TOUTES les écritures (POST/PATCH/PUT) et les
 * journalise à la place. Nom commun aux deux scripts, volontairement.
 *
 * Node 20+ (fetch global). Aucune dépendance externe.
 */

'use strict';

const fs = require('fs');

const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || '';
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const DRY_RUN = /^(1|true|oui)$/i.test(String(process.env.SUIVI_DRY_RUN || '').trim());

function entetes(json) {
  const h = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mat-hygiene-depot',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** Appel API. Renvoie `{ ok, status, data }` ; ne lève pas sur un statut HTTP. */
async function gh(chemin, options = {}) {
  const methode = options.method || 'GET';
  const ecriture = methode !== 'GET';
  if (ecriture && DRY_RUN) {
    console.log(`[dry-run] ${methode} ${chemin} ${JSON.stringify(options.body || {}).slice(0, 200)}`);
    return { ok: true, status: 0, data: { dryRun: true } };
  }
  const res = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: entetes(ecriture),
    body: ecriture && options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) console.log(`::warning title=Hygiène dépôt::${methode} ${chemin} → HTTP ${res.status}`);
  return { ok: res.ok, status: res.status, data };
}

/** Pagination simple, plafonnée : ce dépôt n'a pas des milliers d'items. */
async function ghListe(chemin, pagesMax = 5) {
  const tout = [];
  for (let page = 1; page <= pagesMax; page += 1) {
    const sep = chemin.includes('?') ? '&' : '?';
    const { ok, data } = await gh(`${chemin}${sep}per_page=100&page=${page}`);
    if (!ok || !Array.isArray(data) || data.length === 0) break;
    tout.push(...data);
    if (data.length < 100) break;
  }
  return tout;
}

/**
 * Âge en JOURS d'un horodatage ISO — une DURÉE, comparée à un seuil.
 * (Ce quotient ne conviendrait pas pour dire « demain » à un habitant.)
 */
function ageJours(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86400000);
}

/** ⛔ C'est le marqueur qui rend un commentaire idempotent, pas son texte. */
function marqueur(nom) {
  return `<!-- suivi-depot:${nom} -->`;
}

/** Publie un commentaire au plus une fois par marqueur. */
async function commenterUneFois(numero, nomMarqueur, corps) {
  const commentaires = await ghListe(`/repos/${REPO}/issues/${numero}/comments`, 3);
  const cible = marqueur(nomMarqueur);
  if (commentaires.some((c) => c && typeof c.body === 'string' && c.body.includes(cible))) {
    console.log(`#${numero} : commentaire « ${nomMarqueur} » déjà publié — rien à faire.`);
    return false;
  }
  const { ok } = await gh(`/repos/${REPO}/issues/${numero}/comments`, {
    method: 'POST', body: { body: `${cible}\n${corps}` },
  });
  if (ok) console.log(`#${numero} : commentaire « ${nomMarqueur} » ${DRY_RUN ? 'simulé (dry-run)' : 'publié'}.`);
  return ok;
}

function resume(texte) {
  const fichier = process.env.GITHUB_STEP_SUMMARY;
  if (fichier) fs.appendFileSync(fichier, `${texte}\n`);
  console.log(texte);
}

/**
 * État de la CI sur un commit : `{ etat, echecs }`.
 *
 * ⛔ Deux sources, et il faut les deux : les **check runs** (les jobs GitHub
 * Actions) et les **commit statuses** de l'API — un statut posé par l'API
 * n'apparaît dans aucun check run. N'en lire qu'une, c'est conclure « verte »
 * sur la moitié des preuves.
 *
 * ⚠️ `neutral` et `skipped` ne sont PAS des échecs : un job conditionnel ignoré
 * est un fonctionnement normal. Les compter en rouge rendrait le signal faux.
 * ⚠️ « aucune » (rien n'a tourné) n'est pas « verte » : l'appelant décide, et
 * pour une fusion automatique l'absence de preuve ne vaut pas preuve.
 */
async function etatCI(sha) {
  const echecs = [];
  let vus = 0;
  let enCours = false;

  const runs = await gh(`/repos/${REPO}/commits/${sha}/check-runs?per_page=100`);
  for (const run of (runs.data && runs.data.check_runs) || []) {
    vus += 1;
    if (run.status !== 'completed') { enCours = true; continue; }
    if (['failure', 'timed_out', 'action_required'].includes(run.conclusion)) echecs.push(run.name);
  }

  const st = await gh(`/repos/${REPO}/commits/${sha}/status`);
  for (const s of (st.data && st.data.statuses) || []) {
    vus += 1;
    if (s.state === 'pending') { enCours = true; continue; }
    if (s.state === 'failure' || s.state === 'error') echecs.push(s.context);
  }

  if (echecs.length > 0) return { etat: 'rouge', echecs };
  if (enCours) return { etat: 'en cours', echecs };
  return { etat: vus > 0 ? 'verte' : 'aucune', echecs };
}

function pastille(etat) {
  return { verte: '✅ verte', rouge: '❌ rouge', 'en cours': '⏳ en cours', aucune: '➖ aucune' }[etat] || etat;
}

module.exports = { API, REPO, TOKEN, DRY_RUN, gh, ghListe, ageJours, marqueur, commenterUneFois, resume, etatCI, pastille };
