#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════
   Suivi du dépôt — vérification et traitement des PR et issues ouvertes
   Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry — Licence MIT

   POURQUOI CE SCRIPT EXISTE
   -------------------------
   Entre deux passages du mainteneur, personne ne regarde les PR ouvertes. Une
   PR Dependabot en conflit, ou dont `npm test` échoue, ne le dit pas d'elle-même :
   il faut aller la voir. Sur un dépôt tenu par une seule personne, elle finit
   par être fusionnée sans qu'on remarque le rouge, ou par dormir des mois.

   LE PRINCIPE, ET C'EST LUI QUI COMPTE
   ------------------------------------
   ⛔ **Plus une PR est « à nous », plus on agit.** Un robot qui commente sur la
   PR d'un humain pour lui apprendre ce que GitHub lui affiche déjà en rouge est
   du bruit, et le bruit fait qu'on cesse de lire le canal.

     • PR automatiques (Dependabot, agents) → commentaire quand c'est actionnable
       (conflit, CI rouge), relance unique après N jours d'inactivité. Jamais de
       fermeture : fermer la PR d'un robot, c'est perdre la mise à jour qu'il
       proposait — et il la rouvrira.
     • PR humaines → **aucun commentaire**, jamais. Elles figurent au résumé.
     • Issues → résumé. L'issue « liens-morts » est écartée : elle a son propre
       gardien (`liens-morts.yml` la met à jour et la REFERME quand le scan
       repasse au vert ; un rappel posté ici survivrait à cette fermeture).
       Le rappel d'ancienneté est désactivé par défaut.

   Le canal par défaut est donc le **résumé du run** (onglet « Summary »), pas le
   commentaire. Le commentaire est l'exception, et il est idempotent : son marqueur
   porte le SHA de tête, de sorte qu'un même échec ne se re-signale pas à chaque
   passage, mais qu'un NOUVEL échec après un push parle.

   ⚠️ Ce script ne rejoue AUCUN contrôle : ces PR déclenchent la CI normalement,
   il LIT ce que la CI a conclu.

   ⚠️ **Jumeau dans le dépôt `app-mezieres`** (`scripts/suivi-depot.js`), à un
   détail près : là-bas, les PR `claude/veille-…` sont ignorées par ce script car
   elles ont leur propre canal (`veille-suivi.yml`, ADR-0042). La veille n'ouvre
   aucune PR ici. Toute correction de fond se reporte dans les deux.
   Décision et raisonnement : `app-mezieres/docs/adr/0043-…`.

   Best-effort : sort toujours en 0. `SUIVI_DRY_RUN=1` n'écrit rien.

   Variables d'environnement :
     GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_API_URL - fournis par Actions
     SUIVI_PR_RELANCE_JOURS    - relance des PR automatiques (défaut 14)
     SUIVI_ISSUE_RAPPEL_JOURS  - rappel des issues inactives (défaut 0 = désactivé)
     SUIVI_DRY_RUN             - « 1 » : aucune écriture

   Node 20+ requis (fetch global). Aucune dépendance externe.
   ════════════════════════════════════════════════════════════ */

'use strict';

/* Socle partagé avec `dependabot-auto-merge.js` : client d'API, lecture de
   l'état de CI, commentaires idempotents. ⛔ Ne pas le réimplémenter ici — un
   suivi qui lit « CI verte » pendant que l'auto-merge lit « rouge » serait une
   divergence invisible sur la décision la plus lourde des deux (fusionner). */
const {
  TOKEN, REPO, DRY_RUN, gh, ghListe, ageJours, commenterUneFois, resume, etatCI, pastille,
} = require('./lib/gh');

const RELANCE_JOURS = Math.max(0, Number(process.env.SUIVI_PR_RELANCE_JOURS || 14) || 0);
const RAPPEL_JOURS = Math.max(0, Number(process.env.SUIVI_ISSUE_RAPPEL_JOURS || 0) || 0);

/* Préfixes de branche des PR ouvertes par un automate. Tout le reste est
   considéré comme humain — le doute profite à l'humain, qu'on ne commente pas. */
const BRANCHES_AUTO = ['dependabot/', 'claude/'];
/* Issues qui ont déjà un gardien : les toucher ici, c'est doubler leur canal. */
const LABELS_ECARTES = ['liens-morts'];

function categorie(pr) {
  const ref = (pr.head && pr.head.ref) || '';
  return BRANCHES_AUTO.some((p) => ref.startsWith(p)) ? 'auto' : 'humaine';
}

async function traiterPr(numero) {
  // La liste des PR ne porte pas `mergeable_state` : il se lit PR par PR, et
  // GitHub le calcule de façon asynchrone — « unknown » veut dire « pas encore
  // calculé », jamais « en conflit ». Ne rien conclure dans ce cas.
  const { ok, data: pr } = await gh(`/repos/${REPO}/pulls/${numero}`);
  if (!ok || !pr || !pr.head) return null;

  const cat = categorie(pr);
  const sha = pr.head.sha;
  const conflit = pr.mergeable_state === 'dirty';
  const ci = await etatCI(sha);
  const inactif = ageJours(pr.updated_at);
  const ligne = `| #${pr.number} | ${cat} | ${pastille(ci.etat)} | ${conflit ? '⚠️ conflit' : 'ok'} | ${inactif} j | ${pr.draft ? 'brouillon' : 'ouverte'} |`;

  if (cat === 'humaine') return { ligne, ci, conflit };

  const court = String(sha).slice(0, 7);

  if (conflit) {
    await commenterUneFois(pr.number, `conflit-${court}`, [
      '⚠️ **Cette PR ne se fusionne plus avec `main`.**',
      '',
      'Elle a été ouverte automatiquement : si c\'est une mise à jour de dépendance,',
      'le plus simple est de la laisser être régénérée (Dependabot rouvre une PR à',
      'jour au prochain passage) plutôt que de résoudre le conflit à la main.',
      '',
      '_Signalé par le suivi du dépôt — aucune fermeture automatique._',
    ].join('\n'));
  } else if (ci.etat === 'rouge') {
    await commenterUneFois(pr.number, `ci-${court}`, [
      '❌ **La CI échoue sur cette PR ouverte automatiquement.**',
      '',
      ...ci.echecs.slice(0, 10).map((n) => `- \`${n}\``),
      '',
      'Une mise à jour de dépendance qui casse `npm test` **ne se fusionne pas** :',
      'soit le correctif d\'usage se fait dans la même PR, soit la version est',
      'écartée. Fermer sans regarder reviendrait à garder une version vulnérable.',
      '',
      '_Signalé par le suivi du dépôt._',
    ].join('\n'));
  } else if (RELANCE_JOURS > 0 && inactif >= RELANCE_JOURS) {
    await commenterUneFois(pr.number, `relance-${RELANCE_JOURS}j`, [
      `⏳ Cette PR automatique est sans activité depuis **${inactif} jours** et sa CI`,
      'ne signale rien. Elle attend une décision : fusionner ou fermer.',
      '',
      '_Rappel unique du suivi du dépôt — il ne reviendra pas._',
    ].join('\n'));
  }

  return { ligne, ci, conflit };
}

(async () => {
  if (!TOKEN || !REPO.includes('/')) {
    console.log('GITHUB_TOKEN ou GITHUB_REPOSITORY manquant — suivi du dépôt abandonné.');
    process.exit(0);
  }

  const ouvertes = await ghListe(`/repos/${REPO}/pulls?state=open&sort=created&direction=asc`);
  const lignes = [];
  let rouges = 0;
  let conflits = 0;

  for (const base of ouvertes) {
    const r = await traiterPr(base.number);
    if (!r) continue;
    lignes.push(r.ligne);
    if (r.ci.etat === 'rouge') rouges += 1;
    if (r.conflit) conflits += 1;
  }

  const blocPr = lignes.length > 0
    ? ['| PR | Origine | CI | Fusion | Inactivité | État |', '|---|---|---|---|---|---|', ...lignes]
    : ['_Aucune PR ouverte._'];

  const issues = (await ghListe(`/repos/${REPO}/issues?state=open&sort=updated&direction=asc`))
    .filter((i) => i && !i.pull_request)
    .filter((i) => !(i.labels || []).some((l) => LABELS_ECARTES.includes(l && l.name)));

  const lignesIssues = [];
  for (const issue of issues) {
    const inactif = ageJours(issue.updated_at);
    lignesIssues.push(`| #${issue.number} | ${String(issue.title).slice(0, 70)} | ${ageJours(issue.created_at)} j | ${inactif} j |`);
    if (RAPPEL_JOURS > 0 && inactif >= RAPPEL_JOURS) {
      await commenterUneFois(issue.number, `rappel-${RAPPEL_JOURS}j`, [
        `⏳ Sans activité depuis **${inactif} jours**. Toujours d'actualité ?`,
        '',
        '_Rappel unique du suivi du dépôt — il ne reviendra pas._',
      ].join('\n'));
    }
  }

  const blocIssues = lignesIssues.length > 0
    ? ['| Issue | Titre | Âge | Inactivité |', '|---|---|---|---|', ...lignesIssues]
    : ['_Aucune issue ouverte à suivre (celles qui ont leur propre gardien sont écartées)._'];

  resume([
    '## 🩺 Suivi du dépôt (backend)',
    '',
    `**${ouvertes.length}** PR ouverte(s) — ${rouges} à la CI rouge, ${conflits} en conflit.`,
    '',
    '### Pull requests',
    '',
    ...blocPr,
    '',
    '### Issues',
    '',
    ...blocIssues,
    '',
    '> L\'issue « liens-morts » est suivie par son propre workflow : elle ne reçoit',
    '> aucun commentaire d\'ici.',
    DRY_RUN ? '\n_(dry-run : aucune écriture)_' : '',
  ].join('\n'));

  if (rouges > 0 || conflits > 0) {
    console.log(`::warning title=Suivi du dépôt::${rouges} PR à la CI rouge, ${conflits} en conflit — voir le résumé du run.`);
  }
})().catch((error) => {
  console.log(`::warning title=Suivi du dépôt::Erreur inattendue : ${error.message}`);
  process.exit(0);
});
