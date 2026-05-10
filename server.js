const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PORT                 = process.env.PORT || 3000;

// Stockage en mémoire des tokens valides (1h)
const validTokens = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function cleanExpiredTokens() {
  const now = Date.now();
  for (const [token, expiry] of validTokens.entries()) {
    if (now > expiry) validTokens.delete(token);
  }
}

function verifyStripeSignature(payload, signature, secret) {
  try {
    const parts = signature.split(',').reduce((acc, part) => {
      const [key, val] = part.split('=');
      acc[key] = val;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const sig = parts['v1'];
    const signedPayload = `${timestamp}.${payload}`;
    const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch(e) {
    return false;
  }
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const server = http.createServer(async (req, res) => {

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // Sert le HTML pour toutes les pages sauf /api et /webhook
  if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/webhook')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // Webhook Stripe — reçoit la confirmation de paiement
  if (req.method === 'POST' && req.url === '/webhook') {
    const body = await readBody(req);
    const signature = req.headers['stripe-signature'];

    if (!verifyStripeSignature(body.toString(), signature, STRIPE_WEBHOOK_SECRET)) {
      console.log('Webhook signature invalide');
      res.writeHead(400);
      return res.end('Invalid signature');
    }

    const event = JSON.parse(body.toString());
    if (event.type === 'payment_intent.succeeded') {
      const token = generateToken();
      validTokens.set(token, Date.now() + 60 * 60 * 1000); // valide 1h
      console.log('Paiement confirmé, token généré');

      // Récupère l'URL de retour depuis les métadonnées
      const returnUrl = event.data.object.metadata?.return_url || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token, returnUrl }));
    }

    res.writeHead(200);
    return res.end('OK');
  }

  // Vérifie si un token est valide
  if (req.method === 'POST' && req.url === '/api/verify-token') {
    cleanExpiredTokens();
    const body = await readBody(req);
    const { token } = JSON.parse(body.toString());
    const valid = validTokens.has(token);
    if (valid) validTokens.delete(token); // usage unique
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ valid }));
  }

  // Génère l'aperçu (gratuit, sans token)
  if (req.method === 'POST' && req.url === '/api/preview') {
    const body = await readBody(req);
    const { prompt } = JSON.parse(body.toString());
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Génère le verdict via Claude
  if (req.method === 'POST' && req.url === '/api/verdict') {
    const body = await readBody(req);
    const { prompt, token } = JSON.parse(body.toString());

    // Vérifie le token avant de générer
    cleanExpiredTokens();
    if (!token || !validTokens.has(token)) {
      res.writeHead(403, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Token invalide ou expiré' }));
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, CORS);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Tribunal ouvert sur le port ${PORT}`);
  console.log('Anthropic key:', !!ANTHROPIC_API_KEY);
  console.log('Webhook secret:', !!STRIPE_WEBHOOK_SECRET);
});
