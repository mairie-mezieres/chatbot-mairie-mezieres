#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════
   Fusion automatique des PR Dependabot — sous conditions
   Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry — Licence MIT

   POURQUOI CE SCRIPT EXISTE
   -------------------------
   Le suivi du dépôt (ADR-0043) constate, il ne décide pas : il laisse chaque PR
   Dependabot verte en attente d'une décision humaine. Sur un dépôt tenu par une
   seule personne, cette décision est presque toujours la même — « oui » pour un
   correctif de version — et c'est ce « oui » répété qui finit par ne plus être
   donné du tout. Les PR s'accumulent, et parmi elles la mise à jour de sécurité
   qu'il fallait vraiment prendre.

   ⛔ CE N'EST PAS UN ASSOUPLISSEMENT DU SUIVI, C'EST UN AUTRE MÉTIER. Le suivi
   n'a que `contents: read` et ne fusionnera jamais. Celui-ci fusionne, donc il
   porte ses propres barrières — toutes exécutables, aucune consigne :

     1. **Auteur** : strictement `dependabot[bot]`, lu sur l'API (pas sur un
        titre ni sur un nom de branche, qui s'écrivent).
     2. **Fichiers** : la PR ne doit toucher QUE des `package.json` /
        `package-lock.json`. C'est la barrière qui compte : une PR Dependabot qui
        modifierait autre chose n'est plus une mise à jour de version.
     3. **Portée sémantique** : correctif (x.y.Z) toujours ; mineure (x.Y.z)
        seulement à partir de la 1.0.0. ⛔ **Jamais une majeure**, et **jamais une
        mineure en 0.x** : en pré-1.0, c'est la mineure qui porte les ruptures
        (semver §4) — `0.124 → 0.125` peut casser autant qu'un 1 → 2.
     4. **CI** : verte, sur les deux sources (check runs ET commit statuses).
        ⛔ « aucune » n'est pas « verte » : l'absence de preuve ne vaut pas preuve.
     5. **Fusionnable** : `mergeable_state === 'clean'`.
     6. **Plafond** : 5 fusions par exécution.

   ⚠️ **`main` n'est pas une branche protégée dans ce dépôt.** C'est pour cela que
   ce script vérifie la CI LUI-MÊME plutôt que d'activer l'auto-merge natif de
   GitHub : sans règle de protection exigeant des checks, `--auto` fusionne
   **immédiatement**, sans rien attendre. Le jour où `main` sera protégée, ce
   script restera correct ; l'inverse n'était pas vrai.

   ⚠️ Le workflow se déclenche à la FIN de la CI (`workflow_run`), pas à
   l'ouverture de la PR : à l'ouverture, il n'y a rien à lire.

   Best-effort : sort toujours en 0. `SUIVI_DRY_RUN=1` ne fusionne rien.

   Variables d'environnement :
     GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_API_URL - fournis par Actions
     AUTOMERGE_MAX      - plafond de fusions par exécution (défaut 5)
     AUTOMERGE_MINEURES - « 0 » pour n'accepter que les correctifs (défaut 1)
     SUIVI_DRY_RUN      - « 1 » : aucune fusion
   ════════════════════════════════════════════════════════════ */

'use strict';

const { TOKEN, REPO, DRY_RUN, gh, ghListe, resume, etatCI, pastille } = require('./lib/gh');

const MAX = Math.max(0, Number(process.env.AUTOMERGE_MAX || 5) || 0);
const MINEURES_OK = !/^(0|false|non)$/i.test(String(process.env.AUTOMERGE_MINEURES ?? '1').trim());

const AUTEUR = 'dependabot[bot]';
/* Les seuls fichiers qu'une mise à jour de version a de bonnes raisons de toucher. */
const FICHIERS_AUTORISES = /(^|\/)(package\.json|package-lock\.json)$/;

/**
 * Type de saut entre deux versions : 'patch' | 'mineure' | 'majeure' | null.
 *
 * ⚠️ Une pré-version (`1.2.3-beta.1`) renvoie `null` : elle n'est pas comparable
 * par ces règles, donc elle n'est pas éligible.
 */
function sautSemver(de, vers) {
  const decouper = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = decouper(de);
  const b = decouper(vers);
  if (!a || !b) return null;
  if (b[0] !== a[0]) return 'majeure';
  if (b[1] !== a[1]) return 'mineure';
  if (b[2] !== a[2]) return 'patch';
  return null;
}

/** Extrait « from X to Y » du titre Dependabot. `null` si le titre ne le dit pas. */
function versionsDuTitre(titre) {
  const m = /\bfrom\s+(\S+)\s+to\s+(\S+)/i.exec(String(titre || ''));
  return m ? { de: m[1], vers: m[2] } : null;
}

/**
 * La PR est-elle éligible ? Renvoie `{ ok, motif }` — `motif` sert au résumé,
 * et il est écrit pour être lu par un humain qui se demande « pourquoi pas ? ».
 */
function eligibilite(pr, fichiers) {
  if (!pr.user || pr.user.login !== AUTEUR) return { ok: false, motif: `auteur ${pr.user && pr.user.login}` };
  if (pr.draft) return { ok: false, motif: 'brouillon' };

  if (fichiers.length === 0) return { ok: false, motif: 'aucun fichier lu' };
  const horsPerimetre = fichiers.filter((f) => !FICHIERS_AUTORISES.test(f));
  if (horsPerimetre.length > 0) return { ok: false, motif: `touche ${horsPerimetre[0]}` };

  const v = versionsDuTitre(pr.title);
  if (!v) return { ok: false, motif: 'versions illisibles (groupe multiple ?)' };

  const saut = sautSemver(v.de, v.vers);
  if (!saut) return { ok: false, motif: `versions non comparables (${v.de} → ${v.vers})` };
  if (saut === 'majeure') return { ok: false, motif: `majeure ${v.de} → ${v.vers}` };
  if (saut === 'mineure') {
    if (!MINEURES_OK) return { ok: false, motif: `mineure ${v.de} → ${v.vers} (mineures désactivées)` };
    // ⛔ En 0.x, c'est la mineure qui porte les ruptures (semver §4).
    if (/^0\./.test(v.de)) return { ok: false, motif: `mineure en 0.x (${v.de} → ${v.vers})` };
  }
  return { ok: true, motif: `${saut} ${v.de} → ${v.vers}` };
}

(async () => {
  if (!TOKEN || !REPO.includes('/')) {
    console.log('GITHUB_TOKEN ou GITHUB_REPOSITORY manquant — fusion automatique abandonnée.');
    process.exit(0);
  }
  if (MAX === 0) {
    console.log('AUTOMERGE_MAX=0 — fusion automatique désactivée.');
    process.exit(0);
  }

  const ouvertes = await ghListe(`/repos/${REPO}/pulls?state=open&sort=created&direction=asc`);
  const candidates = ouvertes.filter((pr) => pr && pr.user && pr.user.login === AUTEUR);

  const lignes = [];
  let fusionnees = 0;

  for (const base of candidates) {
    // La liste ne porte pas `mergeable_state` : relire la PR une par une.
    const { ok, data: pr } = await gh(`/repos/${REPO}/pulls/${base.number}`);
    if (!ok || !pr || !pr.head) continue;

    const fichiers = (await ghListe(`/repos/${REPO}/pulls/${pr.number}/files`, 2))
      .map((f) => f && f.filename).filter(Boolean);
    const verdict = eligibilite(pr, fichiers);
    const ci = await etatCI(pr.head.sha);

    let decision;
    if (!verdict.ok) {
      decision = `⏸️ laissée — ${verdict.motif}`;
    } else if (ci.etat !== 'verte') {
      decision = `⏸️ laissée — CI ${ci.etat}`;
    } else if (pr.mergeable_state !== 'clean') {
      decision = `⏸️ laissée — état « ${pr.mergeable_state} »`;
    } else if (fusionnees >= MAX) {
      decision = `⏸️ laissée — plafond de ${MAX} atteint`;
    } else {
      // `sha` en garde : si la tête a bougé depuis la lecture de la CI, l'API
      // refuse la fusion plutôt que de fusionner un commit non vérifié.
      const res = await gh(`/repos/${REPO}/pulls/${pr.number}/merge`, {
        method: 'PUT',
        body: { merge_method: 'merge', sha: pr.head.sha },
      });
      if (res.ok) {
        fusionnees += 1;
        decision = `✅ fusionnée — ${verdict.motif}`;
      } else {
        decision = `⚠️ refus de l'API (HTTP ${res.status})`;
      }
    }
    lignes.push(`| #${pr.number} | ${String(pr.title).slice(0, 60)} | ${pastille(ci.etat)} | ${decision} |`);
  }

  const corps = lignes.length > 0
    ? ['| PR | Titre | CI | Décision |', '|---|---|---|---|', ...lignes]
    : ['_Aucune PR Dependabot ouverte._'];

  resume([
    '## 🤖 Fusion automatique Dependabot',
    '',
    `**${fusionnees}** fusionnée(s) sur ${candidates.length} PR examinée(s).`,
    '',
    ...corps,
    '',
    '> Règle : correctif toujours, mineure à partir de la 1.0.0, **jamais** une majeure',
    '> ni une mineure en 0.x — et seulement CI verte, `mergeable_state: clean`, et PR ne',
    '> touchant que `package.json` / `package-lock.json`. Le reste attend un humain.',
    DRY_RUN ? '\n_(dry-run : aucune fusion)_' : '',
  ].join('\n'));
})().catch((error) => {
  console.log(`::warning title=Auto-merge::Erreur inattendue : ${error.message}`);
  process.exit(0);
});
