/*
 * Persistance des statistiques : socle (historique) + tranche du jour.
 *
 * Contexte : `mat:stats` était UN SEUL JSON réécrit intégralement toutes les
 * 5 minutes, soit 288 fois par jour — quelques centaines de Mo quotidiens pour
 * une commune de 1 500 habitants, alors que seule la journée en cours change.
 * Et sa lecture au démarrage ne distinguait pas « clé vide » de « Redis
 * injoignable » : un timeout au boot repartait d'un objet vide, que le flush
 * suivant publiait par-dessus l'historique cinq minutes plus tard.
 *
 * Ces contrôles verrouillent les deux propriétés. Lancer :
 *   node test/stats-persistance.test.js  (ou npm test)
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

// ── Redis simulé, injecté AVANT le chargement de lib/stats-store ────────────
// (chaque fichier de test s'exécute dans son propre processus — voir CLAUDE.md)
const cheminRedis = require.resolve("../lib/redis.js");
const faux = {
  base: new Map(),
  lectureKo: false,
  ecritureKo: false,
  ecritures: [],
  reset() { this.base.clear(); this.lectureKo = false; this.ecritureKo = false; this.ecritures = []; }
};
require.cache[cheminRedis] = {
  id: cheminRedis, filename: cheminRedis, loaded: true, exports: {
    async redisGetResult(k) {
      if (faux.lectureKo) return { ok: false, value: null };
      return { ok: true, value: faux.base.has(k) ? JSON.parse(faux.base.get(k)) : null };
    },
    async redisGet(k) { return faux.base.has(k) ? JSON.parse(faux.base.get(k)) : null; },
    async redisSet(k, v) {
      if (faux.ecritureKo) return false;
      faux.base.set(k, JSON.stringify(v));
      faux.ecritures.push(k);
      return true;
    },
    async redisDel(k) { return faux.base.delete(k); }
  }
};

const S = require("../lib/stats-store.js");
const { SOCLE_KEY, COURANT_KEY, LEGACY_KEY, MAX_DEVICES, nbUniques } = S;

const JOUR = "2026-09-13";
const MOIS = "2026-09";

function statsExemple() {
  return {
    services: { actualites: 40, installation: 585 },
    totalAcces: 1200,
    parJour: { "2026-09-11": { meteo: 3 }, "2026-09-12": { meteo: 5 }, [JOUR]: { meteo: 7 } },
    uniqueUsers: {
      total: 3,
      byDay: { "2026-09-12": ["mat-a", "mat-b"], [JOUR]: ["mat-a", "mat-c"] },
      byMonth: { "2026-08": ["mat-a"], [MOIS]: ["mat-a", "mat-b", "mat-c"] },
      allDevices: ["mat-a", "mat-b", "mat-c"]
    },
    deviceStats: {
      byDay: { "2026-09-12": { types: { Mobile: 2 } }, [JOUR]: { types: { Mobile: 2 } } },
      byMonth: { [MOIS]: { types: { Mobile: 3 } } },
      daySeen: { "2026-09-12": { "mat-a": { model: "iPhone" } }, [JOUR]: { "mat-a": { model: "iPhone" } } },
      monthSeen: { [MOIS]: { "mat-a": { model: "iPhone" } } },
      appOpensByDay: { [JOUR]: 9 },
      appOpensByMonth: { [MOIS]: 120 }
    }
  };
}

// ── Normalisation : ce qui est gardé, ce qui est réduit ─────────────────────

test("une journée close est réduite à son COMPTE, celle en cours garde ses identifiants", () => {
  const s = S._normaliser(statsExemple(), JOUR, MOIS);
  assert.equal(s.uniqueUsers.byDay["2026-09-12"], 2, "jour clos → nombre");
  assert.deepEqual(s.uniqueUsers.byDay[JOUR], ["mat-a", "mat-c"], "jour en cours → liste");
  assert.equal(s.uniqueUsers.byMonth["2026-08"], 1, "mois clos → nombre");
  assert.ok(Array.isArray(s.uniqueUsers.byMonth[MOIS]), "mois en cours → liste");
});

test("nbUniques lit indifféremment une liste ou un compte", () => {
  assert.equal(nbUniques(["a", "b"]), 2);
  assert.equal(nbUniques(7), 7);
  assert.equal(nbUniques(undefined), 0);
  assert.equal(nbUniques(null), 0);
});

test("monthSeen est supprimé et daySeen ne garde que le jour en cours", () => {
  const s = S._normaliser(statsExemple(), JOUR, MOIS);
  assert.equal(s.deviceStats.monthSeen, undefined);
  assert.deepEqual(Object.keys(s.deviceStats.daySeen), [JOUR]);
});

test("le total d'appareils ne régresse jamais, même si la liste est plafonnée", () => {
  const s = statsExemple();
  s.uniqueUsers.total = 4200;              // total historique > liste conservée
  const n = S._normaliser(s, JOUR, MOIS);
  assert.equal(n.uniqueUsers.total, 4200);

  const trop = statsExemple();
  trop.uniqueUsers.allDevices = Array.from({ length: MAX_DEVICES + 50 }, (_, i) => "mat-" + i);
  trop.uniqueUsers.total = MAX_DEVICES + 50;
  const n2 = S._normaliser(trop, JOUR, MOIS);
  assert.equal(n2.uniqueUsers.allDevices.length, MAX_DEVICES, "liste plafonnée");
  assert.equal(n2.uniqueUsers.total, MAX_DEVICES + 50, "compteur intact");
});

test("les rétentions élaguent les périodes trop anciennes", () => {
  const s = statsExemple();
  for (let i = 0; i < S.KEEP_DAYS + 30; i++) {
    const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    s.parJour[d] = { meteo: 1 };
    s.uniqueUsers.byDay[d] = 1;
    s.deviceStats.byDay[d] = { types: { Mobile: 1 } };
  }
  const n = S._normaliser(s, JOUR, MOIS);
  assert.ok(Object.keys(n.parJour).length <= S.KEEP_DAYS);
  assert.ok(Object.keys(n.uniqueUsers.byDay).length <= S.KEEP_DAYS);
  assert.ok(Object.keys(n.deviceStats.byDay).length <= S.KEEP_DAYS_DEVICES);
});

// ── Découpage / recollement ─────────────────────────────────────────────────

test("socle + courant recollés redonnent exactement l'objet normalisé", () => {
  const attendu = S._normaliser(statsExemple(), JOUR, MOIS);
  const socle   = S._construireSocle(attendu, JOUR, MOIS);
  const courant = S._construireCourant(attendu, JOUR, MOIS);
  // Aller-retour JSON : c'est ce que Redis fait subir aux deux moitiés.
  const recolle = S._fusionner(JSON.parse(JSON.stringify(socle)), JSON.parse(JSON.stringify(courant)));
  assert.deepEqual(S._normaliser(recolle, JOUR, MOIS), attendu);
});

test("la tranche du jour ne contient QUE le jour et le mois en cours", () => {
  const s = S._normaliser(statsExemple(), JOUR, MOIS);
  const courant = S._construireCourant(s, JOUR, MOIS);
  assert.deepEqual(courant.parJour, { meteo: 7 });
  assert.deepEqual(courant.byDay, ["mat-a", "mat-c"]);
  assert.equal(JSON.stringify(courant).includes("2026-09-12"), false,
    "aucune trace d'un jour clos dans la charge utile réécrite 288 fois par jour");
});

test("le socle ne rebouge pas quand seuls les compteurs cumulés changent", () => {
  const s = S._normaliser(statsExemple(), JOUR, MOIS);
  const sig1 = S._signatureSocle(S._construireSocle(s, JOUR, MOIS));

  s.services.actualites += 10;       // trafic de la journée
  s.totalAcces += 10;
  s.parJour[JOUR].meteo += 10;
  const sig2 = S._signatureSocle(S._construireSocle(s, JOUR, MOIS));
  assert.equal(sig1, sig2, "l'historique ne doit pas être réécrit pour du trafic du jour");

  s.parJour["2026-09-12"].meteo = 99; // là, l'historique change VRAIMENT
  assert.notEqual(S._signatureSocle(S._construireSocle(s, JOUR, MOIS)), sig1);
});

// ── Le garde-fou : un chargement raté ne doit jamais être publié ─────────────

test("Redis injoignable : aucune écriture, l'historique n'est pas écrasé", async () => {
  faux.reset();
  S._resetStatsState();
  faux.base.set(SOCLE_KEY, JSON.stringify({ services: { installation: 585 }, parJour: { "2026-01-01": { meteo: 3 } } }));
  faux.lectureKo = true;

  const stats = await S.readStats();
  assert.deepEqual(stats.parJour, {}, "en mode dégradé on compte sur un objet neuf");

  stats.services = { installation: 1 };
  S.writeStats(stats);
  const r = await S.flushStatsNow();
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "stats-not-loaded");
  assert.deepEqual(faux.ecritures, [], "aucune écriture tant que la lecture n'a pas réussi");

  const socleIntact = JSON.parse(faux.base.get(SOCLE_KEY));
  assert.equal(socleIntact.services.installation, 585, "l'historique en base est resté intact");
});

test("une écriture tardive née du mode dégradé n'écrase pas l'historique relu", async () => {
  faux.reset();
  S._resetStatsState();
  faux.base.set(SOCLE_KEY, JSON.stringify({ services: { installation: 585 }, parJour: { "2026-01-01": { meteo: 3 } } }));
  faux.lectureKo = true;

  const vieuxObjet = await S.readStats();      // requête en vol, pendant la panne
  vieuxObjet.services = { installation: 1 };
  assert.equal(JSON.stringify(vieuxObjet).includes("__degrade"), false,
    "la marque interne ne doit jamais partir dans Redis");

  // Redis répond de nouveau et une autre requête recharge l'historique
  // (`_prochainEssai` est remis à zéro par la réinitialisation d'état).
  faux.lectureKo = false;
  S._resetStatsState();
  assert.equal((await S.readStats()).services.installation, 585, "historique relu");

  // …et seulement maintenant, la requête en vol écrit son objet dégradé.
  S.writeStats(vieuxObjet);
  assert.equal((await S.readStats()).services.installation, 585, "l'objet dégradé a été ignoré");
});

test("lecture rétablie : le flush reprend et publie les deux clés", async () => {
  faux.reset();
  S._resetStatsState();
  faux.base.set(SOCLE_KEY, JSON.stringify({ services: { installation: 585 }, parJour: { "2026-01-01": { meteo: 3 } } }));

  const stats = await S.readStats();
  assert.equal(stats.services.installation, 585, "historique relu");
  stats.parJour[JOUR] = { meteo: 1 };
  S.writeStats(stats);

  await S.flushStatsNow();
  assert.ok(faux.base.has(COURANT_KEY), "tranche du jour écrite");
  const courant = JSON.parse(faux.base.get(COURANT_KEY));
  assert.deepEqual(courant.parJour, { meteo: 1 });
  assert.equal(JSON.parse(faux.base.get(SOCLE_KEY)).parJour["2026-01-01"].meteo, 3, "historique préservé");
});

test("écriture du socle refusée : la tranche du jour n'est pas écrite non plus", async () => {
  faux.reset();
  S._resetStatsState();
  await S.readStats();
  S.writeStats(S._normaliser(statsExemple(), JOUR, MOIS));
  faux.ecritureKo = true;
  const r = await S.flushStatsNow();
  assert.equal(r.socle, false);
  assert.equal(r.courant, false);
  assert.deepEqual(faux.ecritures, [], "on ne sépare jamais un socle périmé d'une tranche à jour");
});

test("migration : l'ancienne clé est relue puis supprimée une fois les deux nouvelles écrites", async () => {
  faux.reset();
  S._resetStatsState();
  faux.base.set(LEGACY_KEY, JSON.stringify(statsExemple()));

  const stats = await S.readStats();
  assert.equal(stats.services.installation, 585, "ancien contenu repris");
  assert.equal(stats.deviceStats.monthSeen, undefined, "structure obsolète abandonnée au passage");

  S.writeStats(stats);
  await S.flushStatsNow();
  assert.ok(faux.base.has(SOCLE_KEY) && faux.base.has(COURANT_KEY));
  assert.equal(faux.base.has(LEGACY_KEY), false, "ancienne clé supprimée après migration réussie");
});

test("aucune écriture quand rien n'a changé", async () => {
  faux.reset();
  S._resetStatsState();
  await S.readStats();
  S.writeStats(S._normaliser(statsExemple(), JOUR, MOIS));
  await S.flushStatsNow();
  const apres = faux.ecritures.length;
  await S.flushStatsNow();
  assert.equal(faux.ecritures.length, apres, "un flush sans changement ne coûte rien");
});
