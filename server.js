// server.js
// Full implementation: /api/config, /api/generate-client-token, /api/payment-tokens,
// /api/orders (initial), /api/orders/oneclick (Create+Capture, idempotent-ish),
// /api/orders/:orderId/capture
//
// NOTE: This example uses an in-memory idempotency map for simplicity. In production,
// store idempotency state in a DB or cache (Redis) with expiration.

const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_API_BASE = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory idempotency map: key -> { orderId, capture, createdAt }
// Key should be PayPal-Request-Id or merchant-provided id; in real infra use Redis/DB.
const idempotencyStore = new Map();
const IDEMPOTENCY_TTL_MS = 1000 * 60 * 60; // 1 hour for demo; adjust in prod

function requireEnv() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set');
  }
}

async function getPayPalAccessToken() {
  requireEnv();
  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const resp = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'grant_type=client_credentials'
    });
    return resp.data.access_token;
  } catch (err) {
    console.error('getPayPalAccessToken error:', err.response?.data || err.message);
    throw err;
  }
}

// Generate id_token (response_type=id_token); supports target_customer_id for Returning Payer
async function generateUserIdToken(customerId = null) {
  requireEnv();
  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    let postData = 'grant_type=client_credentials&response_type=id_token';
    if (customerId) postData += `&target_customer_id=${encodeURIComponent(customerId)}`;

    const resp = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      data: postData
    });

    return { id_token: resp.data.id_token, access_token: resp.data.access_token };
  } catch (err) {
    console.error('generateUserIdToken error:', err.response?.data || err.message);
    throw err;
  }
}

// Cleanup expired idempotency entries (simple)
function cleanupIdempotency() {
  const now = Date.now();
  for (const [key, val] of idempotencyStore.entries()) {
    if (now - val.createdAt > IDEMPOTENCY_TTL_MS) idempotencyStore.delete(key);
  }
}
setInterval(cleanupIdempotency, 1000 * 60 * 10); // every 10 minutes

// Routes
app.get('/health', (_, res) => res.json({ status: 'OK', mode: PAYPAL_MODE }));

app.get('/api/config', (req, res) => {
  if (!PAYPAL_CLIENT_ID) return res.status(500).json({ error: 'PayPal Client ID not configured' });
  res.json({ clientId: PAYPAL_CLIENT_ID, mode: PAYPAL_MODE });
});

app.get('/api/generate-client-token', async (req, res) => {
  try {
    const customer_id = req.query.customer_id || null;
    console.log('generate-client-token request, customer_id=', customer_id);
    const tokens = await generateUserIdToken(customer_id);
    res.json({ id_token: tokens.id_token });
  } catch (err) {
    console.error('generate-client-token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'generate-client-token failed', details: err.response?.data || err.message });
  }
});

app.get('/api/payment-tokens/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const accessToken = await getPayPalAccessToken();
    const resp = await axios({
      method: 'get',
      url: `${PAYPAL_API_BASE}/v3/vault/payment-tokens?customer_id=${encodeURIComponent(customerId)}`,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    res.json(resp.data);
  } catch (err) {
    console.error('/api/payment-tokens error:', err.response?.data || err.message);
    res.status(500).json({ error: 'payment-tokens failed', details: err.response?.data || err.message });
  }
});

// Initial order creation (keeps vault-on-success behavior)
app.post('/api/orders', async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();
    const { customerId, vaultId } = req.body || {};

    let orderPayload;
    if (vaultId) {
      orderPayload = {
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'JPY', value: '100' }, description: 'PayPal Vault 商品（保存済み）' }],
        payment_source: { token: { id: vaultId, type: 'PAYMENT_METHOD_TOKEN' } }
      };
    } else {
      orderPayload = {
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'JPY', value: '100' }, description: 'PayPal Vault 商品' }],
        payment_source: {
          paypal: {
            experience_context: {
              payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
              brand_name: 'PayPal Vault Demo',
              locale: 'ja-JP',
              landing_page: 'LOGIN',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW'
            },
            attributes: {
              vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' }
            }
          }
        }
      };
      if (customerId) orderPayload.payment_source.paypal.attributes.vault.customer_id = customerId;
    }

    const resp = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v2/checkout/orders`,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `ORDER-${Date.now()}` },
      data: orderPayload
    });

    res.json(resp.data);
  } catch (err) {
    console.error('/api/orders error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Order creation failed', details: err.response?.data || err.message });
  }
});

// ONECLICK: Create Order with payment token and immediately Capture. Idempotent-ish by requestId.
app.post('/api/orders/oneclick', async (req, res) => {
  // We use requestId from header or generate one
  const requestId = req.headers['x-idempotency-key'] || req.headers['paypal-request-id'] || uuidv4();
  try {
    cleanupIdempotency();

    // If we've processed this requestId, return cached result
    const cached = idempotencyStore.get(requestId);
    if (cached) {
      console.log('oneclick: returning cached result for requestId', requestId);
      return res.json({ orderId: cached.orderId, orderStatus: cached.orderStatus, capture: cached.capture });
    }

    const accessToken = await getPayPalAccessToken();
    const { vaultId, customerId = null, amount = '100', currency = 'JPY', description = 'Vault One-click charge' } = req.body || {};

    if (!vaultId) return res.status(400).json({ error: 'vaultId required' });
    if (currency === 'JPY' && String(amount).includes('.')) return res.status(400).json({ error: 'JPY does not support decimals' });

    // Create Order
    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: currency, value: String(amount) }, description }],
      payment_source: { token: { id: vaultId, type: 'PAYMENT_METHOD_TOKEN' } }
    };

    console.log('oneclick: creating order', { requestId, vaultId, customerId, amount, currency });
    const createResp = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v2/checkout/orders`,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': requestId },
      data: orderPayload
    });

    const orderId = createResp.data.id;
    console.log('oneclick: order created', orderId);

    // Capture
    try {
      const captureResp = await axios({
        method: 'post',
        url: `${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `CAPTURE-${requestId}` },
        data: {}
      });

      const capture = captureResp.data;
      console.log('oneclick: capture succeeded', orderId, capture.status);

      // Cache result
      idempotencyStore.set(requestId, { orderId, orderStatus: createResp.data.status, capture, createdAt: Date.now() });

      return res.json({ orderId, orderStatus: createResp.data.status, capture });
    } catch (capErr) {
      // If capture failed due to ORDER_ALREADY_CAPTURED, treat as success
      const capData = capErr.response?.data;
      if (capData && capData.name === 'UNPROCESSABLE_ENTITY') {
        const already = (capData.details || []).some(d => d.issue === 'ORDER_ALREADY_CAPTURED');
        if (already) {
          console.warn('oneclick: capture reported ORDER_ALREADY_CAPTURED, treating as success', capData);
          // Try to GET the order to fetch capture info (or return createResp as fallback)
          try {
            const orderResp = await axios({
              method: 'get',
              url: `${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}`,
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
            });
            const capture = orderResp.data.purchase_units?.[0]?.payments?.captures?.[0] || null;
            idempotencyStore.set(requestId, { orderId, orderStatus: orderResp.data.status, capture, createdAt: Date.now() });
            return res.json({ orderId, orderStatus: orderResp.data.status, capture });
          } catch (getErr) {
            console.error('oneclick: failed to GET order after ORDER_ALREADY_CAPTURED', getErr.response?.data || getErr.message);
            // fallback: return createResp (order created) but note capture absent
            idempotencyStore.set(requestId, { orderId, orderStatus: createResp.data.status, capture: null, createdAt: Date.now() });
            return res.json({ orderId, orderStatus: createResp.data.status, capture: null });
          }
        }
      }
      console.error('oneclick capture error:', capErr.response?.data || capErr.message);
      return res.status(500).json({ error: 'oneclick capture failed', details: capErr.response?.data || capErr.message });
    }

  } catch (err) {
    console.error('oneclick error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'oneclick failed', details: err.response?.data || err.message });
  }
});

// Capture endpoint (for non-oneclick flows)
app.post('/api/orders/:orderId/capture', async (req, res) => {
  try {
    const { orderId } = req.params;
    const accessToken = await getPayPalAccessToken();
    const resp = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `CAPTURE-${Date.now()}` },
      data: {}
    });
    res.json(resp.data);
  } catch (err) {
    console.error('capture endpoint error:', err.response?.data || err.message);
    res.status(500).json({ error: 'capture failed', details: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log('Server listening on', PORT, 'mode=', PAYPAL_MODE);
});
