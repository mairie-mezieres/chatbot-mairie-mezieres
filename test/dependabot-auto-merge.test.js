'use strict';
/*
 * Fusion automatique Dependabot — règle de portée, PR simples ET groupes.
 * Cas tirés des vraies PR : #256 (groupe backend), #258 (googleapis, majeure),
 * #260 (@anthropic-ai/sdk, mineure en 0.x) et app-mezieres#496 (groupe tests-e2e).
 * ⚠️ Jumeau : app-mezieres/scripts/check-dependabot-auto-merge.js (mêmes cas).
 */
const test = require('node:test');
const assert = require('node:assert');
const { eligibilite, versionsDeLaPR } = require('../scripts/dependabot-auto-merge.js');

const BOT = { login: 'dependabot[bot]' };
const LOCK = ['package.json', 'package-lock.json'];
const pr = (title, body = '') => ({ user: BOT, draft: false, title, body });

const GROUPE_256 = pr('chore(deps): bump the backend group across 1 directory with 3 updates', [
  'Bumps the backend group with 3 updates in the / directory: ...',
  '',
  'Updates `@sentry/node` from 11.4.0 to 11.8.0',
  '<details>…</details>',
  'Updates `express` from 5.2.1 to 5.3.0',
  'Updates `express-rate-limit` from 8.7.0 to 8.7.1',
].join('\n'));

test('groupe sans majeure ni 0.x → éligible, chaque paquet nommé', () => {
  const v = eligibilite(GROUPE_256, LOCK);
  assert.strictEqual(v.ok, true, v.motif);
  assert.match(v.motif, /express mineure 5\.2\.1 → 5\.3\.0/);
  assert.match(v.motif, /express-rate-limit patch/);
});

test('groupe : une mineure en 0.x suffit à tout refuser', () => {
  const g = pr('build(deps-dev): bump the tests-e2e group in /tests/e2e with 2 updates',
    'Updates `@axe-core/playwright` from 0.13.0 to 0.14.0\nUpdates `@playwright/test` from 1.64.0 to 1.64.1');
  const v = eligibilite(g, LOCK);
  assert.strictEqual(v.ok, false);
  assert.match(v.motif, /@axe-core\/playwright mineure en 0\.x/);
});

test('groupe : une majeure suffit à tout refuser', () => {
  const g = pr('bump the backend group with 2 updates',
    'Updates `a` from 1.0.0 to 1.0.1\nUpdates `b` from 2.3.0 to 3.0.0');
  assert.match(eligibilite(g, LOCK).motif, /b majeure/);
});

test('groupe : corps tronqué (moins de paquets lus qu’annoncés) → refusé', () => {
  const g = pr('bump the backend group with 3 updates',
    'Updates `a` from 1.0.0 to 1.0.1\nUpdates `b` from 2.3.0 to 2.3.1');
  const v = eligibilite(g, LOCK);
  assert.strictEqual(v.ok, false);
  assert.match(v.motif, /2 paquet\(s\) lu\(s\) sur 3/);
});

test('groupe : une ligne citée dans les notes de version ne compte pas', () => {
  // Seules les lignes qui COMMENCENT par « Updates `…` » sont lues.
  const g = pr('bump the backend group with 1 update',
    'Updates `a` from 1.0.0 to 1.0.1\n<li>chore: Updates `b` from 1.0.0 to 9.0.0</li>');
  assert.strictEqual(versionsDeLaPR(g).liste.length, 1);
  assert.strictEqual(eligibilite(g, LOCK).ok, true);
});

test('PR simple : majeure (#258) et mineure en 0.x (#260) restent refusées', () => {
  assert.match(eligibilite(pr('chore(deps): bump googleapis from 182.0.0 to 185.0.0'), LOCK).motif, /majeure/);
  assert.match(eligibilite(pr('chore(deps): bump @anthropic-ai/sdk from 0.131.0 to 0.135.0'), LOCK).motif, /mineure en 0\.x/);
  assert.strictEqual(eligibilite(pr('bump x from 1.2.3 to 1.2.4'), LOCK).ok, true);
});

test('barrières inchangées : auteur, fichiers, titre illisible', () => {
  assert.strictEqual(eligibilite({ ...GROUPE_256, user: { login: 'quelqu-un' } }, LOCK).ok, false);
  assert.match(eligibilite(GROUPE_256, [...LOCK, 'app.js']).motif, /touche app\.js/);
  assert.match(eligibilite(pr('bump things'), LOCK).motif, /versions illisibles/);
});
