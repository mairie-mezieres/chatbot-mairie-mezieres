/*
 * Fréquentation du mail quotidien : séparer les lancements de l'app des écrans.
 *
 * Contexte (mail du 6 septembre 2026) : 182 visiteurs uniques, +98 % vs hier…
 * et un top des services plafonnant à 36. Rien dans le mail ne l'expliquait,
 * parce que `app_open` — émis une fois par appareil et par jour, donc l'événement
 * le plus nombreux de la journée — n'apparaissait NULLE PART : exclu du tableau
 * des services, et fondu dans un total baptisé « Accès app » qui n'en comptait
 * donc rien de plus. Vérification par l'arithmétique du mail réel :
 *   257 (services affichés) + 11 (MEL) + 4 (installations) = 272 = « Accès app ».
 * Il ne restait 0 pour les lancements, alors que 182 appareils avaient tapé le
 * backend le même jour — le comptage `app_open` était coupé dans les réglages,
 * et les visiteurs uniques, eux, sont enregistrés dans tous les cas.
 *
 * Ces contrôles verrouillent la décomposition. Lancer :
 *   node test/stats-frequentation.test.js  (ou npm test)
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { splitDayStats, NON_SERVICE_KEYS } = require("../lib/stats");

// La journée du 6 septembre 2026, telle qu'elle est arrivée dans le mail.
const JOUR_REEL = {
  app_resume: 79, actualites: 36, agenda: 29, jeu: 24, idees: 14,
  saviez_vous: 9, meteo: 7, carburant: 6, remi: 5, carte3d: 5,
  events_locaux: 5, contact: 5, dechets: 5, nums: 4, sondages: 4,
  signalement: 4, partager_visite: 4, plui: 4, saviez_vous_reponse: 3,
  docs: 2, 'guide-arrivee': 2, partager_prompt: 1,
  mel: 11, installation: 4
};

test("les lancements de l'app sont comptés à part, jamais fondus dans un total", () => {
  const d = splitDayStats({ ...JOUR_REEL, app_open: 182 });
  assert.equal(d.opens, 182);
  // Le total « écrans ouverts » ne doit pas les absorber : c'est ce mélange qui
  // rendait le mail illisible. 178 services + 11 MEL, ni les 182 lancements,
  // ni les 79 retours, ni les 4 installations.
  assert.equal(d.screens, 189);
});

test("« écrans ouverts » = MEL + services, sans lancement, retour ni installation", () => {
  const d = splitDayStats({ ...JOUR_REEL, app_open: 182 });
  const services = d.services.reduce((a, [, v]) => a + v, 0);
  assert.equal(d.screens, services + d.mel);
  assert.equal(d.opens, 182);
  assert.equal(d.resumes, 79);
  assert.equal(d.installations, 4);
});

test("le classement des services ne contient aucun des quatre non-services", () => {
  const d = splitDayStats({ ...JOUR_REEL, app_open: 182 });
  const cles = d.services.map(([k]) => k);
  for (const k of NON_SERVICE_KEYS) {
    assert.ok(!cles.includes(k), `${k} n'est pas un service et ne doit pas être classé`);
  }
  // Le vrai n° 1 n'est plus « retours en avant-plan » (79) mais « actualites » (36).
  assert.deepEqual(d.services[0], ['actualites', 36]);
});

test("un comptage app_open coupé donne 0, jamais un total silencieusement gonflé", () => {
  const d = splitDayStats(JOUR_REEL); // pas de clé app_open : réglage désactivé
  assert.equal(d.opens, 0);
  // Et les écrans restent identiques : le zéro ne se déverse nulle part.
  assert.equal(d.screens, splitDayStats({ ...JOUR_REEL, app_open: 182 }).screens);
});

test("une journée vide ou absente ne casse rien", () => {
  for (const vide of [undefined, null, {}]) {
    const d = splitDayStats(vide);
    assert.deepEqual(
      { opens: d.opens, resumes: d.resumes, mel: d.mel, installations: d.installations, screens: d.screens, n: d.services.length },
      { opens: 0, resumes: 0, mel: 0, installations: 0, screens: 0, n: 0 }
    );
  }
});
