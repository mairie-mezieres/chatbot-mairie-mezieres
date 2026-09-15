#!/usr/bin/env node
/**
 * Contrôle : une entrée `workflow_dispatch` comparée à `false` (ou à `true`)
 * dans un workflow à déclencheurs multiples.
 *
 * ⛔ Dans une expression GitHub Actions, `null == false` est **VRAI** : les deux
 * opérandes sont castés en nombre avant comparaison (null → 0, false → 0). Or
 * `inputs.*` n'existe QUE sur `workflow_dispatch` ; sur `workflow_run`, `schedule`
 * ou `push`, la valeur est `null`.
 *
 * Écrit `${{ inputs.mineures == false && '0' || '1' }}`, le champ
 * `AUTOMERGE_MINEURES` de `dependabot-auto-merge.yml` valait donc `'0'` à CHAQUE
 * exécution automatique — les mises à jour mineures étaient désactivées dans le
 * seul mode qui compte, alors que le lancement manuel, lui, prenait le bon chemin.
 * Un défaut qu'un essai à blanc ne peut pas voir : il rend le workflow plus
 * restrictif en production qu'à l'essai.
 * Voir `app-mezieres/docs/adr/0045-…` §8. ⚠️ Jumeau dans `app-mezieres` : garder
 * les deux copies identiques (à cette ligne près).
 *
 * ⚠️ Ce contrôle ne vise QUE la comparaison explicite. `${{ inputs.dry_run && '1'
 * || '0' }}` est sain : `null` y est simplement *falsy*, donc l'entrée absente se
 * comporte comme « non cochée », ce qu'on veut.
 *
 * Remède : garder la comparaison derrière son événement —
 *   ${{ (github.event_name == 'workflow_dispatch' && inputs.x == false) && … }}
 */
const fs = require('fs');
const path = require('path');

const DOSSIER = path.join(__dirname, '..', '.github', 'workflows');

// `inputs.x == false`, `inputs.x != true`, et la forme longue `github.event.inputs.x`.
const COMPARAISON = /(?:github\.event\.)?inputs\.[A-Za-z0-9_-]+\s*[!=]=\s*(?:false|true)\b/g;
const GARDE = /github\.event_name\s*==\s*'workflow_dispatch'/;
// Un workflow qui n'a QUE `workflow_dispatch` ne peut pas recevoir d'`inputs` nuls.
const AUTRE_DECLENCHEUR = /^\s{0,4}(?:push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch|issues|issue_comment|release)\s*:/m;

let fichiers = [];
try {
  fichiers = fs.readdirSync(DOSSIER).filter((f) => /\.ya?ml$/.test(f));
} catch {
  console.log('Aucun dossier .github/workflows — contrôle sans objet.');
  process.exit(0);
}

const defauts = [];

for (const nom of fichiers) {
  const chemin = path.join(DOSSIER, nom);
  const contenu = fs.readFileSync(chemin, 'utf8');

  // Le piège n'existe que si l'workflow peut se déclencher autrement qu'à la main.
  const entete = contenu.split(/^jobs\s*:/m)[0];
  if (!AUTRE_DECLENCHEUR.test(entete)) continue;

  contenu.split('\n').forEach((ligne, i) => {
    if (ligne.trimStart().startsWith('#')) return;
    const trouvees = ligne.match(COMPARAISON);
    if (!trouvees) return;
    if (GARDE.test(ligne)) return;
    defauts.push({ fichier: nom, ligne: i + 1, extrait: ligne.trim(), expr: trouvees[0] });
  });
}

if (defauts.length === 0) {
  console.log(`✅ ${fichiers.length} workflow(s) : aucune entrée comparée à false/true sans garde d'événement.`);
  process.exit(0);
}

console.error('\n⛔ Entrée `workflow_dispatch` comparée à false/true sans garde d’événement\n');
console.error('   Dans une expression Actions, `null == false` est VRAI (les deux');
console.error('   opérandes sont castés en nombre). Hors `workflow_dispatch`, `inputs.*`');
console.error('   vaut null : la condition se déclenche donc toute seule, et seulement');
console.error('   en exécution automatique — invisible à l’essai. Voir ADR-0045 §8.\n');

for (const d of defauts) {
  console.error(`   ${d.fichier}:${d.ligne}`);
  console.error(`     ${d.extrait}`);
}

console.error('\n   Remède : garder la comparaison derrière son événement —');
console.error("     ${{ (github.event_name == 'workflow_dispatch' && inputs.x == false) && … }}");
console.error('   ou, si l’entrée absente doit valoir « non cochée », s’appuyer sur le');
console.error("   falsy : ${{ inputs.x && '1' || '0' }}\n");

process.exit(1);
