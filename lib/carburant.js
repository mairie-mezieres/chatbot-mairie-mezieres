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
  { key: 'beaugency',  label: 'E.Leclerc Beaugency',           cp: '45190', brand: 'leclerc' },
  { key: 'saintpryve', label: 'Super U Les Quinze Pierres',    cp: '45750', brand: 'super u' },
];

/* ⛔ LE RELAIS TOTALENERGIES DU COUDRAY EST EN ATTENTE DE SON IDENTIFIANT.
   Ajouté en v4.117 avec `id: '45160006'`, relevé sur un titre de résultat de
   recherche faute de pouvoir interroger le jeu de données : il a affiché les
   prix du E.Leclerc d'Olivet sous son nom (Diesel 2.250 €, 16/09 00:01, au
   centime et à la minute près), pendant que le Leclerc, lui, n'affichait plus
   rien. ⚠️ La PR promettait « une carte vide, jamais les prix d'une autre » —
   c'était faux : le garde-fou protège d'un mauvais choix par MARQUE, pas d'un
   `id` recopié de travers. Un identifiant est une donnée, pas une déduction :
   il se relève sur la fiche (`prix-carburants.gouv.fr/station/<id>`), sinon il
   ne s'écrit pas.
   Pour le remettre, il faut LES DEUX identifiants — celui du relais ET celui
   du E.Leclerc — puisqu'ils partagent le 45160 et que rien d'autre ne les
   distingue. */

function stationName(x) {
  return [x.ensigne, x.nom, x.Nom, x.adresse, x.brand].filter(Boolean).join(' ').toLowerCase();
}

/* Quel enregistrement, parmi ceux d'un code postal, est NOTRE station ?

   ⛔ LE REPLI « À DÉFAUT, LE PREMIER » N'EST PAS UN CONFORT : C'EST LE SEUL
   MÉCANISME QUI FONCTIONNE. Le flux instantané v2 ne porte **aucune enseigne**
   — un enregistrement a un `id`, un `cp`, une `adresse`, une `ville`, et des
   prix. `stationName` ne voit donc que l'adresse, et `includes('intermarch')`,
   `'super u'`, `'leclerc'` ne matchent JAMAIS. La correspondance par marque
   est décorative depuis l'origine ; c'est `liste[0]` qui a toujours désigné
   les cinq stations.

   Le 16 septembre 2026, avoir restreint ce repli aux codes postaux ne portant
   qu'un enregistrement a vidé **trois cartes sur six** en production (Cléry,
   Meung, Olivet) — les seules épargnées étant celles dont le code postal n'a
   qu'une station. ⚠️ Les tests ne l'ont pas vu : ils fabriquaient des
   enregistrements avec un champ `ensigne`, que le vrai jeu de données n'a pas.
   Un test qui invente ses données ne mesure que l'idée qu'on s'en fait.

   Le repli est donc rétabli, et n'est refusé que là où il était vraiment
   ambigu : quand **deux de NOS stations** partagent le code postal. Là, et là
   seulement, pas de correspondance = pas de prix — une station absente se
   voit, une station aux prix du voisin, non. */
function pickStationRecord(records, station) {
  const liste = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!liste.length) return null;
  if (station && station.id) {
    return liste.find(x => String(x.id) === String(station.id)) || null;
  }
  const marque = station && station.brand;
  const trouve = marque ? liste.find(x => stationName(x).includes(marque)) : null;
  if (trouve) return trouve;

  const cp = station && station.cp;
  const partage = cp && CARBURANT_STATIONS.filter(s => s.cp === cp).length > 1;
  return partage ? null : liste[0];
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
