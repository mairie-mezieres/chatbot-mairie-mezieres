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
 * dit.
 *
 * ⛔ Et si elle répond ENCORE 403, ce n'est toujours pas un lien mort. Des
 * en-têtes de navigateur ne suffisent pas à ressembler à un navigateur :
 * Cloudflare regarde aussi l'empreinte TLS et le protocole (Node parle en
 * HTTP/1.1 quand Chrome parle en h2), et rien de tout cela ne se falsifie
 * depuis `fetch`. C'est exactement ce qui est arrivé à `xpfibre.com/loiret-thd`
 * — l'URL qui a motivé ce script — dans l'issue #453 : re-testée, toujours 403,
 * donc « cassée », donc une issue ouverte sur un lien parfaitement vivant.
 * D'où un verdict à TROIS états. Un 403/429 qui persiste ne dit pas « cette
 * page n'existe pas », il dit « je ne réponds pas aux robots » : le lien est
 * déclaré INVÉRIFIABLE automatiquement — listé dans le rapport, re-testé chaque
 * semaine, mais il n'ouvre pas d'issue. Seule une absence de ressource
 * (404/410, DNS, connexion refusée, expiration) compte comme un lien cassé.
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
// mesurer (« un habitant peut-il ouvrir ce lien ? »). La liste complète que
// Chrome envoie sur une navigation — les `Sec-Fetch-*` et `sec-ch-ua` compris,
// dont l'absence est à elle seule un signal de robot. Ça ne suffit pas toujours
// (cf. l'en-tête de fichier), d'où le verdict « bloqué » plus bas.
const NAVIGATEUR = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
};

const DELAI_MS = 30000;
const ESSAIS = 2;

/* Codes par lesquels un serveur refuse de SERVIR un client, sans rien dire de
   l'existence de la page. Un habitant, lui, l'ouvre. On ne les compte donc pas
   comme des liens cassés — mais on ne les exclut pas non plus : ils restent
   re-testés chaque semaine et affichés dans le rapport.
   ⚠️ Volontairement étroit. 401 n'y est PAS : une page qui réclame des
   identifiants est inutilisable pour l'habitant, donc c'est un vrai défaut.
   404 et 410 non plus, évidemment : ceux-là parlent de la ressource. */
const REFUS_AUX_ROBOTS = new Set([403, 429, 999]);

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

/**
 * Trois verdicts possibles, et un seul compte comme un lien cassé :
 *   'vivant'  — le serveur a servi la page (< 400) : faux positif de lychee ;
 *   'bloque'  — le serveur refuse les robots (403/429/999) : on ne sait pas, et
 *               « on ne sait pas » n'est pas « c'est mort » ;
 *   'casse'   — la ressource est absente ou injoignable : 404, 410, 5xx, DNS,
 *               connexion refusée, expiration.
 */
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
      if (rep.status < 400) return { verdict: 'vivant', detail: `HTTP ${rep.status}` };
      if (essai === ESSAIS) {
        return {
          verdict: REFUS_AUX_ROBOTS.has(rep.status) ? 'bloque' : 'casse',
          detail: `HTTP ${rep.status}`,
        };
      }
    } catch (e) {
      clearTimeout(minuteur);
      if (essai === ESSAIS) {
        return {
          verdict: 'casse',
          detail: e.name === 'AbortError' ? 'expiration (30 s)' : String(e.message || e),
        };
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { verdict: 'casse', detail: 'inconnu' };
}

(async () => {
  const rapport = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const erreurs = collecterErreurs(rapport);

  // Une URL peut être signalée depuis plusieurs fichiers (et une fois sur deux
  // en « Error (cached) ») : on ne la teste qu'une fois.
  const uniques = [...new Set(erreurs.filter((e) => /^https?:/i.test(e.url)).map((e) => e.url))];
  const verdicts = new Map();
  const ETIQUETTE = { vivant: '✅ vivant  ', bloque: '🤖 bloqué  ', casse: '🚫 cassé   ' };
  for (const url of uniques) {
    const v = await tester(url);
    verdicts.set(url, v);
    console.log(`${ETIQUETTE[v.verdict]} ${url} — ${v.detail}`);
  }

  // Une entrée non-HTTP (file://, chemin local) n'a pas été testée : elle n'a
  // donc pas de verdict, et c'est une vraie erreur — elle reste.
  const verdictDe = (e) => (verdicts.get(e.url) || { verdict: 'casse' }).verdict;
  const reels = erreurs.filter((e) => verdictDe(e) === 'casse');
  const bloques = erreurs.filter((e) => verdictDe(e) === 'bloque');
  const faussesAlertes = erreurs.filter((e) => verdictDe(e) === 'vivant');

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
      `${reels.length} cassé(s) après re-vérification` +
      (bloques.length ? `, ${bloques.length} refusé(s) aux robots (non comptés).` : '.')
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

  if (bloques.length) {
    const vus = [...new Set(bloques.map((e) => e.url))];
    lignes.push(
      `<details><summary>${vus.length} lien(s) que le serveur refuse de servir à un robot ` +
        `(403/429) — non comptés comme cassés</summary>`
    );
    lignes.push('');
    lignes.push(
      "Ces adresses répondent « accès refusé » à tout client qui n'est pas un vrai navigateur " +
        "(empreinte TLS, HTTP/2 : rien de tout cela ne se falsifie depuis un script). Le serveur " +
        "ne dit **pas** que la page a disparu — il dit qu'il ne répond pas aux robots. Elles sont " +
        'donc re-testées à chaque scan, mais n\'ouvrent pas d\'issue. Si un doute subsiste, ' +
        'ouvrir le lien à la main : c\'est la seule mesure qui fait foi.'
    );
    lignes.push('');
    for (const url of vus) lignes.push(`* <${url}> — ${verdicts.get(url).detail}`);
    lignes.push('');
    lignes.push('</details>');
    lignes.push('');
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

  console.log(
    `\n${reels.length} lien(s) réellement cassé(s), ${bloques.length} refus aux robots (non comptés), ` +
      `${faussesAlertes.length} faux positif(s) écarté(s).`
  );
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `restants=${reels.length}\nbloques=${bloques.length}\n`);
  }
  // Quand rien n'est cassé, aucune issue n'est ouverte : sans ça, les liens
  // « bloqués » ne seraient visibles nulle part. Le résumé du run les porte.
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lignes.join('\n') + '\n');
  }
})().catch((e) => {
  console.error('Échec de la re-vérification :', e);
  process.exit(1);
});
