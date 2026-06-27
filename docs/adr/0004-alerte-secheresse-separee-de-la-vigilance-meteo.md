# ADR-0004 — Alerte sécheresse (VigiEau) séparée de la vigilance météo

- **Date** : 27 juin 2026
- **Statut** : Accepté

## Contexte

Les habitants ne voyaient pas les restrictions sécheresse (affichées tout en bas de
l'overlay météo, section Eau). On a voulu les notifier au changement de statut. Or il
existe déjà un mécanisme d'alerte pour la **vigilance Météo-France** (orages, canicule…)
qui occupe le **bandeau de vigilance** en haut de l'app.

La tentation était de réutiliser ce bandeau pour la sécheresse. Mais vigilance météo et
restrictions sécheresse répondent à des temporalités et des usages différents : une
vigilance météo dure quelques heures à quelques jours ; une restriction sécheresse dure
des semaines. Afficher la sécheresse dans le bandeau météo l'aurait fait stagner en
permanence, masquant les vraies alertes météo ponctuelles.

## Décision

Nous traitons la sécheresse comme un **flux totalement distinct** de la vigilance météo :

- côté backend, un module dédié `lib/vigieau.js` + une route `routes/eau.js`, sans aucun
  couplage avec `lib/meteo.js` / `routes/meteo.js` ;
- côté habitant, une alerte sécheresse devient une **actualité** (`source: vigieau`) +
  un **push** + un **post Facebook** — jamais une entrée du bandeau de vigilance météo ;
- l'affichage permanent du niveau reste cantonné à la ligne « Restrictions » de la
  section 💧 Eau de l'overlay (`js/mat-eau8.js`), inchangée dans son emplacement.

Le bandeau / la carte de vigilance Météo-France (`js/mat-widgets.js`) ne sont pas touchés.

## Conséquences

**Positives :**
- Les deux types d'alerte coexistent sans se masquer.
- Une restriction sécheresse de longue durée n'écrase pas les vigilances météo ponctuelles.
- Évolution indépendante des deux flux (seuils, formats, sources).

**Négatives / compromis acceptés :**
- Duplication apparente du « pattern d'alerte » (polling + dédup + verrou), mais réutilisation
  réelle des briques actu (`sendActuPush`, `publishActuToFacebook`) pour éviter la copie de
  la logique push/Facebook.

**Points de vigilance pour les futures évolutions :**
- Toute future « alerte » de longue durée (qualité de l'air durable, etc.) devrait suivre ce
  modèle « actualité dédiée » plutôt que le bandeau vigilance.
