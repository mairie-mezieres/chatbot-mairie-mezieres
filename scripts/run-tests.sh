#!/usr/bin/env bash
# Exécute chaque fichier de test en mode STANDALONE (node:test sans le runner
# parent `node --test`) : contourne un bug du runner de Node 22.23.x observé
# en CI — « Unable to deserialize cloned data due to invalid or unsupported
# version », corruption de l'IPC parent/enfant au milieu de routes.test.js.
# En standalone il n'y a ni processus parent ni IPC : le bug ne peut pas se
# produire, et on garde la même isolation (un processus par fichier).
# Prérequis : tous les setInterval de niveau module sont unref() (cf. CLAUDE.md),
# sinon un fichier ne rend pas la main.
set -e
for f in scripts/smoke-test.js test/*.test.js; do
  echo "== ${f}"
  node "${f}"
done
echo "✅ Tous les fichiers de test sont verts."
