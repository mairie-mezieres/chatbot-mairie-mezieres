# ADR-0010 — Socle de versions Node.js en table locale, pas en appel réseau

- **Date** : 27 juillet 2026
- **Statut** : Accepté

## Contexte

Render n'installe une nouvelle version de Node **qu'au moment d'un build**. Le
`render.yaml` fixe `NODE_VERSION: "22"`, donc chaque build récupère la dernière
22.x — mais entre deux déploiements, le serveur reste sur la version installée le
jour du dernier build. Quand une publication de sécurité Node sort (celle du
27 juillet 2026, sévérité HIGH sur 22.x/24.x/26.x, en est l'élément déclencheur),
rien dans l'application ne signale que le runtime est en retard : ni les logs, ni
le tableau de bord, ni la CI, qui teste sur un runner GitHub toujours à jour.

Il fallait donc rendre visible l'écart « version qui tourne » / « version sûre ».
Deux approches possibles :

1. interroger `https://nodejs.org/dist/index.json` au moment du diagnostic pour
   comparer à la dernière version publiée ;
2. maintenir dans le dépôt une table des versions minimales sûres par ligne.

## Décision

Nous utilisons une **table locale**, `lib/node-baseline.js`, mise à jour à la
main lorsque la veille hebdomadaire signale une publication de sécurité Node.
Le diagnostic `/admin/services/test` compare `process.version` à cette table.

Nous n'interrogeons **pas** nodejs.org depuis le backend.

La table porte trois informations : `MIN_SAFE_BY_LINE` (version minimale par
ligne), `SUPPORTED_LINES` (lignes encore maintenues) et `PENDING_ADVISORY` — un
champ pour le cas particulier « une faille est annoncée mais les versions
correctives ne sont pas encore publiées », qui maintient un avertissement jaune
tant qu'il n'est pas remis à `null`.

## Conséquences

**Positives :**
- Le diagnostic reste **déterministe et hors-ligne** : cohérent avec la règle du
  dépôt (« couvrir en priorité les chemins sans appel réseau sortant réel »), et
  testable sans mock réseau.
- Aucune dépendance à la disponibilité de nodejs.org pour savoir si le runtime
  est à jour ; pas de faux 🔴 quand un service tiers est en panne.
- « Dernière version publiée » ≠ « version minimale sûre » : une table écrite à
  la main dit exactement ce qu'on veut dire, là où un comparatif automatique
  passerait au rouge à chaque release mineure sans enjeu de sécurité.
- La mise à jour de la table et le redéploiement sont **le même geste** que le
  correctif lui-même — la table ne peut pas dériver silencieusement dans le bon
  sens.

**Négatives / compromis acceptés :**
- La table **doit être entretenue à la main**. Si personne ne la met à jour, le
  check affiche vert alors qu'un correctif est sorti. C'est un compromis assumé :
  la veille hebdomadaire automatique (`app-mezieres/veille/`) est le garde-fou,
  et `PENDING_ADVISORY` couvre la fenêtre entre l'annonce et la publication.
- Le check ne détecte pas une faille dont Node n'aurait pas fait d'annonce.

**Points de vigilance pour les futures évolutions :**
- Ne pas exposer `process.version` sur une route **publique** (`/health`,
  `/status`) : le check est volontairement derrière `adminAuth`, pour ne pas
  publier la version exacte du runtime à un attaquant.
- En changeant de ligne Node (22 → 24 LTS), penser aux trois endroits :
  `SUPPORTED_LINES` ici, `NODE_VERSION` dans `render.yaml`, et `node-version`
  dans les workflows GitHub Actions des deux dépôts.
- Si l'entretien manuel s'avère trop fragile, l'évolution naturelle n'est pas
  d'appeler nodejs.org depuis le backend mais de faire ouvrir une PR par la
  veille hebdomadaire, qui a déjà le contexte et le droit d'écriture.
