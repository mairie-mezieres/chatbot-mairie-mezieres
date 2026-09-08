# ADR-0016 — Lecture partielle VigiEau : dire laquelle des deux requêtes est tombée, et pourquoi

- **Date** : 8 septembre 2026
- **Statut** : Accepté

## Contexte

Le diagnostic 🧪 Services affichait, sur la commune en niveau **Crise** :

> Niveau : Crise — actu/push/Facebook actifs — **lecture partielle (une requête
> VigiEau en échec)**

Ce message est un cul-de-sac : il n'y a **rien** à en tirer. La double requête
d'ADR-0009 (par coordonnées / par commune) a quatre causes d'échec possibles —
réseau, HTTP non-2xx, `409` multi-zones, corps inattendu — et le message n'en
nomme aucune, ni la requête concernée. `fetchVigieauStatus` n'exposait qu'un
booléen `complete` : le détail par requête était calculé puis **jeté**.

Or cet état n'est pas anodin. La règle 3 d'ADR-0011 interdit de publier une
**baisse** sur une lecture partielle (`descent-incomplete`). Tant que la lecture
reste partielle, la **fin des restrictions ne serait jamais annoncée** aux
habitants — et le seul signe visible serait ce message qui, lui, se lit comme un
aléa passager. Le log du cycle disait `descent-incomplete` sans plus, exactement
comme le `subscription expired` du webhook Trello (ADR-0034 côté app) : un
message exact, qui décrit un symptôme et cache la cause.

La distinction manquante est structurelle :

- `409` multi-zones sur la requête **par commune** est **permanent** tant que la
  commune relève de plusieurs zones d'un même type — la lecture restera
  partielle indéfiniment ;
- un `HTTP 5xx` ou un échec réseau est **passager** — le cycle suivant repasse.

Les deux produisaient le même message.

## Décision

`fetchVigieauStatus` renvoie un champ **`attempts`** : une entrée par requête
(`path` = `coordonnees` \| `commune`, `ok`, `level`, `reason`, `detail`), y
compris quand les deux échouent. Un helper **`partialReadReason(status)`** en
donne la version lisible (« requête par commune en échec (409 multi-zones) »).

- Le check 🧪 Services affiche cette raison à la place de « une requête VigiEau
  en échec », et ajoute, au-dessus du seuil d'alerte : « une levée des
  restrictions ne serait pas publiée ». `attempts` est joint aux `details`.
- Le log du cycle (`routes/eau.js`) ajoute la raison sur le cas `descent-incomplete`
  — le seul où la lecture partielle a une conséquence muette.
- `GET /eau/restrictions` et la réponse du cron portent aussi `attempts`.

**Aucune logique de décision ne change** : seuils, dédup, confirmation de baisse
(ADR-0005, ADR-0009, ADR-0011) sont intacts. C'est purement de l'observabilité.

## Alternatives écartées

- **Passer le check en 🔴 rouge sur lecture partielle** : le niveau reste juste
  (une lecture partielle ne peut que sous-estimer) et les montées continuent
  d'être notifiées. Rouge serait faux, et userait le signal.
- **Retomber sur la seule requête par coordonnées quand la commune est en 409**
  (donc déclarer la lecture « complète ») : ce serait renoncer au filet
  d'ADR-0009 dans le sens inverse de divergence, pour faire taire un voyant.
- **Ne rien changer et lire les logs Render** : le porteur regarde le tableau de
  bord, pas les logs ; et le log ne disait pas non plus laquelle des deux.

## Conséquences

**Positives :**
- Une lecture partielle est dépannable depuis le tableau de bord seul.
- Un blocage **durable** de la publication des baisses se distingue d'un aléa
  passager, et la conséquence est écrite en toutes lettres.

**Points de vigilance :**
- `partialReadReason` renvoie `null` sur un statut sans `attempts` (statut
  fabriqué en test, ou réponse d'une version antérieure servie par un cache) :
  le message d'origine sert alors de repli.
- Le frontend `app-mezieres/js/mat-eau8.js` applique la même double requête ; il
  n'expose pas ce diagnostic (rien à dépanner côté habitant). Si un jour il le
  fait, garder les mêmes libellés.
