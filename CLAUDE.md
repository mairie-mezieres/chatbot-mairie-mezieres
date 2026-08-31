# Instructions pour Claude Code — MAT Backend (Mézières Avec Toi)

## 📚 Documentation — aiguillage OBLIGATOIRE (à lire avant d'agir)

Ce fichier est le **seul** document automatiquement chargé à chaque session. Toute la
connaissance détaillée vit dans les fichiers ci-dessous. **Avant de coder, de répondre
à une question d'architecture, ou de créer une fonctionnalité, ouvre le(s) document(s)
correspondant(s)** — ne raisonne pas de mémoire et ne réinvente pas l'existant.

Règle d'or : **vérifier qu'une fonctionnalité n'existe pas déjà (code + UI admin + doc) avant de la construire.**

| Si la tâche touche à… | LIRE d'abord |
|---|---|
| Tableau de bord admin, onglets, **diagnostic 🧪 Services** (§6), env Render (§4), Sentry, FAQ dépannage | `GUIDE-ADMIN.md` |
| **Webhook Facebook `#MAT`** — fonctionnement et dépannage | `GUIDE-ADMIN.md` §5 |
| **Alertes sécheresse VigiEau** (séparées de la vigilance météo) — `lib/vigieau.js`, `routes/eau.js` | `GUIDE-ADMIN.md` §5ter |
| **Normales saisonnières 1991-2020** — `lib/normales.js`, `GET /meteo/normales`, champ `normales` de `/meteo/commune`. ⚠️ **ERA5 est une réanalyse, PAS une station** : ne jamais l'annoncer autrement. Règle du tout ou rien, calcul en arrière-plan | `GUIDE-ADMIN.md` §6quinquies puis `app-mezieres/docs/adr/0024-…` |
| **Kit réplication « Partager »** — profils de communes, mail quotidien, `POST /stats/partager` | `GUIDE-ADMIN.md` §6bis |
| **Mail de stats quotidien** (`routes/admin-email.js`) — ⛔ **ni feuille de style, ni classe CSS, ni `display:grid`** : un bloc `<style>` est supprimé par Gmail/Outlook.com/Yahoo à la réception et le mail arrive **en texte brut**, sans la moindre erreur visible (il s'affiche très bien dans un navigateur — le seul endroit où on le teste). Styles en attribut, mise en page en `<table>`, `font-family` sur chaque `<td>`, et une variante `text` dans le payload Resend | `GUIDE-ADMIN.md` §6sexies puis `docs/adr/0014-mail-html-sans-feuille-de-style.md` |
| **Compteur d'installations** (badge app, mail, tableau de bord) — source unique `services.installation` | `GUIDE-ADMIN.md` §6ter + `docs/adr/0010-…` |
| **Documents du PLUi-H-D** — routes `/docs/plui`, envoi de PDF (Cloudinary `raw`, 4 Mo max) ou lien, pastille « Nouveau » | `GUIDE-ADMIN.md` §6quater + `app-mezieres/docs/adr/0014-…` |
| Présentation du backend, architecture, routes, démarrage | `README.md` |
| Conformité de l'assistant MEL (AI Act, RGPD, sécurité) | `docs/note-conformite-MEL.md` |
| Sécurité, signalement de vulnérabilité, données personnelles | `SECURITY.md` |
| **Mise à jour de Node.js**, socle de versions sûres (`lib/node-baseline.js`), check 🟩 runtime | `GUIDE-ADMIN.md` §6ter |
| **Inventaire des domaines / hébergeurs, alertes CERT-FR** | repo `app-mezieres` → `docs/surface-exposition.md` |
| **Cerfa d'urbanisme** (DP, permis de construire) — ⚠️ les 13703, 13702 et 13404 sont **abrogés** depuis le 1er janvier 2025 ; ne jamais écrire de **millésime** (« 16702\*02 ») ; quatre endroits à garder en phase | `app-mezieres/docs/adr/0029-un-numero-de-formulaire-mort-ne-se-voit-pas.md` puis `test/urbanisme-cerfa.test.js` |
| **Prix carburant** (`routes/carburant.js`) — ⚠️ `maj` est une chaîne d'affichage **sans année**, seul `majISO` (horodatage brut) se compare d'une station à l'autre ; ⛔ **la clé Redis suit la forme du payload** (`mat:carburant:v8`) : ajouter un champ sans changer la clé sert l'ancien format pendant une heure | `app-mezieres/docs/adr/0033-un-prix-sans-sa-date-est-un-prix-du-jour.md` puis `app-mezieres/docs/specifications-techniques/STD-07-services-pratiques.md` |
| **Décisions d'architecture** (pourquoi Trello, pourquoi les tokens individuels, pourquoi `sub=null` sur 410…) | `docs/adr/` — un fichier par décision |
| **« Le saviez-vous ? »** — routes `GET`/`POST /saviezvous/:id` (`routes/reactions.js`). ⚠️ Le **contenu** des faits n'est PAS ici : il vit dans `app-mezieres/data/saviez-vous.json`, versionné et relu. Le backend ne connaît que des identifiants et des compteurs. **Aucune IA ne doit jamais écrire ces faits** | `app-mezieres/docs/adr/0012-…` puis `SFD-16` |
| **Côté app / PWA / Service Worker / affichage habitant** | repo `app-mezieres` → son `CLAUDE.md` puis `docs/guide-technique.md` |

> ⚠️ Avant d'ajouter quoi que ce soit au diagnostic `/admin/services/test` ou à
> l'administration, **lis `GUIDE-ADMIN.md`** : beaucoup de checks et de boutons
> (webhook Trello, webhook Facebook, listes Trello, push…) existent déjà.

Quand tu crées une doc durable, ajoute-la à ce tableau pour rester aiguillable.

## Règle de mise à jour de la documentation

**À chaque correction ou évolution du code**, avant de fermer la PR :
1. Identifier quelle(s) doc(s) décrivent la zone touchée (voir tableau ci-dessus).
2. Mettre à jour ces docs dans la **même PR** que le code.
3. Si une décision structurante est prise ou un bug non-évident corrigé → créer un ADR dans `docs/adr/`.

Cas typiques :
- Modification du comportement des push citoyens → `GUIDE-ADMIN.md` §5bis + ce `CLAUDE.md`
- Nouveau check dans le diagnostic Services → `GUIDE-ADMIN.md` §6
- Nouvelle variable d'env → `GUIDE-ADMIN.md` §4
- Décision « pourquoi on ne fait pas X » → ADR

## Notifications push citoyens (signalements / demandes / bugs)

Architecture à connaître avant toute modification des notifications :

- **Token individuel** : `mat:notify:token:{uuid}` en Redis (TTL 365 j), créé à la
  soumission d'un signalement/demande/idée. Champ `sub` = abonnement Web Push.
- **Lien carte ↔ citoyen** : le marqueur `MAT-REF: {uuid}` est écrit dans la
  description de la carte Trello. Sans lui, aucune notification possible.
- **Deux déclencheurs** envoient un push au citoyen :
  1. `PATCH /admin/signals/:id` (tableau de bord admin)
  2. `POST /trello/webhook` (changement de statut OU commentaire directement dans Trello)
- **Trois types de cartes**, routage des push (`lib/push-notify.js`) :

  | Carte | Changement de statut | Commentaire | Ouvre dans l'app |
  |---|---|---|---|
  | `[Signalement]` | `sendSignalStatusPush` | `sendSignalCommentPush` | `#signalements` |
  | `[BUG]` | `sendSignalStatusPush` | `sendBugCommentPush` | `#bugs` |
  | `[Demande]` | `sendDemandeStatusPush` | `sendDemandeCommentPush` | `#contact` |

- **Webhook Trello** : géré dans `routes/trello-webhook.js`. Enregistrement idempotent
  via `POST /admin/trello/register-webhook` ; liste via `GET /admin/trello/webhooks`.
  L'admin a déjà une UI dédiée (bouton « Activer le webhook Trello » + « Vérifier l'état »).
- **Résilience endpoint** : sur réponse 410/404 (endpoint expiré), on **ne supprime pas**
  le token — on met seulement `entry.sub = null`. Le frontend le re-lie au prochain
  chargement via `_registerPendingNotifyTokens()`.
  ⛔ **Cette phrase a été fausse pendant longtemps, et c'est invisible d'ici.** Le
  re-raccordement côté app était placé **derrière** le garde-fou `mat_push_active`,
  drapeau qu'un habitant ayant activé les notifications depuis le **formulaire** n'a
  jamais — donc il n'avait jamais lieu, pour exactement les abonnements concernés. Et
  le handler `pushsubscriptionchange` du service worker ne rappelait pas
  `/notify/register-token` (cas le plus fréquent : la rotation d'endpoint survient
  application fermée). Corrigé en v4.102. ⚠️ **Le seul symptôme côté backend est
  `{skipped: true, reason: "subscription expired"}` dans les logs du webhook Trello** —
  un message exact, qui décrit un abonnement expiré et *pas* une chaîne de
  re-raccordement rompue : il se lit comme un fonctionnement normal. Avant de conclure
  qu'un habitant s'est désabonné, vérifier que le front raccorde vraiment
  (`node scripts/check-notify-relink.js` dans `app-mezieres`). Voir
  `app-mezieres/docs/adr/0034-un-garde-fou-peut-emporter-ce-qu-il-protege.md`.

## Structure & tests

- **`app.js`** construit l'app Express (middleware + montage des routes + route `/cron/dechets`).
  **`index.js`** ne fait que l'exécuter (`app.listen`, polling météo/sécheresse, rappels déchets,
  arrêt gracieux). → Toute **nouvelle route se monte dans `app.js`**, pas `index.js`. Voir ADR-0006.
- **Tests de routes** : `test/routes.test.js` importe `app.js`, fait `app.listen(0)` et tape via
  `fetch` natif (aucune dépendance). `npm test` = `bash scripts/run-tests.sh` : chaque fichier
  est exécuté **directement** (`node test/xxx.test.js`, mode standalone de `node:test`) — PAS
  via le runner `node --test`, dont l'IPC parent/enfant plante aléatoirement sur Node 22.23.x
  en CI (« Unable to deserialize cloned data »), avec ou sans `--test-force-exit`.
  ⚠️ Tout nouveau `setInterval` de niveau module DOIT être `.unref?.()` (store, mel,
  admin-actus, admin-email et logger le sont) — sinon les fichiers de test ne rendent plus la
  main. Nouveau fichier de test : le nommer `test/*.test.js`, il est ramassé par le script.
- Couvrir en priorité les chemins **sans appel réseau sortant réel** (validation HMAC, auth admin,
  santé, CORS, rejets de validation) ou mocker, pour rester déterministe hors-ligne.
- **Validation des entrées** : helpers sans dépendance dans `lib/validate.js`
  (`capStr`, `finiteNum`, `safeId`, `inEnum`, `geoPoint`). Utiliser ces helpers pour plafonner /
  normaliser les entrées citoyennes plutôt que de réécrire `String(x).substring(...)` à la main.

## Journal d'audit admin

- Toute **action admin destructrice** (suppression actu/idée/sondage/photo, purge) doit appeler
  `logAudit(action, detail)` de `lib/logger.js` (même flux que les logs serveur, **sans** la
  limitation de débit). Les entrées apparaissent dans l'onglet 🪲 Logs (module `audit`).

## Démarches administratives (MEL)

- Le mécanisme maison pour les démarches courantes est **`DIRECT_RULES`** (`lib/mel.js`) :
  réponse complète **instantanée, sans appel IA**, déclenchée par regex sur la question
  normalisée (`normalizeQuestion` = minuscules, **sans accents**, sans ponctuation).
  Déjà couverts : CNI, passeport, état civil, **élections (inscription + procuration)**,
  **recensement citoyen**, **PACS**, **arrivée dans la commune (nouvel habitant, changement
  d'adresse, compteurs eau/énergie, inscription scolaire)**, clôtures/abris/piscine,
  déchets, santé, OPAH, SPANC, **bruits de voisinage (horaires de bricolage et de
  jardinage)**, **LAEP (Lieu d'Accueil Enfants-Parents)**…
- ⚠️ **Le joker `.` ne suffit pas comme séparateur.** `normalizeQuestion` remplace toute
  ponctuation par une **espace** : « carte d'identité » devient `carte d identite`, soit
  **trois** caractères entre les deux mots. Un motif écrit `carte.identit` ne matche donc
  pas la formulation la plus naturelle. Écrire `carte.{0,4}identit`. Trois règles étaient
  muettes pour cette raison (CNI/pièce d'identité, maison de santé, centre de loisirs).
- ⚠️ **Écrire les liens en `https://` complet, et jamais collés à une ponctuation.**
  L'app ne rend cliquable que `https?://…` et `www.…` (`_renderDirectAnswer`,
  `app-mezieres/js/mat-mel.js`) : un domaine nu comme `exemple.fr` s'affiche mais ne
  s'ouvre pas. Et comme le motif d'URL est `[^\s<>]+`, toute ponctuation collée derrière
  est **avalée dans le href** — `(sur https://exemple.fr)` produit un lien vers
  `https://exemple.fr)`, cassé. Faire suivre l'URL d'une espace (tiret cadratin plutôt
  que parenthèse ou point). Verrouillé pour toutes les règles par un test de propriété
  dans `test/guide-arrivee.test.js`.
- ⚠️ Inutile de lister les variantes **accentuées** dans un `test` de `DIRECT_RULES` : la
  question est déjà dé-accentuée. `maison de santé` ou `crèche` dans une alternation sont
  du code mort — seule la forme sans accent peut matcher.
- **L'ordre du tableau est la priorité** : la première règle dont `test` renvoie vrai gagne.
  Le bloc « arrivée dans la commune » est placé après l'état civil (une question précise
  garde la main) et avant `cantine`/`centre_loisirs`, et sa règle parapluie
  `nouvel_habitant` vient en dernier du bloc. Ces contraintes sont verrouillées par des
  tests d'ordre dans `test/guide-arrivee.test.js`.
- MEL n'a PAS service-public.gouv.fr dans ses `SOURCES` : si elle « ne sait pas » sur une
  démarche courante, **ajouter une DIRECT_RULE** (+ mots-clés dans `KEYWORDS.demarches`
  pour les stats/pages sources) — pas de relâcher les garde-fous anti-hallucination,
  et pas de mécanisme parallèle (leçon : une PR a créé un doublon « fiches contexte »
  avant de découvrir DIRECT_RULES — règle d'or : vérifier l'existant).
- L'**arbre de décision** (admin → onglet 👩 MEL) est le 3e canal : parcours guidé
  cliquable, éditable par la mairie sans code.
  Tests : `test/demarches.test.js`, `test/guide-arrivee.test.js`, `test/bruit.test.js`,
  `test/location-salle.test.js`.
- ⚠️ **Un changelog n'est pas une preuve d'existence.** La v4.15 annonçait « règle MEL
  directe pour les horaires de bruit et de bricolage » ; la règle n'a jamais existé dans
  le code. Résultat, trois mois plus tard : « quelles sont les horaires de bruit » →
  « je n'ai pas cette information », et une reformulation de la même question →
  **horaires inventés** (« 22h-7h », « dimanche toute la journée ») attribués à un
  **arrêté municipal qui n'existe pas**. Une règle absente ne se manifeste pas par un
  silence mais par une hallucination plausible. Deux garde-fous depuis :
  `test/bruit.test.js` verrouille les plages **et** l'absence des plages fausses, et le
  `SYSTEM_PROMPT` porte un bloc « BRUITS DE VOISINAGE » qui interdit explicitement d'en
  énoncer d'autres. Avant de croire une entrée de changelog, `grep` le code.
- ⚠️ **Bruit : l'arrêté est PRÉFECTORAL, pas municipal.** Mézières n'a pas d'arrêté
  propre sur le bruit ; c'est l'**arrêté préfectoral du Loiret du 1er mars 1999** qui
  s'applique. Plages autorisées pour les outils bruyants (tondeuse, taille-haie,
  tronçonneuse, perceuse…) : **lundi-vendredi 8h30-12h et 14h30-19h30, samedi 9h-12h et
  15h-19h, dimanche et jours fériés 10h-12h**. Ces horaires ne valent que pour ces
  outils : la règle générale (aucun bruit portant atteinte à la tranquillité, de jour
  comme de nuit) s'applique en permanence. Deux endroits à garder en phase : la règle
  `bruit_travaux_horaires` et le bloc `BRUITS DE VOISINAGE` du `SYSTEM_PROMPT`.
- ⚠️ **Un fait enfoui n'est pas un fait connu.** Deuxième occurrence le même jour : « quel
  est le tarif de la salle des fêtes ? » — or **la salle n'est plus louée**. Le fait
  existait dans le dépôt, en **9ᵉ ligne d'un paragraphe de 200 mots** de la rubrique
  « Location de matériel » (`app-mezieres/data/mel-tree.json`), **absent** de l'autre copie
  de l'arbre (`app-mezieres/js/mat-mel.js`), et inconnu du backend. Trois copies, une seule
  portait le fait, et pas celle que MEL lit. D'où la règle `location_salle_materiel` et le
  bloc `SALLE COMMUNALE ET LOCATION DE MATÉRIEL` du `SYSTEM_PROMPT`. Voir ADR-0013.
- ⚠️ **Crèche Les Marmousets : un chiffre lu au mauvais paragraphe reste un chiffre faux.**
  Le règlement de fonctionnement « parents » 2026-2027 du SIVU (27 août 2026) a démenti
  deux affirmations que l'application portait depuis longtemps : « **17** assistantes
  maternelles » (elles sont **16**, §1.4) et « enfants de **moins de 6 ans** » — c'est
  **de 10 semaines à l'entrée à l'école maternelle** (§1.1). Les « moins de six ans »
  existent bien dans le règlement, mais ne visent que les **places garanties de l'article
  D.214-7** (parents en parcours d'insertion). Les deux erreurs s'étaient propagées dans le
  corpus « Le saviez-vous ? » de l'app, qui puise dans l'arbre de décision : **toute
  correction ici impose de grepper `app-mezieres/data/saviez-vous.json`.** Ne jamais
  énoncer de tarif : la participation suit le **barème national CNAF** (§8.1). La règle
  `creche` est placée **avant** `centre_loisirs`, dont le motif attrape déjà `creche` et
  `marmousets`, et **après** `laep`. Verrouillé par `test/creche.test.js`. Quatre endroits
  à garder en phase : la règle `creche` + le bloc CRÈCHE du `SYSTEM_PROMPT` ici, les deux
  copies de l'arbre (`app-mezieres/data/mel-tree.json` **et** `app-mezieres/js/mat-mel.js`),
  la fiche `periscolaire` de `app-mezieres/js/mat-guide-arrivee.js`, et les entrées
  `marmousets-*` de `app-mezieres/data/saviez-vous.json`.
- ⚠️ **LAEP : ni un mode de garde, ni un service communal.** Le Lieu d'Accueil
  Enfants-Parents de la CCTVL (ouverture le 7 septembre 2026) est **itinérant** —
  Beauce la Romaine, Beaugency, Cléry-Saint-André, Meung-sur-Loire — et **ne passe pas
  par Mézières** ; l'adulte accompagnant **reste avec l'enfant**. Même piège que la crèche
  Les Marmousets (intercommunale, longtemps annoncée comme communale). Le **planning des
  créneaux n'était pas encore publié au 25 août 2026** ; quand il paraîtra, ses **jours et
  horaires ne devront être recopiés nulle part** — ils changeront sans préavis, et
  `test/laep.test.js` refuse tout horaire ou jour de semaine dans la réponse. On renvoie
  vers les renseignements du service : **06 62 65 59 04**, laep@ccterresduvaldeloire.fr.
  La règle `laep` est placée **avant** `centre_loisirs` (un LAEP n'est pas un accueil de
  loisirs). Quatre endroits à garder en phase : la règle `laep` + le bloc LAEP du
  `SYSTEM_PROMPT` ici, les deux copies de l'arbre de décision
  (`app-mezieres/data/mel-tree.json` **et** `app-mezieres/js/mat-mel.js`), et la fiche
  `periscolaire` de `app-mezieres/js/mat-guide-arrivee.js`. Voir
  `app-mezieres/docs/adr/0028-laep-…`.
- ⚠️ **Cerfa d'urbanisme : un numéro de formulaire meurt sans faire de bruit.** Au
  **1er janvier 2025**, les cerfa **13703** (DP maison individuelle), **13702** (DP
  lotissement) et **13404** (DP constructions et travaux) ont été **abrogés** ; ce sont
  désormais le **16702** (constructions et travaux — clôture, abri de jardin, extension,
  ravalement) et le **16703** (aménagements : lotissement, division de terrain). Le permis
  de construire reste le **13406**. MEL conseillait encore le 13703 le 27 août 2026 : un
  dossier déposé sur ce formulaire est **refusé**. Découvert par le scan de liens morts
  (404 sur la fiche `R11646`, côté app), qui n'était que le symptôme visible — trois autres
  endroits portaient le fait périmé sans aucun lien pour les trahir. ⚠️ **Ne jamais écrire
  de millésime** (« 16702\*02 ») : seul le numéro à 5 chiffres est stable. Les numéros
  abrogés ne sont admis dans `lib/mel.js` que sur la ligne qui les déclare ABROGÉS — le
  `SYSTEM_PROMPT` doit les nommer pour les interdire. Verrouillé par
  `test/urbanisme-cerfa.test.js`. Quatre endroits à garder en phase : la règle
  `plu_permis_construire_depot` + le bloc AUTORISATIONS du `SYSTEM_PROMPT` ici,
  `app-mezieres/js/mat-mel.js` (`pluAuthLink`), et les entrées `cloture-dp` /
  `gnau-cerfa-cloture` de `app-mezieres/data/saviez-vous.json`. Voir
  `app-mezieres/docs/adr/0029-…`.
- ⚠️ **Ne JAMAIS recopier les tarifs de location dans `lib/mel.js`.** Les prix (tables,
  chaises, barnums, caution) vivent dans l'arbre de décision, **que la mairie édite depuis
  l'admin sans passer par le code**. Les dupliquer ici créerait une double source vouée à
  diverger au premier changement de tarif, en silence. La règle nomme le matériel et
  renvoie à la mairie pour les montants ; `test/location-salle.test.js` refuse tout
  montant en euros dans la réponse.

> 📦 Le **guide d'arrivée des nouveaux habitants** est une page de l'app (repo
> `app-mezieres`, `js/mat-guide-arrivee.js`) : contenu embarqué en statique, consultable
> hors-ligne, **aucune route ni clé Redis côté backend**. Le backend n'intervient que par
> les `DIRECT_RULES` ci-dessus, pour que MEL sache répondre à la même question en langage
> naturel. Les deux doivent rester cohérents.

## Liens des réponses — vérification automatique

- Les adresses citées dans les réponses vieillissent sans prévenir. Le workflow
  `.github/workflows/liens-morts.yml` (lundi 07h30 UTC + `workflow_dispatch`) scanne
  `lib/`, `routes/` et la doc avec lychee, et **ouvre une issue** `liens-morts` si
  quelque chose casse. Le pendant existe dans `app-mezieres` pour les `.html` et `js/`.
- ⚠️ **Une seule issue vivante à la fois.** Le workflow cherche d'abord une issue
  `liens-morts` ouverte et passe son numéro à `create-issue-from-file` : rapport mis à
  jour au lieu d'une nouvelle issue à chaque passage. Il la **referme** aussi quand le
  scan repasse au vert. Sans ce garde-fou, chaque exécution hebdomadaire en créait une
  de plus — #176 et #181 étaient identiques mot pour mot, à un jour d'intervalle.
- ⚠️ **Un « TIMEOUT » n'est pas un lien mort.** Le scan du 24 août 2026 a ouvert l'issue
  #201 sur trois expirations (`R11193` ×2, `R16396`) : trois pages parfaitement vivantes.
  lychee lance par défaut **128 requêtes en parallèle** et abandonne au bout de **20 s** ;
  `service-public.gouv.fr`, de loin le domaine le plus cité par MEL, étrangle la rafale.
  Le scan du dépôt `app-mezieres`, dix minutes plus tôt et sur moins d'URL, obtenait du
  même domaine un 404 bien net — c'est la charge, pas le domaine. Les deux workflows
  passent donc `--max-concurrency 8 --timeout 30`. Avant d'exclure quoi que ce soit sur la
  foi d'une expiration, relire cette ligne : un faux positif coûte plus cher qu'un scan
  lent, il faut le ré-instruire à la main et il apprend à se méfier du signal.
- ⚠️ **Ne jamais écrire d'adresse factice** — schéma `https` suivi de points de
  suspension ou d'un domaine d'exemple — **dans `lib/`, `routes/` ou un `.md` de la
  racine** : ces fichiers sont scannés, **commentaires compris**. lychee l'extrait comme
  une vraie adresse et échoue à la **parser** ; or une erreur de parsing ne peut **pas**
  être neutralisée par `--exclude`, qui ne filtre que des URL déjà parsées. C'est le
  dernier faux positif de #181 : le message de `routes/docs.js` illustrait le format
  attendu par un simulacre d'URL. L'exclusion ancrée ajoutée pour ça n'a rien changé
  (scan du 10 août : toujours signalé), donc l'issue ne pouvait pas se refermer toute
  seule. Seule issue : reformuler le texte — « url (adresse en https) ». Décrire le
  format en toutes lettres.
- Origine : la règle `fibre` annonçait `valdeloire-fibre.fr`, un domaine qui **n'existe
  pas** (échec DNS), et la règle CNI renvoyait vers le site d'une seule commune. Rien ne
  le détectait — le scan de `app-mezieres` ne couvrait que ses pages HTML.
- ⚠️ **Opérateur fibre = Lysséo** (`https://lysseo.fr`), pas « Val de Loire Fibre » : ce
  dernier dessert l'Indre-et-Loire et le Loir-et-Cher, pas le Loiret. L'arbre de décision
  de MEL (`app-mezieres/js/mat-mel.js`) le disait déjà — c'était une **double source
  divergente**, la même classe de problème que pour les associations.
- ⚠️ **Lysséo n'est PAS un fournisseur d'accès** — corrigé le 3 août 2026, voir
  `app-mezieres/docs/adr/0013-fibre-…`. C'est l'**opérateur d'infrastructure** du réseau
  public fibre du Loiret (exploité par Loiret THD / Loiret Fibre, groupe XpFibre, en DSP du
  Département) : il ne vend **aucun** abonnement, l'habitant souscrit chez Orange, SFR,
  Bouygues, Free… Pour une **construction neuve**, l'étape bloquante est la déclaration de
  l'adresse auprès de XpFibre / Loiret THD (`https://www.xpfibre.com/loiret-thd`) : tant
  qu'elle n'est pas « raccordable », aucun opérateur ne peut enregistrer la commande. La
  mairie, elle, fait remonter la numérotation de la parcelle à la Base Adresse Nationale.
  Trois endroits doivent rester en phase : la règle `fibre` et le prompt du topic
  `numerique` de `lib/mel.js`, les trois entrées `numerique` de l'arbre de décision
  (`app-mezieres/js/mat-mel.js` **et** `app-mezieres/data/mel-tree.json`), et la fiche fibre
  de `app-mezieres/js/mat-guide-arrivee.js`.
- ⚠️ **`SOURCES` ne contient plus que des pages CCTVL.** Le domaine
  `mezieres-lez-clery.fr` sert désormais l'application : l'ancien site WordPress
  n'existe plus, et ses 20 pages référencées ici renvoyaient toutes 404. `buildContext`
  téléchargeait donc des pages d'erreur à chaque question sans rien injecter. Ne pas
  réintroduire d'URL `mezieres-lez-clery.fr/<chemin>` — le commentaire en tête de la
  constante explique le détail.

## Associations (grounding MEL)

- MEL ne doit JAMAIS inventer d'association : la liste officielle est la constante `ASSOCIATIONS`
  de `lib/mel.js`, injectée dans son contexte pour le topic `associations` + garde-fou dans le
  prompt système (règle 7).
- ⚠️ **Double source à garder en phase** : `lib/mel.js` `ASSOCIATIONS` (connaissance de MEL) et
  `app-mezieres/js/mat-associations.js` (affichage habitant). Les **catégories** (sport, animation…)
  viennent de la mairie et ne se déduisent pas des descriptions. (Évolution possible : un
  `data/associations.json` partagé pour supprimer la double source.)

## Robustesse Redis

- Toujours tolérer un Redis en mode dégradé (429 Upstash) : voir `_isRedis429` et les
  `.catch(() => {})` sur les écritures non critiques. Ne jamais faire dépendre une
  réponse HTTP d'une écriture Redis best-effort.
- **Quota (10 000 commandes/jour, plan gratuit)** : aucun cron fréquent ne doit
  interroger Redis à chaque tick. Pattern à suivre : cache mémoire mis à jour par les
  routes d'écriture + re-synchro Redis périodique (voir `readScheduled`/`writeScheduled`
  dans `routes/admin-actus.js`, le buffer stats de `lib/store.js`, et l'ADR-0007).
  La consommation attendue est de quelques centaines de commandes/jour — si le mail
  quotidien annonce des milliers, chercher un polling Redis dans un `setInterval`.

## ⛔ Édition de fichiers — règles non négociables

**Incident du 1ᵉʳ août 2026 (dépôt `app-mezieres`, même classe d'erreur possible ici) :**
un fichier de documentation est passé de 41 Ko à 85 Mo et a été poussé sur `main` sans
que personne ne le voie. Une substitution par script dont le motif matchait la **chaîne
vide** a inséré son bloc de remplacement entre *chaque caractère* du fichier — 39 508
copies, contenu réel entièrement détruit. Détecté seulement 2 versions plus tard.
Voir `app-mezieres/docs/adr/0009-edition-de-fichiers-verifier-avant-de-commiter.md`.

Ce qui a permis le désastre : le fichier n'a jamais été rouvert après modification, et
`git add -A` ne dit rien de la taille de ce qu'il ajoute.

**Règles :**

1. **Utiliser l'outil `Edit`** pour modifier un fichier existant. Il échoue proprement
   si le motif est absent ou ambigu — un script de substitution, non.
2. **Ne jamais** faire de `re.sub` / `sed` / `.replace()` sur un fichier entier via un
   script sans avoir vérifié que le motif ne peut pas matcher la chaîne vide
   (`*`, `?`, `{0,n}`, alternance avec branche vide…).
3. **Après toute édition automatisée, vérifier avant de commiter** :
   ```bash
   ls -la <fichier> && wc -l <fichier>
   git diff --stat --cached
   ```
   Une variation de taille sans rapport avec l'ampleur du changement = STOP.
4. Ne pas se fier au succès d'un script pour conclure que le résultat est correct :
   **relire le fichier**.
