# ADR-0012 — Le joker `.` ne suffit pas comme séparateur dans les DIRECT_RULES

- **Date** : 2 août 2026
- **Statut** : Accepté

## Contexte

En ajoutant les règles « arrivée dans la commune » pour le guide des nouveaux habitants,
un test d'ordre a échoué de façon inattendue : la question
« je viens d'emménager, où faire ma carte d'identité ? » tombait sur la check-list
générique du nouvel habitant au lieu de la règle `demarches_cni`, pourtant placée
**avant** dans le tableau `DIRECT_RULES`.

Le problème n'était pas l'ordre. La règle `demarches_cni` ne se déclenchait tout
simplement pas. Son motif était `carte.identit`, où `.` matche **exactement un**
caractère. Or `normalizeQuestion` (`lib/text.js`) remplace toute ponctuation par une
espace :

```
"où faire ma carte d'identité ?"  →  "ou faire ma carte d identite"
```

Il y a donc **trois** caractères entre `carte` et `identit` (espace, `d`, espace), pas un.
La formulation la plus naturelle de la démarche la plus courante de la commune renvoyait
`null` et partait dans l'IA — silencieusement, puisqu'une réponse était quand même
produite, juste plus lente, plus coûteuse et sans les informations locales de la règle.

Le test existant `test/demarches.test.js:46` interrogeait `"où faire ma carte identité ?"`
— sans apostrophe — et passait. Le bug était donc invisible depuis la suite de tests.

Deux autres règles avaient le même défaut, découvertes en cherchant le motif :
`maison.sante` (« maison de santé » = 4 caractères) et `centre.loisirs` /
`accueil.loisirs` (« centre de loisirs »).

Constat annexe : les variantes **accentuées** présentes dans plusieurs alternations
(`maison de santé`, `crèche`, `périscolaire`, `médecin`…) sont du **code mort** — la
question est dé-accentuée avant d'atteindre le `test`, ces branches ne peuvent jamais
matcher.

## Décision

Dans les `test` de `DIRECT_RULES`, nous écrivons les séparateurs entre mots
`.{0,4}` et non `.`, dès qu'une préposition ou une apostrophe peut s'y glisser
(`carte.{0,4}identit`, `maison.{0,4}sante`, `centre.{0,4}loisirs`).

Nous n'écrivons **pas** de variantes accentuées dans ces motifs : elles ne peuvent pas
matcher et donnent la fausse impression d'être couvertes.

Toute nouvelle règle est accompagnée d'un test qui interroge la formulation **avec
apostrophe et avec préposition**, pas seulement la forme compacte.

## Conséquences

**Positives :**
- Trois démarches courantes (carte/pièce d'identité, maison de santé, centre de loisirs)
  répondent enfin instantanément, sans appel IA — donc sans coût de token et sans risque
  d'hallucination.
- La règle du séparateur est écrite dans `CLAUDE.md`, à côté du rappel sur
  `normalizeQuestion`.

**Négatives / compromis acceptés :**
- `.{0,4}` élargit légèrement la surface de déclenchement. Le risque reste faible : ces
  motifs exigent les deux mots dans l'ordre, et ces règles étaient déjà très larges par
  ailleurs (`cni` seul suffisait à déclencher `demarches_cni`).
- Un motif trop permissif peut masquer une règle placée plus loin. C'est pourquoi les
  tests d'ordre de `test/guide-arrivee.test.js` vérifient explicitement qu'une question
  de cantine ne part pas sur l'inscription scolaire.

**Points de vigilance pour les futures évolutions :**
- Le même piège existe ailleurs sous une forme bénigne (`val.loire.fibre`,
  `fosse.septique`, `raccordement.fibre`) : ces motifs ne matchent pas la forme avec
  préposition, mais une autre branche de leur alternation les rattrape. À corriger si
  l'une de ces règles devient la seule voie d'accès à une information.
- Écrire un test qui passe avec la formulation compacte ne prouve rien : c'est exactement
  ce qui a laissé ce bug en place. Tester la phrase telle qu'un habitant l'écrirait.
