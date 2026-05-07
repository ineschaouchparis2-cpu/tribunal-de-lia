// ============================================================
//  Le Tribunal de l'IA â€” Serveur backend
//
//  Les clÃ©s secrÃ¨tes sont lues automatiquement depuis
//  les variables d'environnement Railway.
//  Ne jamais Ã©crire de clÃ©s directement dans ce fichier.
// ============================================================

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const PORT              = process.env.PORT || 3000;

if (!ANTHROPIC_API_KEY || !STRIPE_SECRET_KEY) {
  console.error('âŒ Variables manquantes : ANTHROPIC_API_KEY et STRIPE_SECRET_KEY doivent Ãªtre dÃ©finies.');
  process.exit(1);
}

function stripeRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = new URLSearchParams(body).toString();
    const options = {
      hostname: 'api.stripe.com',
      path: endpoint,
      method,
      headers: {
        'Authorization': 'Bearer ' + STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/api/verdict') {
    const body = await readBody(req);
    const { prompt } = JSON.parse(body);
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
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/create-payment') {
    try {
      const intent = await stripeRequest('POST', '/v1/payment_intents', {
        amount: '99',
        currency: 'eur',
        payment_method_types: 'card'
      });
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ clientSecret: intent.client_secret }));
    } catch (e) {
      res.writeHead(500, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/verify-payment') {
    const body = await readBody(req);
    const { paymentIntentId } = JSON.parse(body);
    try {
      const intent = await stripeRequest('GET', `/v1/payment_intents/${paymentIntentId}`, {});
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: intent.status === 'succeeded' }));
    } catch (e) {
      res.writeHead(500, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false }));
    }
    return;
  }

  res.writeHead(404, headers);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`âœ… Tribunal ouvert sur le port ${PORT}`);
});