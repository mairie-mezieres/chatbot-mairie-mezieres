// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 Commune de Mezieres-lez-Clery
"use strict";

// Mappe le nom d'une liste Trello vers un statut citoyen normalise.
// Partage entre la lecture du suivi (routes/signalements.js) et le webhook
// Trello (routes/trello-webhook.js) pour garantir une logique identique.
function trelloStatusFromListName(name) {
  const n = (name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/resolu|termine|done|ferme|clos|\btraites?\b/.test(n)) return 'resolved';
  if (/cours|progress|traitement/.test(n)) return 'in_progress';
  return 'pending';
}

module.exports = { trelloStatusFromListName };
