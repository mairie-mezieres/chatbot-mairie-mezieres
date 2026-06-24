# ADR-0001 — Trello comme gestionnaire de signalements, demandes et bugs

- **Date** : mai 2024
- **Statut** : Accepté

## Contexte

Les signalements, demandes de service et rapports de bugs soumis par les habitants via
l'app doivent être traités par l'équipe municipale. Il faut un outil de suivi des tâches
avec :

- Interface accessible à des agents non-techniques.
- Notification automatique du citoyen quand le statut change.
- Hébergement externe (pas de serveur supplémentaire à administrer).
- Coût nul ou négligeable pour une commune rurale.

## Décision

Nous utilisons **Trello** (plan gratuit) comme backend de gestion des signalements :

- Chaque soumission crée une carte dans la liste correspondante (`SIG`, `BUG`, `DEMANDE`).
- Le statut du signalement est représenté par la **liste Trello** dans laquelle se trouve
  la carte (« À traiter », « En cours », « Résolu »).
- La carte porte un marqueur `MAT-REF: {uuid}` dans sa description pour lier la carte
  au token push du citoyen (voir ADR-0002).
- Un **webhook Trello** (`POST /trello/webhook`) notifie le backend de tout déplacement
  de carte ou ajout de commentaire, déclenchant un push Web Push vers le citoyen.

## Conséquences

**Positives :**
- Interface Kanban familière pour les agents ; aucune formation spécifique requise.
- Gratuité du plan Trello pour le volume de cartes d'une commune rurale.
- L'API Trello permet la création de cartes, l'ajout de pièces jointes (photos) et la
  gestion des webhooks de façon programmatique.
- Pas de base de données relationnelle supplémentaire à maintenir.

**Négatives / compromis acceptés :**
- Dépendance à un service tiers (Trello/Atlassian) : une panne ou un changement de
  politique tarifaire impacte les signalements.
- Les cartes créées manuellement dans Trello (sans `MAT-REF`) ne déclenchent pas de
  notification push — limitation documentée et acceptée.
- La sémantique « liste = statut » suppose une discipline d'usage côté agents : ne pas
  créer de listes libres sans en informer l'équipe technique.

**Points de vigilance pour les futures évolutions :**
- Si le volume de signalements dépasse le plan gratuit, envisager un plan payant ou une
  migration vers un outil souverain (Nextcloud Deck, plane.so…) via un ADR dédié.
- Le webhook Trello doit rester enregistré sur le bon board après tout changement d'URL
  du backend (vérifiable via l'onglet 🧪 Services du tableau de bord admin).
