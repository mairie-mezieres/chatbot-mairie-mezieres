/*
 * Verrouille le socle de sécurité Node.js (lib/node-baseline.js) : comparaison
 * de versions, détection d'une ligne non maintenue, et propagation de l'avis de
 * sécurité en attente.
 *
 * Les cas utilisent des versions explicites plutôt que le runtime courant :
 * les assertions restent vraies quand MIN_SAFE_BY_LINE est relevé après une
 * publication de sécurité.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_SAFE_BY_LINE,
  SUPPORTED_LINES,
  PENDING_ADVISORY,
  parseVersion,
  compareVersions,
  checkNodeVersion,
} = require("../lib/node-baseline");

test("parseVersion tolère le préfixe v et les pré-versions", () => {
  assert.deepEqual(parseVersion("v22.23.1"), [22, 23, 1]);
  assert.deepEqual(parseVersion("24.18.0"), [24, 18, 0]);
  assert.deepEqual(parseVersion("v26.5.0-rc.1"), [26, 5, 0]);
  assert.equal(parseVersion("pas-une-version"), null);
  assert.equal(parseVersion(undefined), null);
});

test("compareVersions ordonne correctement, y compris sur le patch", () => {
  assert.ok(compareVersions("22.23.1", "22.23.0") > 0);
  assert.ok(compareVersions("22.23.0", "22.23.1") < 0);
  assert.equal(compareVersions("24.18.0", "v24.18.0"), 0);
  // Le tri doit être numérique, pas lexicographique (22.9 < 22.23).
  assert.ok(compareVersions("22.9.0", "22.23.0") < 0);
  assert.equal(compareVersions("22.23.0", "n/a"), null);
});

test("une version antérieure au socle est signalée en danger", () => {
  for (const [line, minSafe] of Object.entries(MIN_SAFE_BY_LINE)) {
    const [maj, min, patch] = parseVersion(minSafe);
    // Construit une version strictement inférieure au socle de la ligne.
    const older = patch > 0
      ? `${maj}.${min}.${patch - 1}`
      : `${maj}.${Math.max(0, min - 1)}.0`;
    if (compareVersions(older, minSafe) >= 0) continue; // socle en x.0.0
    const verdict = checkNodeVersion(`v${older}`);
    assert.equal(verdict.status, "danger", `ligne ${line} : ${older} < ${minSafe}`);
    assert.match(verdict.message, /socle de sécurité/);
    assert.equal(verdict.details.min_safe, minSafe);
  }
});

test("une ligne non maintenue est signalée en danger", () => {
  const verdict = checkNodeVersion("v18.20.4");
  assert.equal(verdict.status, "danger");
  assert.match(verdict.message, /plus maintenue/);
  assert.equal(verdict.details.line, 18);
});

test("une version illisible ne fait pas planter le diagnostic", () => {
  const verdict = checkNodeVersion("inconnue");
  assert.equal(verdict.status, "warn");
  assert.match(verdict.message, /illisible/);
});

test("le socle couvre exactement les lignes déclarées supportées", () => {
  assert.deepEqual(
    Object.keys(MIN_SAFE_BY_LINE).map(Number).sort((a, b) => a - b),
    [...SUPPORTED_LINES].sort((a, b) => a - b)
  );
});

test("un avis de sécurité en attente maintient un avertissement sur les lignes visées", () => {
  if (!PENDING_ADVISORY) {
    // Avis résorbé : une version conforme au socle doit repasser au vert.
    const line = SUPPORTED_LINES[0];
    const verdict = checkNodeVersion(`v${MIN_SAFE_BY_LINE[line]}`);
    assert.equal(verdict.status, "ok");
    return;
  }
  for (const line of PENDING_ADVISORY.lines) {
    const verdict = checkNodeVersion(`v${MIN_SAFE_BY_LINE[line]}`);
    assert.equal(verdict.status, "warn", `ligne ${line} visée par l'avis en attente`);
    assert.match(verdict.message, /publication de sécurité/);
    assert.equal(verdict.details.pending_advisory.severity, PENDING_ADVISORY.severity);
  }
});

test("le runtime courant est évalué sans lever d'exception", () => {
  const verdict = checkNodeVersion();
  assert.ok(["ok", "warn", "danger"].includes(verdict.status));
  assert.equal(verdict.details.current, process.version);
});
