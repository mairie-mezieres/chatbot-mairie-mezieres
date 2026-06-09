# Note de conformité — Assistant virtuel MEL

**Commune de Mézières-lez-Cléry** (45370, Loiret)
**Objet :** application « Mézières Avec Toi » (MAT) — assistant conversationnel MEL
**Date :** 9 juin 2026 · **Version :** 1.0 · **Rédacteur :** service numérique
**Destinataire :** Délégué à la Protection des Données (DPO)

---

## 1. Description du système

MEL est un **assistant conversationnel d'information** intégré à l'application
municipale MAT. Il répond aux questions des habitants sur la vie communale
(urbanisme, démarches, déchets, école, associations, transports, événements) en
s'appuyant sur des sources documentaires publiques (site de la commune, CCTVL,
services de l'État). Il **informe et oriente** ; il ne prend aucune décision et
n'instruit aucun dossier.

**Architecture technique :** application web (PWA) appelant un serveur (Node.js,
hébergé chez Render). Le serveur relaie les questions à un **modèle d'IA tiers**
(Mistral AI, modèle *mistral-small*, hébergé en France/UE), avec repli Anthropic.
Aucun modèle n'est entraîné ni affiné par la commune.

---

## 2. Qualification au regard du Règlement européen sur l'IA (AI Act)

| Critère | Qualification |
|---|---|
| **Rôle de la commune** | **Déployeur** d'un système d'IA (et non fournisseur de modèle) |
| **Niveau de risque** | **Risque limité** (transparence) |
| **Système à haut risque ?** | **Non** |

**Justification du non-classement en haut risque :** l'annexe III de l'AI Act
classe à haut risque les systèmes utilisés par une autorité publique pour
*évaluer l'éligibilité à des prestations/services publics, ou les accorder,
réduire, révoquer ou récupérer*. MEL ne réalise aucune de ces opérations : il
fournit une information générale et renvoie systématiquement vers la mairie pour
toute décision. Il n'est donc **pas** un système à haut risque.

---

## 3. Obligations AI Act applicables — et leur statut

| Obligation | Base | Statut |
|---|---|---|
| **Transparence** : informer l'usager qu'il interagit avec une IA | Art. 50 | ✅ **Respectée** — MEL est présenté comme un assistant virtuel |
| **Littératie IA** : sensibilisation des agents gérant l'outil | Art. 4 (depuis fév. 2025) | ⚠️ **À tracer** — une note interne de sensibilisation suffit |

## 4. Obligations AI Act NON applicables

- **Tests contradictoires / red teaming obligatoires** : ils incombent aux
  **fournisseurs de modèles GPAI à risque systémique** (Mistral, Anthropic…),
  **pas au déployeur**. La commune n'y est pas tenue.
- **Évaluation de conformité, documentation technique, marquage** : réservées
  aux systèmes à haut risque. Non applicables.

---

## 5. Conformité RGPD (cadre distinct de l'AI Act)

| Élément | Situation |
|---|---|
| **Responsable de traitement** | Commune de Mézières-lez-Cléry |
| **Sous-traitants** | Mistral AI, Anthropic (modèle), Render (hébergement), Upstash (stockage) |
| **Données traitées** | Contenu des questions ; identifiant technique d'appareil ; adresse IP (sécurité/quota) |
| **Finalité** | Renseigner les habitants ; prévenir l'abus du service |
| **Base légale** | Mission d'intérêt public (art. 6.1.e RGPD) |
| **Journalisation des questions** | **Désactivée par défaut.** Si activée : conservation **90 jours**, susceptible de contenir des données personnelles → **AIPD requise avant activation** |
| **Durées de conservation** | Quotas : ~26 h · Cache de réponses : 24 h–7 j · Journaux : 90 j (si activés) |
| **Droits des personnes** | À exercer auprès de la mairie / du DPO |

**Recommandation RGPD :** inscrire le traitement au **registre**, publier une
**mention d'information** (ex. dans MAT et sur le site), et **réaliser une AIPD
avant toute activation de la journalisation** des questions.

---

## 6. Mesures de sécurité techniques en place

- Filtrage strict des rôles de message (blocage des injections « système »).
- Détection des tentatives de manipulation (FR/EN, Base64, leetspeak) + blocage.
- Clause d'instructions non modifiables (résistance usurpation/jeu de rôle).
- Règle anti-hallucination renforcée sur les sujets sensibles (urbanisme, droit,
  aides, données personnelles, état civil).
- Neutralisation du contenu externe (agenda, pages web) avant traitement.
- Limitation de débit (30 req/min/IP) + quota journalier par appareil et par IP.
- Secrets (clés API, mots de passe) strictement côté serveur, jamais exposés.
- Réponses informatives **sans valeur juridique** (mention explicite à l'IA).

---

## 7. Synthèse

> La commune, en tant que **déployeur** d'un système d'IA à **risque limité**,
> n'est soumise à **aucune obligation de test ou d'évaluation de conformité au
> titre de l'AI Act**. Sa seule obligation — la **transparence** — est remplie.
> L'enjeu principal de conformité relève du **RGPD** (registre, information,
> AIPD conditionnelle), et non de l'AI Act.

---

*Document interne d'auto-évaluation. Il ne constitue pas un avis juridique et
doit être validé par le DPO de la collectivité (le cas échéant mutualisé via le
Centre de Gestion ou la CCTVL).*
