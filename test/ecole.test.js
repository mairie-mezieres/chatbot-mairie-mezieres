/*
 * Verrouille les DIRECT_RULES de l'école de la Forêt et des services
 * périscolaires, tirées du règlement intérieur scolaire et périscolaire
 * 2026-2027 remis par la mairie en septembre 2026.
 *
 * Trois propriétés sont vérifiées ici, chacune pour une raison vécue :
 *
 *  1. AUCUNE IDENTITÉ DE PERSONNE, pas même en commentaire — écrire les noms
 *     à proscrire serait encore les stocker. L'arbre de décision nommait la
 *     directrice de l'école et la directrice du périscolaire : des personnes
 *     qui changent d'une rentrée à l'autre, et qu'aucun test ne surveillait.
 *     Un nom faux est pire qu'une fonction juste — on dit « la direction de
 *     l'école », « le service enfance ».
 *
 *  2. AUCUN MONTANT. Les tarifs du périscolaire et du restaurant scolaire sont
 *     fixés chaque année par délibération du conseil municipal, sur le quotient
 *     familial CAF. `app-mezieres/js/mat-mel.js` a affiché « Tarifs 2022/2023 :
 *     3,80 € » jusqu'en septembre 2026 : quatre ans de retard, invisibles.
 *     Même leçon que la salle communale (ADR-0013) et la crèche.
 *
 *  3. LES HORAIRES SONT CEUX DU RÈGLEMENT, et les dates de vacances portent
 *     leur année scolaire. Un calendrier sans millésime se lit comme celui de
 *     l'année en cours (cf. `app-mezieres/docs/adr/0033-…`).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findDirectAnswer, detectTopics, DIRECT_RULES } = require("../lib/mel");
const { normalizeQuestion } = require("../lib/text");

const ask = q => findDirectAnswer(normalizeQuestion(q), []);

/* Les règles introduites (ou remaniées) par le règlement 2026-2027. */
const REGLES_ECOLE = [
  "ecole_horaires_contact",
  "ecole_absence_sante",
  "ecole_regles_vie",
  "periscolaire_services",
  "vacances_scolaires",
  "cantine"
];

const nomRegle = n => DIRECT_RULES.find(r => r.name === n);

test("les six règles scolaires existent", () => {
  for (const n of REGLES_ECOLE) {
    assert.ok(nomRegle(n), `règle « ${n} » absente du tableau DIRECT_RULES`);
  }
});

/* ── 1. Aucun nom de personnel ─────────────────────────────── */

/* ⚠️ Le détecteur ne contient AUCUN patronyme : écrire la liste des noms à
   proscrire serait encore les stocker. On cherche la FORME d'une identité —
   une civilité, ou un intitulé de poste suivi d'un mot capitalisé qui ne soit
   ni un lieu ni une institution. Le pendant existe côté app dans
   `app-mezieres/tests/e2e/ecole-periscolaire.spec.js`. */
const CIVILITE = /\b(?:Mme|Mlle|Mr|M\.)\s*[A-ZÉÈÀÂÎÔÛ]/;
const POSTES = /\b(?:directeur|directrice|enseignante?|animat(?:eur|rice)|atsem|cuisini(?:er|ère)|président[e]?|inspect(?:eur|rice))s?\b/gi;
const PROPRES_ADMIS = new Set(['Mézières', 'Cléry', 'Saint', 'André', 'Meung',
  'Loire', 'Val', 'Ardoux', 'Beaugency', 'Beauce', 'Romaine', 'Mareau', 'Prés',
  'Muids', 'Bourg', 'Forêt', 'Marmousets', 'Accueil', 'Communauté', 'Communes',
  'Terres', 'Éducation', 'École', 'Nationale', 'Trésor', 'Public', 'Maréchal',
  'Foch', 'Barre', 'CCTVL', 'DASEN', 'SIVU', 'LAEP', 'CAF', 'CNAF', 'PAI', 'APC']);

function identitesApparentes(texte) {
  const trouves = [];
  POSTES.lastIndex = 0;
  let m;
  while ((m = POSTES.exec(texte)) !== null) {
    const debut = m.index + m[0].length;
    // La fenêtre est complétée jusqu'à la fin du mot qu'elle coupe, puis
    // arrêtée à la fin de phrase : sans quoi « Mézières » se réduit à « M »,
    // et « … le président. Une commune … » passe pour une identité.
    const suite = (texte.slice(debut, debut + 40)
      + (texte.slice(debut + 40).match(/^[A-Za-zÀ-ÿ'’-]*/) || [''])[0])
      .split(/[.!?;:\n]/)[0];
    for (const mot of suite.match(/[A-ZÉÈÀÂÎÔÛÇ][A-Za-zÀ-ÿ'’-]*/g) || []) {
      if (!PROPRES_ADMIS.has(mot)) trouves.push(`${m[0]} … ${mot}`);
    }
  }
  return trouves;
}

test("aucune identité de personne n'est citée dans les réponses", () => {
  for (const regle of DIRECT_RULES) {
    assert.doesNotMatch(regle.answer, CIVILITE,
      `la règle « ${regle.name} » nomme une personne (civilité + nom)`);
    assert.deepEqual(identitesApparentes(regle.answer), [],
      `la règle « ${regle.name} » nomme une personne après un intitulé de poste`);
  }
});

test("le détecteur d'identité ne verdit pas à tort", () => {
  // Un contrôle qui ne mesure rien ne rougit pas : il verdit. On lui soumet
  // les deux formes qui vivaient réellement dans l'arbre de décision.
  assert.match('joindre la directrice Mme Untel', CIVILITE);
  assert.notDeepEqual(identitesApparentes('la directrice du périscolaire Prenom'), []);
  assert.notDeepEqual(identitesApparentes('enseignante des PS/MS Prenom Nom'), []);
  // Et les formulations légitimes passent.
  assert.deepEqual(identitesApparentes("adressez-vous à la direction de l'école"), []);
  assert.deepEqual(identitesApparentes('la directrice du service périscolaire'), []);
  assert.deepEqual(
    identitesApparentes("l'inspectrice de l'Éducation nationale de la circonscription"), []);
});

test("les réponses désignent les personnes par leur fonction", () => {
  assert.match(ask("qui contacter à l'école de la Forêt ?"), /direction de l ecole|direction de l'école/i);
});

/* ── 2. Aucun montant ──────────────────────────────────────── */

test("ni le périscolaire ni la cantine n'annoncent de montant", () => {
  for (const n of ["periscolaire_services", "cantine", "ecole_absence_sante"]) {
    const a = nomRegle(n).answer;
    assert.doesNotMatch(a, /\d+[.,]\d{1,2}\s*€/, `la règle « ${n} » annonce un tarif`);
    assert.doesNotMatch(a, /\d+\s*€/, `la règle « ${n} » annonce un montant`);
    assert.doesNotMatch(a, /euros?/i, `la règle « ${n} » annonce un montant en euros`);
  }
});

test("les tarifs anciens de l'arbre de décision ne réapparaissent pas", () => {
  const tout = DIRECT_RULES.map(r => r.answer).join("\n");
  assert.doesNotMatch(tout, /3[.,]80/);
  assert.doesNotMatch(tout, /2022\s*\/\s*2023/);
});

test("le principe de tarification est dit, à défaut du montant", () => {
  for (const n of ["periscolaire_services", "cantine"]) {
    assert.match(nomRegle(n).answer, /quotient familial CAF/);
    assert.match(nomRegle(n).answer, /deliberation|délibération/);
  }
});

/* ── 3. Horaires et dates ──────────────────────────────────── */

test("les horaires de classe du règlement sont énoncés", () => {
  const a = ask("quels sont les horaires de l'école ?");
  assert.ok(a, "aucune règle directe pour les horaires de l'école");
  assert.match(a, /8h30 a 11h45|8h30 à 11h45/);
  assert.match(a, /13h45 a 16h30|13h45 à 16h30/);
  assert.match(a, /lundi, mardi, jeudi et vendredi/);
  // Le portail ferme à l'heure de la classe, l'accueil commence 10 min avant.
  assert.match(a, /8h20/);
  assert.match(a, /13h35/);
});

test("l'ancien horaire d'ouverture de 13h30 n'est plus annoncé", () => {
  // L'arbre de décision disait « ouvre à 8h20 et 13h30 » : l'après-midi
  // commence à 13h45, l'accueil à 13h35.
  const a = ask("à quelle heure ouvre l'école ?");
  assert.doesNotMatch(a, /13h30/);
});

test("les horaires du périscolaire et de la cantine sont ceux du règlement", () => {
  const p = ask("horaires du périscolaire");
  assert.match(p, /7h30 a 8h20|7h30 à 8h20/);
  assert.match(p, /16h30 a 18h30|16h30 à 18h30/);
  assert.match(p, /7h30 a 18h00|7h30 à 18h00/);   // mercredi
  const c = ask("horaires de la cantine");
  assert.match(c, /11h45 a 13h30|11h45 à 13h30/);
});

test("les dates de vacances portent leur année scolaire", () => {
  const a = ask("quelles sont les dates des vacances scolaires ?");
  assert.ok(a, "aucune règle directe pour les vacances scolaires");
  assert.match(a, /2026-2027/);
  assert.match(a, /17 octobre au lundi 2 novembre 2026/);
  assert.match(a, /3 juillet 2027/);
  // Chaque date citée porte son année : pas de « du 17 avril au 3 mai » nu.
  assert.match(a, /annee scolaire 2026-2027 uniquement|année scolaire 2026-2027 uniquement/);
});

/* ── Aiguillage : la bonne règle prend la main ──────────────── */

test("les questions du quotidien trouvent la règle attendue", () => {
  const cas = [
    ["à quelle heure commence l'école ?",                    /36 rue du Bourg/],
    ["mon enfant est malade, comment prévenir l'école ?",     /02 38 45 65 00/],
    ["faut-il un certificat médical pour une absence ?",      /certificat medical|certificat médical/],
    ["est-ce que le téléphone portable est autorisé à l'école ?", /confisque|confisqué/],
    ["quels sont les horaires de la garderie ?",              /7h30/],
    ["comment inscrire mon enfant à la cantine ?",            /portail parents|parents\.logiciel-enfance\.fr/],
    ["que se passe-t-il si j'arrive en retard au périscolaire ?", /18h30/],
    ["l'accueil du mercredi est-il ouvert ?",                 /mercredi/],
    ["quand sont les vacances de la Toussaint ?",             /17 octobre/],
    ["l'école de la Forêt a-t-elle une adresse mail ?",       /ac-orleans-tours\.fr/]
  ];
  for (const [q, attendu] of cas) {
    const a = ask(q);
    assert.ok(a, `aucune règle directe pour « ${q} »`);
    assert.match(a, attendu, `réponse inattendue pour « ${q} » : ${a.slice(0, 120)}`);
  }
});

test("une question sur un médecin ne part pas sur l'absence scolaire", () => {
  // Le garde-fou de `ecole_absence_sante` : `maison_sante` est plus bas dans
  // le tableau et ne reprendrait jamais la main.
  const a = ask("mon enfant est malade, quel médecin consulter ?");
  assert.match(a, /maison de sante|maison de santé/i);
});

test("« certificat de radiation » ne part plus sur l'état civil", () => {
  // `demarches_etatcivil` attrapait `certificat` nu, donc « certificat de
  // radiation » et « certificat médical » recevaient une réponse sur les
  // actes de naissance.
  const a = ask("il me faut un certificat de radiation pour changer d'école");
  assert.match(a, /certificat de radiation/);
  assert.doesNotMatch(a, /acte de naissance/i);
});

test("un extrait d'acte reste une question d'état civil", () => {
  const a = ask("comment obtenir un extrait d'acte de naissance ?");
  assert.match(a, /etat civil|état civil/i);
});

/* ── Propriétés transverses ────────────────────────────────── */

test("les liens des règles scolaires sont cliquables et non collés", () => {
  // `_renderDirectAnswer` (app) ne rend cliquable que https?:// et www., et
  // son motif d'URL est [^\s<>] : toute ponctuation collée est avalée dans le
  // href. Voir le CLAUDE.md du dépôt.
  for (const n of REGLES_ECOLE) {
    const a = nomRegle(n).answer;
    for (const m of a.matchAll(/https?:\/\/\S+/g)) {
      assert.doesNotMatch(m[0], /[.,;:)\]]$/,
        `la règle « ${n} » colle une ponctuation à l'URL ${m[0]}`);
    }
    // Un domaine nu s'affiche mais ne s'ouvre pas.
    assert.doesNotMatch(a, /(?<!\/\/)(?<!\w)parents\.logiciel-enfance\.fr/,
      `la règle « ${n} » cite le portail parents sans schéma https`);
  }
});

test("le portail parents est cité en https complet", () => {
  assert.match(nomRegle("periscolaire_services").answer,
    /https:\/\/parents\.logiciel-enfance\.fr\/mezieres-lez-clery/);
});

test("le topic scolaire est détecté sur les nouvelles formulations", () => {
  for (const q of ["école de la forêt", "portail parents", "vacances scolaires",
                   "l'accueil enchanté", "le goûter du périscolaire"]) {
    assert.ok(detectTopics(q).includes("scolaire"),
      `topic « scolaire » non détecté sur « ${q} »`);
  }
});

test("les règles scolaires précèdent cantine et centre_loisirs", () => {
  const i = n => DIRECT_RULES.findIndex(r => r.name === n);
  assert.ok(i("periscolaire_services") < i("centre_loisirs"),
    "periscolaire_services doit précéder centre_loisirs, dont le motif attrape « periscolaire »");
  assert.ok(i("periscolaire_services") < i("cantine"),
    "periscolaire_services doit précéder cantine");
  assert.ok(i("ecole_absence_sante") < i("ecole_horaires_contact"),
    "une question d'absence ne doit pas être avalée par la règle générale école");
  assert.ok(i("inscription_scolaire") < i("ecole_horaires_contact"),
    "une question d'inscription garde la main sur la règle générale école");
});

test("aucune règle scolaire ne prête un arrêté municipal à la commune", () => {
  for (const n of REGLES_ECOLE) {
    assert.doesNotMatch(nomRegle(n).answer, /arrete municipal|arrêté municipal/i);
  }
});
