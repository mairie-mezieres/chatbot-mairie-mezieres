# ADR-0015 — Un total qui absorbe l'événement qu'il devait montrer

**Date** : 2026-09-07
**Statut** : accepté

## Contexte

Le rapport de statistiques du **6 septembre 2026** annonçait, en tête de la carte
« Fréquentation » :

- **182** visiteurs uniques aujourd'hui, **+98 % vs hier**
- **272** « Accès app aujourd'hui », +55 % vs hier

…au-dessus d'un classement de services dont le **maximum était 36** (Actualités),
derrière une ligne « ↩️ Retours avant-plan : 79 ». Le porteur du projet a lu ce
mail comme une anomalie de mesure : 182 personnes, et pas une fonctionnalité
au-dessus de 36.

Ce n'en était pas une. L'arithmétique du mail se referme exactement :

```
257 (somme du tableau des services)
+ 11 (MEL)
+  4 (installations du jour)
= 272  ← « Accès app aujourd'hui »
```

Il ne restait **0** pour `app_open`. Or `app_open` est émis **une fois par appareil
et par jour** (`trackAppOpenOncePerDay`, `app-mezieres/js/mat-utils.js`) : c'est,
de très loin, l'événement le plus nombreux de la journée, et il vaut à peu près le
nombre de visiteurs uniques. Il n'apparaissait **nulle part** :

1. le tableau des services l'excluait explicitement (avec `mel` et `installation`) ;
2. le total censé le porter, `accessToday`, sommait tout `parJour[jour]` — donc
   `app_open` y était **fondu**, invisible, et le libellé « Accès app » désignait
   en réalité des ouvertures d'écrans ;
3. son comptage est **optionnel** (réglage « Ouvertures de l'application »),
   contrairement au visiteur unique qui est enregistré **dans tous les cas**
   (`routes/stats-public.js`, section « Visiteurs uniques : TOUJOURS gardés »).
   Coupé, il vaut `0` — et le trou entre les deux chiffres s'agrandit encore.

Trois mécanismes indépendants, aucun fautif pris isolément, et un résultat que
personne ne peut interpréter : **le mail affichait la conséquence sans jamais
montrer la cause**. Aucun test ne pouvait le voir — le HTML était valide, les
chiffres justes, les tendances cohérentes entre elles.

S'y ajoutait un second effet, plus discret : `app_resume` (un retour en avant-plan)
était classé parmi les services et **prenait la 1re place** — 79 contre 36 pour le
vrai n° 1. Le classement des fonctionnalités était donc faux en tête de liste.

## Décision

**Un compteur qui ne peut pas être lu séparément ne doit pas être additionné à
d'autres.** `lib/stats.js` expose `splitDayStats(parJour[jour])`, qui sépare une
journée en quatre grandeurs disjointes :

| Champ | Contenu | Affichage |
|---|---|---|
| `opens` | `app_open` | pastille « Ouvertures de l'app » |
| `resumes` | `app_resume` | ligne de contexte sous le tableau |
| `screens` | MEL + services | pastille « Écrans ouverts » |
| `services` | les vraies fonctionnalités, triées | le tableau |

Conséquences dans `routes/admin-email.js` :

- « Accès app » est **supprimé**. Ce total ne comptait pas les accès à l'app ; il
  s'appelle désormais « Écrans ouverts », et n'inclut plus ni `app_open`, ni
  `app_resume`, ni `installation`.
- Les ouvertures de l'app ont leur **propre pastille**, jour et mois.
- Quand le comptage est coupé, la pastille affiche **« — comptage désactivé dans
  les réglages »**, jamais un `0`. ⛔ Un `0` se lit « personne n'a ouvert l'app » :
  c'est le zéro muet qui a rendu l'écart inexplicable pendant des mois.
- `app_resume` **sort du classement** et devient une ligne de contexte.
- Une note sous le tableau rappelle que météo, actualités, alerte et prochaine
  manifestation se lisent **depuis l'accueil, sans clic** — donc sans événement :
  un écart entre visiteurs uniques et somme des services est **normal**.

## Conséquences

- On ne peut plus déduire les lancements de l'app d'un total : il faut lire la
  pastille. C'est le but.
- Les tendances « vs hier » de « Écrans ouverts » ne sont pas comparables aux
  anciennes « Accès app » (la définition a changé) ; les valeurs des jours passés
  sont recalculées à la lecture, donc l'historique reste cohérent avec lui-même.
- `test/stats-frequentation.test.js` rejoue **la journée réelle du 6 septembre**
  et verrouille les quatre grandeurs, l'absence des quatre non-services du
  classement, et le fait qu'un comptage coupé donne `0` sans se déverser ailleurs.
  `test/email-stats-format.test.js` refuse la réapparition du libellé « Accès app ».

## Alternatives écartées

- **Ajouter `app_open` au tableau des services.** Il l'écraserait (≈ 182 contre 36)
  et laisserait croire que « ouvrir l'app » est une fonctionnalité parmi d'autres.
- **Forcer le comptage `app_open`** (retirer le réglage). Le réglage existe pour
  la consommation Redis et la minimisation des données : c'est un choix de la
  mairie, pas un défaut. Ce qu'il fallait corriger, c'est le **silence** quand il
  est coupé.
- **Ne rien changer et documenter.** Le mail est lu chaque matin par une personne
  qui ne relit pas la documentation à chaque fois ; un rapport quotidien doit
  s'expliquer tout seul.
