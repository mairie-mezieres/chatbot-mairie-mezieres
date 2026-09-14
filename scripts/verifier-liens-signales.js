#!/usr/bin/env node
/**
 * Re-vérifie « pour de vrai » les liens que lychee a déclarés cassés.
 *
 * Pourquoi : un scan automatisé ne mesure pas l'accessibilité d'une page, il
 * mesure la réponse d'un serveur À UN ROBOT. Beaucoup de sites (Cloudflare,
 * éditeurs de sites clés en main, grands comptes) répondent 403 à tout client
 * qui n'a pas d'en-têtes de navigateur, alors que la page s'ouvre normalement
 * pour un habitant. L'issue #450 en portait trois sur quatre :
 * chaiamandineetquentin.fr et xpfibre.com/loiret-thd (compté deux fois, la
 * seconde « Error (cached) »), tous parfaitement vivants.
 *
 * La réponse n'est PAS d'allonger encore la liste des `--exclude` : un domaine
 * exclu n'est plus jamais vérifié, y compris le jour où il meurt pour de bon
 * (c'est ainsi que `valdeloire-fibre.fr`, un domaine inexistant, a été annoncé
 * aux habitants pendant des mois). Ici on re-teste chaque URL signalée, avec
 * des en-têtes de navigateur ; si elle répond, elle sort du rapport et on le
 * dit. Si elle ne répond toujours pas, elle y reste.
 *
 * Entrée  : le rapport JSON de lychee (`--format json`).
 * Sortie  : un rapport Markdown (uniquement les liens RÉELLEMENT cassés) et,
 *           si `$GITHUB_OUTPUT` existe, `restants=<n>`.
 * Le script sort en 0 même quand des liens sont cassés : c'est `restants` qui
 * pilote le workflow (il ne sort en 1 que si le rapport lui-même est illisible).
 */

const fs = require('fs');
const path = require('path');

const [, , jsonPath, mdPath] = process.argv;
if (!jsonPath || !mdPath) {
  console.error('usage: verifier-liens-signales.js <rapport.json> <rapport.md>');
  process.exit(2);
}

// En-têtes d'un navigateur réel : c'est exactement ce que le scan prétend
// mesurer (« un habitant peut-il ouvrir ce lien ? »).
const NAVIGATEUR = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
};

const DELAI_MS = 30000;
const ESSAIS = 2;

function lireStatut(entree) {
  const s = entree && entree.status;
  if (s && typeof s === 'object') {
    if (Number.isInteger(s.code)) return { code: s.code, texte: String(s.text || '') };
    return { code: null, texte: String(s.text || JSON.stringify(s)) };
  }
  const texte = String(s == null ? '' : s);
  const m = texte.match(/\b([1-5]\d{2})\b/);
  return { code: m ? Number(m[1]) : null, texte };
}

/** Les entrées d'erreur de lychee, toutes versions : error_map ou fail_map. */
function collecterErreurs(rapport) {
  const carte = rapport.error_map || rapport.fail_map || {};
  const erreurs = [];
  for (const [fichier, entrees] of Object.entries(carte)) {
    for (const entree of entrees || []) {
      const url = typeof entree === 'string' ? entree : entree.url;
      if (!url) continue;
      erreurs.push({ fichier, url, ...lireStatut(entree) });
    }
  }
  return erreurs;
}

async function tester(url) {
  for (let essai = 1; essai <= ESSAIS; essai++) {
    const stop = new AbortController();
    const minuteur = setTimeout(() => stop.abort(), DELAI_MS);
    try {
      const rep = await fetch(url, {
        method: 'GET',
        headers: NAVIGATEUR,
        redirect: 'follow',
        signal: stop.signal,
      });
      clearTimeout(minuteur);
      // On ne lit pas le corps : le statut suffit, et certaines pages sont lourdes.
      if (rep.status < 400) return { vivant: true, detail: `HTTP ${rep.status}` };
      if (essai === ESSAIS) return { vivant: false, detail: `HTTP ${rep.status}` };
    } catch (e) {
      clearTimeout(minuteur);
      if (essai === ESSAIS) {
        return { vivant: false, detail: e.name === 'AbortError' ? 'expiration (30 s)' : String(e.message || e) };
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { vivant: false, detail: 'inconnu' };
}

(async () => {
  const rapport = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const erreurs = collecterErreurs(rapport);

  // Une URL peut être signalée depuis plusieurs fichiers (et une fois sur deux
  // en « Error (cached) ») : on ne la teste qu'une fois.
  const uniques = [...new Set(erreurs.filter((e) => /^https?:/i.test(e.url)).map((e) => e.url))];
  const verdicts = new Map();
  for (const url of uniques) {
    const v = await tester(url);
    verdicts.set(url, v);
    console.log(`${v.vivant ? '✅ vivant' : '🚫 cassé '} ${url} — ${v.detail}`);
  }

  const reels = erreurs.filter((e) => !(verdicts.get(e.url) || {}).vivant);
  const faussesAlertes = erreurs.filter((e) => (verdicts.get(e.url) || {}).vivant);

  const parFichier = new Map();
  for (const e of reels) {
    if (!parFichier.has(e.fichier)) parFichier.set(e.fichier, []);
    parFichier.get(e.fichier).push(e);
  }

  const lignes = [];
  lignes.push('# Liens cassés');
  lignes.push('');
  lignes.push(
    `Scan du ${new Date().toISOString().slice(0, 10)} — ` +
      `${rapport.total ?? '?'} liens vus, ${rapport.successful ?? '?'} valides, ` +
      `${reels.length} cassé(s) après re-vérification.`
  );
  lignes.push('');
  if (reels.length === 0) {
    lignes.push('Aucun lien réellement cassé.');
  } else {
    for (const [fichier, entrees] of parFichier) {
      lignes.push(`### ${fichier}`);
      lignes.push('');
      for (const e of entrees) {
        const v = verdicts.get(e.url);
        const detail = v ? v.detail : e.texte || 'erreur';
        lignes.push(`* <${e.url}> — lychee : ${e.texte || 'erreur'} · re-test navigateur : ${detail}`);
      }
      lignes.push('');
    }
  }

  if (faussesAlertes.length) {
    const vus = [...new Set(faussesAlertes.map((e) => e.url))];
    lignes.push(
      `<details><summary>${vus.length} lien(s) signalé(s) par lychee mais ouverts sans problème ` +
        `avec des en-têtes de navigateur (faux positifs, ignorés)</summary>`
    );
    lignes.push('');
    for (const url of vus) lignes.push(`* <${url}> — ${verdicts.get(url).detail}`);
    lignes.push('');
    lignes.push('</details>');
    lignes.push('');
  }

  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID) {
    lignes.push(
      `[Détail de l'exécution](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})`
    );
  }

  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, lignes.join('\n') + '\n', 'utf8');

  console.log(`\n${reels.length} lien(s) réellement cassé(s), ${faussesAlertes.length} faux positif(s) écarté(s).`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `restants=${reels.length}\n`);
  }
})().catch((e) => {
  console.error('Échec de la re-vérification :', e);
  process.exit(1);
});
