# ADR-0008 — Rejet des coordonnées GPS implausibles (« Null Island »)

**Date** : 2026-07-05
**Statut** : accepté

## Contexte

Un signalement citoyen est apparu sur la carte de l'app **au large de l'Afrique
équatoriale**. Sa carte Trello contenait `mlat=0&mlon=0` : le téléphone du
citoyen avait renvoyé la position **(0,0)** — « Null Island », golfe de
Guinée — au lieu d'une erreur de géolocalisation (comportement connu de
certains appareils Android quand la position est indisponible). (0,0) étant
dans les bornes valides (lat −90..90, lon −180..180), `geoPoint` l'acceptait,
et l'app affichait « ✅ Position obtenue (0.00000, 0.00000) ».

## Décision

Un point GPS de signalement n'a de sens que **près de la commune**. Trois
barrières :

1. **`lib/validate.js` → `geoPointNear(lat, lon, refLat, refLon)`** : n'accepte
   que les points à ±0.5° de latitude / ±0.7° de longitude (≈ 55 km) du centre
   de la commune (`OPEN_METEO_LAT/LON`). Écarte (0,0), les points à des
   centaines de km, et les paires lat/lon inversées.
2. **Dépôt** (`POST /signal`) : `geoPointNear` remplace `geoPoint` — un point
   implausible = pas de lien carte dans Trello.
3. **Affichage** (`/api/signalements`, parse des cartes Trello) : même filtre —
   les **anciennes cartes** au point aberrant n'affichent plus de marqueur (le
   lien reste lisible dans Trello pour les humains).

Côté app (`app-mezieres/js/mat-forms.js`), une position (0,0) renvoyée par le
GPS est traitée comme un échec : « ❌ Position indisponible » + invitation à
réessayer, au lieu de « ✅ Position obtenue (0.00000, 0.00000) ».

## Conséquences

- Plus aucun marqueur hors zone sur les cartes citoyenne et suivi, quelle que
  soit l'origine de la donnée (téléphone, carte éditée à la main…).
- Un habitant qui signalerait depuis un point à > 55 km de la commune perd le
  lien carte (cas jugé sans valeur : le signalement concerne la commune).
- Le rayon est volontairement large (Orléans inclus) pour ne pas rejeter les
  signalements des alentours ; ajuster `maxDegLat/maxDegLon` si besoin.
- Tests : `test/validate.test.js` (`geoPointNear`).
