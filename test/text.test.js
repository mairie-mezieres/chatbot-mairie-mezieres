/*
 * Tests golden-master pour lib/text.js
 *
 * Les sorties attendues ont été capturées sur l'implémentation d'origine
 * (telle qu'elle vivait dans index.js avant extraction). Tout écart révèle
 * une régression — particulièrement sur les caractères spéciaux (accents,
 * ligatures, emojis).
 *
 * Lancer : npm test
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cleanMarkdown } = require("../lib/text");

// [entrée, sortie attendue] — figées depuis le code d'origine.
const GOLDEN = [
  ["**Gras** et *italique*", "Gras et italique"],
  ["## Titre accentué éàùç", "Titre accentué éàùç"],
  ["Liste:\n- un\n- deux\n• trois", "Liste:\n• un\n• deux\n• trois"],
  ["`code` et ```bloc```", "code et bloc"],
  ["Mézières-lez-Cléry 🚨 signalé à 250m", "Mézières-lez-Cléry 🚨 signalé à 250m"],
  ["", ""],
  [null, null],
  [undefined, undefined],
  ["Texte\n\n\n\navec sauts", "Texte\n\navec sauts"],
  ["Œuf, cœur, naïve, façade — tirets cadratins", "Œuf, cœur, naïve, façade — tirets cadratins"],
  ["Emoji ✅⚠️🟡🔵🟢 conservés", "Emoji ✅⚠️🟡🔵🟢 conservés"],
  ["Mix **gras éà** et `cœur` 🌦️", "Mix gras éà et cœur 🌦️"],
];

test("cleanMarkdown — golden master (caractères spéciaux inclus)", () => {
  for (const [input, expected] of GOLDEN) {
    assert.deepEqual(
      cleanMarkdown(input),
      expected,
      `cleanMarkdown(${JSON.stringify(input)}) doit valoir ${JSON.stringify(expected)}`
    );
  }
});

test("cleanMarkdown — valeurs falsy renvoyées telles quelles", () => {
  assert.equal(cleanMarkdown(null), null);
  assert.equal(cleanMarkdown(undefined), undefined);
  assert.equal(cleanMarkdown(""), "");
  assert.equal(cleanMarkdown(0), 0);
});
