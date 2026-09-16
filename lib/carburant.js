// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mézières-lez-Cléry
//
// Prix carburant — la partie qui se raisonne et se teste hors réseau.
// `routes/carburant.js` ne garde que l'appel HTTP et le cache.
//
// ⛔ CE QUI A MOTIVÉ CE FICHIER : le relevé national date CHAQUE CARBURANT
// SÉPARÉMENT. Le E.Leclerc de Beaugency (en fait Tavers, 45190) affichait le
// 16 septembre 2026 un SP95 relevé le 08/09 et un gazole relevé le 16/09 — et
// l'app annonçait « relevé d'il y a 8 jours » pour les deux, parce que la date
// retenue était la PREMIÈRE trouvée (`sp95_maj || e10_maj || gazole_maj`).
// Un gazole du matin passait donc pour un prix de la semaine dernière, et
// l'inverse est tout aussi possible : la même ligne de code aurait daté un
// SP95 vieux de huit jours avec l'horodatage du gazole du jour.
"use strict";

/* Stations suivies, dans l'ordre de proximité de Mézières-lez-Cléry.
   ⚠️ `id` est l'identifiant de la station dans le jeu de données
   `prix-des-carburants-en-france-flux-instantane-v2` (celui de l'URL
   `prix-carburants.gouv.fr/station/<id>`). Quand il est renseigné, c'est LUI
   qui désigne la station — voir `pickStationRecord`. */
const CARBURANT_STATIONS = [
  { key: 'clery',      label: 'Intermarché Cléry-St-André',    cp: '45370', brand: 'intermarch' },
  { key: 'meung',      label: 'Super U Meung-sur-Loire',       cp: '45130', brand: 'super u' },
  { key: 'olivet',     label: 'E.Leclerc Olivet',              cp: '45160', brand: 'leclerc' },
  { key: 'coudray',    label: 'TotalEnergies Relais du Coudray', cp: '45160', brand: 'total', id: '45160006' },
  { key: 'beaugency',  label: 'E.Leclerc Beaugency',           cp: '45190', brand: 'leclerc' },
  { key: 'saintpryve', label: 'Super U Les Quinze Pierres',    cp: '45750', brand: 'super u' },
];

function stationName(x) {
  return [x.ensigne, x.nom, x.Nom, x.adresse, x.brand].filter(Boolean).join(' ').toLowerCase();
}

/* Quel enregistrement, parmi ceux d'un code postal, est NOTRE station ?

   ⛔ Le repli « à défaut, le premier » n'est pas admissible quand le code
   postal en porte plusieurs : Olivet (45160) compte le E.Leclerc ET le relais
   TotalEnergies du Coudray, et rien à l'écran ne distinguerait les prix de
   l'un affichés sous le nom de l'autre. Une station déclarant un `id` se
   reconnaît donc à son `id`, un point c'est tout ; sans `id`, le repli ne
   s'applique que s'il n'y a qu'un seul enregistrement — aucune ambiguïté
   possible. Dans tous les autres cas on rend `null` : pas de prix vaut mieux
   qu'un prix attribué à la mauvaise station. */
function pickStationRecord(records, station) {
  const liste = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!liste.length) return null;
  if (station && station.id) {
    return liste.find(x => String(x.id) === String(station.id)) || null;
  }
  const marque = station && station.brand;
  const trouve = marque ? liste.find(x => stationName(x).includes(marque)) : null;
  if (trouve) return trouve;
  return liste.length === 1 ? liste[0] : null;
}

function formatMaj(raw) {
  const d = raw ? new Date(raw) : null;
  if (!d || isNaN(d.getTime())) return { maj: null, majISO: null };
  return {
    // « JJ/MM HH:MM » : chaîne d'AFFICHAGE, sans année, donc incomparable.
    maj: d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    majISO: d.toISOString(),
  };
}

/* Prix et dates d'un enregistrement.

   Le SP95 se replie sur le E10 quand la station ne sert que celui-ci — et sa
   date suit la MÊME source : dater un E10 avec l'horodatage du SP95 serait
   remettre le bug d'un cran plus bas.

   `maj` / `majISO` au niveau de la station restent exposés, et valent le
   **plus ancien** des relevés : c'est la valeur sûre pour un consommateur qui
   afficherait TOUS les prix sous une seule date — une version de l'app restée
   en cache, par exemple. Annoncer le plus récent ferait, là, passer un prix
   périmé pour un prix du jour, ce que l'ADR-0033 côté app interdit.
   ⚠️ L'app, elle, n'affiche que le relevé le plus récent de chaque station et
   recalcule la date sur les prix qu'elle montre (ADR-0047) : elle ne lit ces
   deux champs qu'en repli, quand un carburant n'a aucune date. */
function extractPrices(rec) {
  let sp95 = null, sp95Raw = null;
  if (rec && rec.sp95_prix != null) { sp95 = rec.sp95_prix; sp95Raw = rec.sp95_maj || rec.prix_maj || null; }
  else if (rec && rec.e10_prix != null) { sp95 = rec.e10_prix; sp95Raw = rec.e10_maj || rec.prix_maj || null; }

  const gazole = (rec && rec.gazole_prix != null) ? rec.gazole_prix : null;
  const gazoleRaw = gazole != null ? ((rec && rec.gazole_maj) || (rec && rec.prix_maj) || null) : null;

  const sp95Date   = formatMaj(sp95Raw);
  const gazoleDate = formatMaj(gazoleRaw);

  const connues = [sp95Date, gazoleDate].filter(d => d.majISO);
  const plusAncienne = connues.length
    ? connues.reduce((a, b) => (a.majISO <= b.majISO ? a : b))
    : { maj: null, majISO: null };

  return {
    sp95, gazole,
    sp95Maj:    sp95Date.maj,     sp95MajISO:   sp95Date.majISO,
    gazoleMaj:  gazoleDate.maj,   gazoleMajISO: gazoleDate.majISO,
    maj:        plusAncienne.maj, majISO:       plusAncienne.majISO,
  };
}

module.exports = { CARBURANT_STATIONS, pickStationRecord, extractPrices, formatMaj, stationName };
