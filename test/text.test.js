/*
 * Tests golden-master pour lib/text.js
 *
 * Les sorties attendues ont été capturées sur l'implémentation d'origine
 * (telle qu'elle vivait dans index.js avant extraction), directement à partir
 * des octets réels des fonctions — voir test/golden/text-golden.json.
 * Tout écart révèle une régression, particulièrement sur les caractères
 * spéciaux (accents, ligatures, emojis, entités HTML, espaces).
 *
 * Lancer : npm test
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const text = require("../lib/text");
const golden = require("./golden/text-golden.json");

// cleanMarkdown — golden inline (figé depuis le code d'origine).
const CLEAN_MD = [
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
  for (const [input, expected] of CLEAN_MD) {
    assert.deepEqual(
      text.cleanMarkdown(input),
      expected,
      `cleanMarkdown(${JSON.stringify(input)}) doit valoir ${JSON.stringify(expected)}`
    );
  }
});

test("cleanMarkdown — valeurs falsy renvoyées telles quelles", () => {
  assert.equal(text.cleanMarkdown(null), null);
  assert.equal(text.cleanMarkdown(undefined), undefined);
  assert.equal(text.cleanMarkdown(""), "");
  assert.equal(text.cleanMarkdown(0), 0);
});

// cleanHtml / normalizeQuestion / hashKey — golden chargé depuis le JSON
// généré sur les octets réels des fonctions d'origine.
for (const fnName of Object.keys(golden)) {
  test(`${fnName} — golden master (depuis test/golden/text-golden.json)`, () => {
    for (const [input, expected] of golden[fnName]) {
      assert.deepEqual(
        text[fnName](input),
        expected,
        `${fnName}(${JSON.stringify(input)}) doit valoir ${JSON.stringify(expected)}`
      );
    }
  });
}
