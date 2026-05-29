/*
 * Smoke test de démarrage — vérifie que le serveur boote sans planter.
 *
 * Sans suite de tests d'intégration, c'est le filet de sécurité minimal :
 * il lance index.js avec des variables d'environnement factices, attend la
 * ligne de démarrage, puis tue le process. Tout crash au chargement des
 * modules (require cassé, erreur de syntaxe, throw à l'init) fait échouer
 * ce script.
 *
 * Lancer : npm run smoke
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const READY_MARKER = "démarré sur le port";
const TIMEOUT_MS = 15000;

const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], {
  env: {
    ...process.env,
    PORT: "0",            // port éphémère attribué par l'OS — aucun conflit
    ADMIN_PASSWORD: "smoke-test",
    MAT_DEBUG: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
let settled = false;

function finish(code, message) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { child.kill("SIGKILL"); } catch { /* déjà mort */ }
  if (code === 0) {
    console.log("✅ Smoke test OK — le serveur démarre correctement.");
  } else {
    console.error("❌ Smoke test ÉCHOUÉ — " + message);
    console.error("─── Sortie du serveur ───\n" + output.trim());
  }
  process.exit(code);
}

const timer = setTimeout(
  () => finish(1, `marqueur "${READY_MARKER}" non vu après ${TIMEOUT_MS} ms`),
  TIMEOUT_MS
);

function onData(buf) {
  output += buf.toString();
  if (output.includes(READY_MARKER)) finish(0);
}

child.stdout.on("data", onData);
child.stderr.on("data", onData);
child.on("error", (err) => finish(1, "impossible de lancer le process : " + err.message));
child.on("exit", (code) => {
  if (!settled) finish(1, `le process s'est arrêté prématurément (code ${code})`);
});
