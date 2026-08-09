/*
 * Verrouille la construction du client Google Calendar (lib/calendar.js).
 *
 * Pourquoi ce test existe — la PR #166 réclamait « un test du calendrier »
 * avant toute montée majeure de googleapis. Le besoin s'est confirmé : le code
 * appelait `new google.auth.JWT(email, null, key, scopes)`, forme positionnelle
 * qui fonctionne en googleapis 134 mais dont les arguments sont IGNORÉS EN
 * SILENCE à partir des versions récentes (mesuré en 174.0.1).
 *
 * Le piège est qu'aucune exception n'est levée : on obtient un client dont
 * `email`, `key` et `scopes` valent `undefined`. Le `try/catch` de
 * getGoogleCalendarClient() ne se déclenche pas, rien n'apparaît au démarrage,
 * et la panne ne se manifeste qu'au premier événement publié par la mairie.
 *
 * Ce test ne fait AUCUN appel réseau : il n'authentifie rien, il vérifie
 * seulement que le client construit a bien retenu ce qu'on lui a donné.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const FAUX_COMPTE = {
  client_email: "robot@exemple.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n",
};

const SCOPE_ATTENDU = "https://www.googleapis.com/auth/calendar";

/** Recharge lib/calendar.js à neuf (le client est mémoïsé au niveau module). */
function chargerCalendar(env) {
  for (const k of ["GOOGLE_SERVICE_ACCOUNT", "GOOGLE_SERVICE_ACCOUNT_B64"]) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve("../lib/calendar")];
  return require("../lib/calendar");
}

test("sans identifiants configurés, le client est null (pas d'exception)", () => {
  const { getGoogleCalendarClient } = chargerCalendar({});
  assert.equal(getGoogleCalendarClient(), null);
});

test("le client JWT retient email, clé et scopes — pas d'arguments avalés", () => {
  const { getGoogleCalendarClient } = chargerCalendar({
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify(FAUX_COMPTE),
  });
  const client = getGoogleCalendarClient();

  assert.ok(client, "le client Calendar doit être construit");

  // C'est ICI que la forme positionnelle échouerait : le client existerait,
  // mais sans identifiants. On interroge donc l'objet d'authentification.
  const auth = client.context && client.context._options && client.context._options.auth;
  assert.ok(auth, "le client doit porter son objet d'authentification");
  assert.equal(auth.email, FAUX_COMPTE.client_email, "email avalé par le constructeur");
  assert.equal(auth.key, FAUX_COMPTE.private_key, "clé privée avalée par le constructeur");
  assert.deepEqual(auth.scopes, [SCOPE_ATTENDU], "scopes avalés par le constructeur");
});

test("la variante base64 des identifiants est acceptée", () => {
  const { getGoogleCalendarClient } = chargerCalendar({
    GOOGLE_SERVICE_ACCOUNT_B64: Buffer.from(JSON.stringify(FAUX_COMPTE)).toString("base64"),
  });
  const client = getGoogleCalendarClient();
  assert.ok(client, "le client doit être construit depuis GOOGLE_SERVICE_ACCOUNT_B64");
});

test("des identifiants illisibles ne font pas planter le démarrage", () => {
  const { getGoogleCalendarClient } = chargerCalendar({
    GOOGLE_SERVICE_ACCOUNT: "{ ceci n'est pas du JSON",
  });
  assert.equal(getGoogleCalendarClient(), null);
});

test("l'API v3 expose bien les méthodes que lib/calendar.js appelle", () => {
  const { getGoogleCalendarClient } = chargerCalendar({
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify(FAUX_COMPTE),
  });
  const client = getGoogleCalendarClient();
  for (const m of ["list", "insert", "update"]) {
    assert.equal(typeof client.events[m], "function", `events.${m} doit exister`);
  }
});
