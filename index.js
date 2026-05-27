const express   = require("express");
const axios     = require("axios");
const https     = require("https");
const Anthropic = require("@anthropic-ai/sdk");
const webpush   = require("web-push");
const cloudinary = require("cloudinary").v2;
const rateLimit = require("express-rate-limit");

// Timeout global sur tous les appels axios sortants (8 s)
axios.defaults.timeout = 8000;

const app = express();
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
// Body parsing : limite stricte par défaut (256 KB) pour les routes JSON
// usuelles (/mel, /push/*, /stats/*, /webhook, etc.). Override 6 MB sur les
// routes qui transportent des photos en base64 (signalement citoyen, ajout
// d'actu admin, création/édition d'entreprise admin).
// Express ne désactive pas strict-routing par défaut : /signal et /signal/
// résolvent au même handler. On normalise donc le slash final pour que
// l'override large ne soit pas contourné par un client mettant un trailing
// slash et reçoive un 413 inattendu.
function _isLargeBodyRoute(p) {
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/signal") return true;
  if (p === "/admin/actus/add") return true;
  if (p === "/admin/entreprises" || p.startsWith("/admin/entreprises/")) return true;
  return false;
}
