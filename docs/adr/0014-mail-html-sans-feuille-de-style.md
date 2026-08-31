# ADR-0014 — Un mail HTML ne peut pas compter sur une feuille de style

**Date** : 2026-08-31
**Statut** : accepté

## Contexte

Le rapport de statistiques quotidien (`routes/admin-email.js`, envoyé par Resend)
arrivait **en texte brut** : les chiffres et les libellés étaient bien là, mais
sans cartes, sans pastilles vertes, sans couleurs — un empilement de lignes.

Le gabarit posait pourtant toute sa mise en forme dans un bloc `<style>` du
`<head>`, référencé par des classes (`.card`, `.stat`, `.grid`, `.q`…) :

```html
<head><meta charset="UTF-8"><style>
  .card{background:#fff;border-radius:12px;padding:20px;…}
  .stat{background:#d8f3dc;border-radius:8px;padding:12px;text-align:center}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
</style></head>
<body>
  <div class="card"><div class="grid"><div class="stat">…</div></div></div>
```

Ce HTML est parfaitement valide, et il s'affiche correctement dans un navigateur
— c'est bien là le piège : **le seul endroit où on le teste est le seul endroit
où il fonctionne**. Une bonne partie des clients de messagerie supprime le bloc
`<style>` à la réception (Gmail selon le type de compte et l'application,
Outlook.com, Yahoo, plusieurs applis mobiles). Une fois ce bloc retiré, les
classes ne peignent plus rien : il ne reste que le texte des `<div>`. Le mail
n'est pas « cassé » au sens d'une erreur — il est simplement **dépouillé**, et
c'est indistinguable d'un mail en texte brut.

Deuxième couche du même problème : `display:grid` et `display:flex` sont ignorés
par Outlook (moteur de rendu Word). Même en conservant le bloc `<style>`, les
pastilles de chiffres s'y empilaient en colonne.

Enfin, le payload Resend ne portait **que** `html`, sans variante `text` : un
client réglé pour préférer le texte n'avait rien de propre à afficher.

## Décision

Le gabarit du mail de stats suit les trois règles du HTML d'e-mail :

1. **Aucune feuille de style, aucune classe.** Tout style s'écrit en attribut
   `style=` sur l'élément qu'il peint. Corollaire non évident : chaque `<td>`
   porteur de texte déclare **sa propre** `font-family`, car sous Outlook une
   cellule de tableau n'hérite pas de celle de `<body>`.
2. **La mise en page repose sur des `<table>`**, pas sur `grid` ni `flex`. Les
   helpers `card()`, `statCell()` et `statGrid()` produisent l'équivalent exact
   des anciennes classes `.card` / `.stat` / `.grid`, en tables imbriquées.
3. **Le payload Resend porte `html` *et* `text`.** La variante texte est un vrai
   rapport lisible (sections en capitales, listes à tirets), pas un pis-aller.

L'apparence visée est inchangée : mêmes couleurs, mêmes cartes, mêmes pastilles.
Seule la manière de les décrire change. Les tailles en `rem` sont converties en
`px`, `rem` n'étant pas fiable en messagerie.

## Conséquences

- `test/email-stats-format.test.js` intercepte `axios.post` et refuse un gabarit
  qui réintroduirait un bloc `<style>`, un attribut `class=`, une mise en page
  `grid`/`flex`, une cellule dimensionnée sans police, ou un envoi sans `text`.
- Écrire du HTML d'e-mail coûte plus cher qu'écrire une page : c'est le prix à
  payer pour que le rendu ne dépende pas du client de réception. Ne pas
  « simplifier » en réintroduisant une feuille de style — elle marchera dans le
  navigateur, et nulle part ailleurs.
- Tout nouveau mail envoyé par le backend suit les mêmes règles.

## Alternatives écartées

- **Un outil d'*inlining* CSS** (juice, premailer) : une dépendance de plus, un
  temps de build, et un résultat qu'on ne relit pas. Le gabarit tient en un
  fichier ; les helpers suffisent.
- **Garder le bloc `<style>` en doublon des styles inline** : il ne servirait
  qu'aux clients qui le gardent, tout en laissant croire qu'on peut y déclarer
  quelque chose d'utile. Deux sources vouées à diverger.
- **N'envoyer que du texte** : le rapport perdrait sa lecture en un coup d'œil
  (pastilles, seuils de couleur du quota Redis).
