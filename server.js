const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PORT                  = process.env.PORT || 3000;

// Tokens valides aprÃ¨s paiement confirmÃ© (1h)
const validTokens = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function stripePost(endpoint, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const options = {
      hostname: 'api.stripe.com',
      path: endpoint,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function verifyWebhook(payload, signature, secret) {
  try {
    const parts = Object.fromEntries(signature.split(',').map(p => p.split('=')));
    const signed = `${parts.t}.${payload}`;
    const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch { return false; }
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
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
    res.writeHead(204, CORS); return res.end();
  }

  // Sert le HTML pour toutes les pages
  if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/webhook')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // CrÃ©e une session Stripe Checkout
  if (req.method === 'POST' && req.url === '/api/create-checkout') {
    const body = await readBody(req);
    const { pendingId } = JSON.parse(body.toString());
    const origin = req.headers.origin || `https://tribunal-de-lia.onrender.com`;
    try {
      const session = await stripePost('/v1/checkout/sessions', {
        'payment_method_types[0]': 'card',
        'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][product_data][name]': 'Verdict complet â€” Tribunal du Web',
        'line_items[0][price_data][unit_amount]': '99',
        'line_items[0][quantity]': '1',
        'mode': 'payment',
        'success_url': `${origin}/?paid=${pendingId}`,
        'cancel_url': `${origin}/`
      });
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: session.url }));
    } catch(e) {
      console.error('Checkout error:', e.message);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Webhook Stripe â€” confirme le paiement
  if (req.method === 'POST' && req.url === '/webhook') {
    const body = await readBody(req);
    const sig = req.headers['stripe-signature'];
    if (!verifyWebhook(body.toString(), sig, STRIPE_WEBHOOK_SECRET)) {
      res.writeHead(400); return res.end('Invalid signature');
    }
    const event = JSON.parse(body.toString());
    if (event.type === 'checkout.session.completed') {
      const successUrl = event.data.object.success_url || '';
      const match = successUrl.match(/paid=([a-zA-Z0-9_-]+)/);
      if (match) {
        const pendingId = match[1];
        validTokens.set(pendingId, Date.now() + 60 * 60 * 1000);
        console.log('Paiement confirmÃ© pour:', pendingId);
      }
    }
    res.writeHead(200); return res.end('OK');
  }

  // VÃ©rifie si une session Stripe est payÃ©e directement via l'API
  if (req.method === 'POST' && req.url === '/api/check-payment') {
    const body = await readBody(req);
    const { pendingId } = JSON.parse(body.toString());

    // D'abord vÃ©rifie le token local (si webhook a dÃ©jÃ  traitÃ©)
    const expiry = validTokens.get(pendingId);
    if (expiry && Date.now() < expiry) {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ paid: true }));
    }

    // Sinon vÃ©rifie directement auprÃ¨s de Stripe
    try {
      const sessions = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'api.stripe.com',
          path: `/v1/checkout/sessions?limit=10`,
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY }
        };
        const req2 = https.request(options, res2 => {
          let data = '';
          res2.on('data', c => data += c);
          res2.on('end', () => resolve(JSON.parse(data)));
        });
        req2.on('error', reject);
        req2.end();
      });

      // Cherche une session avec success_url contenant pendingId et statut paid
      const paid = sessions.data?.some(s =>
        s.payment_status === 'paid' &&
        s.success_url?.includes(pendingId)
      );

      if (paid) {
        validTokens.set(pendingId, Date.now() + 60 * 60 * 1000);
      }

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paid: !!paid }));
    } catch(e) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paid: false }));
    }
    return;
  }

  // GÃ©nÃ¨re l'aperÃ§u (gratuit)
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
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json();
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GÃ©nÃ¨re le verdict complet (payant)
  if (req.method === 'POST' && req.url === '/api/verdict') {
    const body = await readBody(req);
    const { prompt, pendingId } = JSON.parse(body.toString());
    const expiry = validTokens.get(pendingId);
    if (!expiry || Date.now() > expiry) {
      res.writeHead(403, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Paiement non vÃ©rifiÃ©' }));
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
      validTokens.delete(pendingId); // usage unique
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
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
  console.log('Stripe key:', !!STRIPE_SECRET_KEY);
  console.log('Webhook secret:', !!STRIPE_WEBHOOK_SECRET);
});