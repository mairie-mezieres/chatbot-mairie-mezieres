// MAT — Mézières Avec Toi · Serveur Render v6.5
// Mistral principal + cache + réponses directes + fallback Claude
// Facebook feed only (plus de MEL sur Messenger)
// ════════════════════════════════════════════════════════════

const express   = require("express");
const axios     = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const webpush   = require("web-push");
const cloudinary = require("cloudinary").v2;
const rateLimit = require("express-rate-limit");

// Timeout global sur tous les appels axios sortants (8 s)
axios.defaults.timeout = 8000;

const app = express();
app.use(express.json({ limit: "10mb" }));
app.set('trust proxy', true); // Render est derrière un reverse proxy
