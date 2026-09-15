/* Re-vérification des liens signalés par lychee — scripts/verifier-liens-signales.js
 *
 * Ce que le test verrouille (issue #450 de app-mezieres) :
 *  - un 403 servi AU ROBOT mais pas au navigateur est un FAUX POSITIF : il sort
 *    du rapport ;
 *  - un 403 qui PERSISTE malgré les en-têtes de navigateur n'est toujours pas un
 *    lien mort (issue #453, xpfibre.com) : Cloudflare regarde aussi l'empreinte
 *    TLS et le protocole, qu'aucun script ne peut imiter. Il est déclaré
 *    « invérifiable », pas « cassé », et n'ouvre donc pas d'issue ;
 *  - un vrai 404 reste, quoi qu'il arrive ;
 *  - une erreur non-HTTP (fichier local introuvable) reste : c'était la seule
 *    vraie erreur de #450, et elle se noyait dans trois faux positifs ;
 *  - une même URL signalée depuis deux fichiers n'est testée qu'UNE fois
 *    (lychee la recompte en « Error (cached) ») ;
 *  - c'est `restants` — et non le code de sortie de lychee — qui pilote le workflow.
 *
 * Aucun appel réseau sortant : un serveur HTTP local joue les trois cas.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

/* ⚠️ `execFileSync` BLOQUE le processus de test — donc le serveur HTTP monté
   plus bas, qui vit dans ce même processus, ne répondrait jamais : les deux URL
   expireraient au bout de 30 s et le test « prouverait » l'inverse de ce qu'il
   vérifie (mesuré : 124 s, faux positif conservé). Version asynchrone obligatoire. */
const lancer = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verifier-liens-signales.js');

function demarrerServeur() {
  return new Promise((resolve) => {
    const serveur = http.createServer((req, res) => {
      const ua = req.headers['user-agent'] || '';
      if (req.url === '/bloque-aux-robots') {
        // Exactement le comportement de xpfibre.com / chaiamandineetquentin.fr :
        // 403 sans en-têtes de navigateur, 200 avec.
        if (/Mozilla\/5\.0/.test(ua) && req.headers['accept-language']) {
          res.writeHead(200); return res.end('page');
        }
        res.writeHead(403); return res.end('refus');
      }
      // Le cas xpfibre : 403 quoi qu'on envoie comme en-têtes — la page est
      // pourtant vivante pour un habitant.
      if (req.url === '/bloque-toujours') { res.writeHead(403); return res.end('refus'); }
      if (req.url === '/vraiment-mort') { res.writeHead(404); return res.end('nope'); }
      res.writeHead(500); res.end();
    });
    serveur.listen(0, '127.0.0.1', () => resolve(serveur));
  });
}

test('un 403 servi au robot mais pas au navigateur sort du rapport ; le reste y demeure', async () => {
  const serveur = await demarrerServeur();
  const base = `http://127.0.0.1:${serveur.address().port}`;
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'liens-'));
  const jsonPath = path.join(dossier, 'rapport.json');
  const mdPath = path.join(dossier, 'rapport.md');
  const sortie = path.join(dossier, 'github_output');

  fs.writeFileSync(jsonPath, JSON.stringify({
    total: 12, successful: 8, errors: 4,
    error_map: {
      'lib/mel.js': [
        { url: `${base}/bloque-aux-robots`, status: { code: 403, text: 'Rejected status code (403 Forbidden)' } },
        { url: `${base}/bloque-toujours`, status: { code: 403, text: 'Rejected status code (403 Forbidden)' } },
        { url: `${base}/vraiment-mort`, status: { code: 404, text: 'Rejected status code (404 Not Found)' } },
      ],
      // La même URL, recomptée depuis un autre fichier — cas « Error (cached) ».
      'routes/eau.js': [{ url: `${base}/bloque-aux-robots`, status: 'Error (cached)' }],
      'page.html': [{ url: 'file:///introuvable.jpg', status: { text: 'File not found' } }],
    },
  }));

  try {
    await lancer('node', [SCRIPT, jsonPath, mdPath], {
      env: { ...process.env, GITHUB_OUTPUT: sortie },
      encoding: 'utf8',
    });
  } finally {
    serveur.close();
  }

  const rapport = fs.readFileSync(mdPath, 'utf8');
  const out = fs.readFileSync(sortie, 'utf8');

  // Le 404 et le fichier local restent ; le 403 est écarté du corps du rapport.
  assert.match(rapport, /vraiment-mort/, 'un vrai 404 doit rester dans le rapport');
  assert.match(rapport, /file:\/\/\/introuvable\.jpg/, 'une erreur non-HTTP doit rester');
  assert.match(rapport, /<details>[\s\S]*bloque-aux-robots/,
    'le faux positif doit être relégué dans le bloc repliable, pas dans les erreurs');

  // Le 403 qui persiste : présent dans le rapport, mais dans le bloc des refus
  // aux robots — jamais dans le corps des erreurs, qui seul ouvre l'issue.
  const corps = rapport.split('<details>')[0];
  assert.doesNotMatch(corps, /bloque-toujours/,
    'un 403 persistant ne doit PAS compter comme un lien cassé (issue #453)');
  assert.match(rapport, /refuse de servir à un robot[\s\S]*bloque-toujours/,
    'un 403 persistant doit rester visible dans le bloc « refus aux robots »');
  assert.match(out, /^bloques=1$/m, `sortie inattendue : ${out}`);

  // Deux entrées restantes (le 404 et le fichier), pas cinq.
  assert.match(out, /^restants=2$/m, `sortie inattendue : ${out}`);

  fs.rmSync(dossier, { recursive: true, force: true });
});

test('aucune erreur : restants=0, donc le workflow referme l’issue', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'liens-'));
  const jsonPath = path.join(dossier, 'rapport.json');
  const mdPath = path.join(dossier, 'rapport.md');
  const sortie = path.join(dossier, 'github_output');
  fs.writeFileSync(jsonPath, JSON.stringify({ total: 5, successful: 5, errors: 0, error_map: {} }));

  await lancer('node', [SCRIPT, jsonPath, mdPath], {
    env: { ...process.env, GITHUB_OUTPUT: sortie },
    encoding: 'utf8',
  });

  assert.match(fs.readFileSync(sortie, 'utf8'), /^restants=0$/m);
  assert.match(fs.readFileSync(mdPath, 'utf8'), /Aucun lien réellement cassé/);
  fs.rmSync(dossier, { recursive: true, force: true });
});
