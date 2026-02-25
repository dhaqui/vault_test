// server.js
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');

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

// Utility: ensure env
function requireEnv() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET が未設定です');
  }
}

// Get access token
async function getPayPalAccessToken() {
  requireEnv();
  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const resp = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: 'grant_type=client_credentials'
    });
    return resp.data.access_token;
  } catch (err) {
    console.error('Access Token取得エラー:', err.response?.data || err.message);
    throw err;
  }
}

// Generate User ID token (id_token) with optional target_customer_id
async function generateUserIdToken(customerId = null) {
  requireEnv();
  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    let postData = 'grant_type=client_credentials&response_type=id_token';
    if (customerId) postData += `&target_customer_id=${encodeURIComponent(customerId)}`;

    const resp = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: postData
    });

    return { access_token: resp.data.access_token, id_token: resp.data.id_token };
  } catch (err) {
    console.error('User ID Token取得エラー:', err.response?.data || err.message);
    throw err;
  }
}

// Routes
app.get('/health', (req, res) =>
  res.json({ status: 'OK', mode: PAYPAL_MODE, clientIdConfigured: !!PAYPAL_CLIENT_ID })
);

app.get('/api/config', (req, res) => {
  if (!PAYPAL_CLIENT_ID) return res.status(500).json({ error: 'PayPal Client IDが設定されていません' });
  res.json({ clientId: PAYPAL_CLIENT_ID, mode: PAYPAL_MODE });
});

// Generate id_token for SDK (Returning payer)
app.get('/api/generate-client-token', async (req, res) => {
  try {
    const customer_id = req.query.customer_id || null;
    const tokens = await generateUserIdToken(customer_id);
    res.json({ id_token: tokens.id_token });
  } catch (err) {
    console.error('Client Token生成エラー:', err.response?.data || err.message);
    res.status(500).json({ error: 'Client Token生成に失敗しました', details: err.response?.data || err.message });
  }
});

// List payment tokens for a customer (optional)
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
    console.error('Payment Tokens取得エラー:', err.response?.data || err.message);
    res.status(500).json({ error: 'Payment Tokens取得に失敗しました', details: err.response?.data || err.message });
  }
});

// Original order creation for initial flow (keeps Vault-on-success behavior)
app.post('/api/orders', async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();
    const { customerId, vaultId } = req.body || {};

    let orderPayload;
    if (vaultId) {
      orderPayload = {
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'JPY', value: '100' }, description: 'PayPal Vault テスト商品（保存済み）' }],
        payment_source: { token: { id: vaultId, type: 'PAYMENT_METHOD_TOKEN' } }
      };
    } else {
      orderPayload = {
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'JPY', value: '100' }, description: 'PayPal Vault テスト商品' }],
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
            attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } }
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
    console.error('Order作成エラー:', err.response?.data || err.message);
    res.status(500).json({ error: 'Order作成に失敗しました', details: err.response?.data || err.message });
  }
});

// One-click: Create Order with token and immediately Capture (server-side).
// This endpoint performs both Create and Capture and returns capture result.
// IMPORTANT: caller should call this once. Implement idempotency in production.
app.post('/api/orders/oneclick', async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();
    const { vaultId, customerId = null, amount = '100', currency = 'JPY', description = 'Vault One-click charge' } = req.body || {};

    if (!vaultId) return res.status(400).json({ error: 'vaultId が必要です（PAYMENT_METHOD_TOKEN）' });
    if (currency === 'JPY' && String(amount).includes('.')) return res.status(400).json({ error: 'JPY は小数不可です。amount を整数文字列にしてください。' });

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: currency, value: String(amount) }, description }],
      payment_source: { token: { id: vaultId, type: 'PAYMENT_METHOD_TOKEN' } }
    };

    // Create
    const createResp = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v2/checkout/orders`,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `ONECLICK-ORDER-${Date.now()}` },
      data: orderPayload
    });

    const orderId = createResp.data.id;
    console.log('ONECLICK: order created', orderId, createResp.data.status);

    // Capture immediately
    const captureResp = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `ONECLICK-CAPTURE-${Date.now()}` },
      data: {}
    });

    console.log('ONECLICK: capture done', captureResp.data.status);

    res.json({ orderId, orderStatus: createResp.data.status, capture: captureResp.data });
  } catch (err) {
    console.error('ONECLICK ERROR:', { message: err.message, status: err.response?.status, data: err.response?.data });
    res.status(500).json({ error: 'oneclick failed', details: err.response?.data || err.message });
  }
});

// Capture endpoint (used by SDK onApprove for non-oneclick flow)
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
    console.error('Capture エラー:', err.response?.data || err.message);
    res.status(500).json({ error: 'Captureに失敗しました', details: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`Server running on port ${PORT} (mode=${PAYPAL_MODE})`);
  console.log('='.repeat(50));
});
