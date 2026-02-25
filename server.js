const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE          = process.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_API_BASE      = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== Utilities =====

async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const resp = await axios.post(
    `${PAYPAL_API_BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return resp.data.access_token;
}

// target_customer_id を渡すことで Returning Payer 用の id_token を生成
async function getUserIdToken(customerId = null) {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  let body = 'grant_type=client_credentials&response_type=id_token';
  if (customerId) {
    body += `&target_customer_id=${encodeURIComponent(customerId)}`;
    console.log(`id_token: Returning Payer (customer_id=${customerId})`);
  } else {
    console.log('id_token: New Payer');
  }
  const resp = await axios.post(
    `${PAYPAL_API_BASE}/v1/oauth2/token`,
    body,
    { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return resp.data.id_token;
}

// ===== Routes =====

app.get('/health', (req, res) => res.json({ status: 'OK', mode: PAYPAL_MODE }));

app.get('/api/config', (req, res) => {
  if (!PAYPAL_CLIENT_ID) return res.status(500).json({ error: 'PAYPAL_CLIENT_ID未設定' });
  res.json({ clientId: PAYPAL_CLIENT_ID, mode: PAYPAL_MODE });
});

// SDK 用 User ID Token
// Returning Payer の場合は ?customer_id=xxx を渡す
app.get('/api/generate-client-token', async (req, res) => {
  try {
    const idToken = await getUserIdToken(req.query.customer_id || null);
    res.json({ id_token: idToken });
  } catch (err) {
    console.error('id_token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Payment Tokens 一覧（Vault 済みトークン確認用）
app.get('/api/payment-tokens/:customerId', async (req, res) => {
  try {
    const token = await getAccessToken();
    const resp = await axios.get(
      `${PAYPAL_API_BASE}/v3/vault/payment-tokens?customer_id=${encodeURIComponent(req.params.customerId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(resp.data);
  } catch (err) {
    console.error('payment-tokens error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Order 作成
// 初回：Vault保存付き通常注文
// 2回目以降：customerId を vault.customer_id に紐付けて同じフローを維持
app.post('/api/orders', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { customerId } = req.body || {};

    const payload = {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'JPY', value: '100' },
        description: 'PayPal Vault テスト商品'
      }],
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            brand_name: 'PayPal Vault Demo',
            locale: 'ja-JP',
            landing_page: 'LOGIN',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            return_url: `${req.protocol}://${req.get('host')}/success`,
            cancel_url: `${req.protocol}://${req.get('host')}/cancel`
          },
          attributes: {
            vault: {
              store_in_vault: 'ON_SUCCESS',
              usage_type: 'MERCHANT',
              customer_type: 'CONSUMER',
              // Returning Payer の場合：既存 customer に Vault を紐付ける
              ...(customerId && { customer_id: customerId })
            }
          }
        }
      }
    };

    console.log(customerId ? `Order: Returning Payer (${customerId})` : 'Order: New Payer');

    const resp = await axios.post(
      `${PAYPAL_API_BASE}/v2/checkout/orders`,
      payload,
      { headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': `ORDER-${Date.now()}`
      }}
    );
    res.json(resp.data);
  } catch (err) {
    console.error('order error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Capture
app.post('/api/orders/:orderId/capture', async (req, res) => {
  try {
    const token = await getAccessToken();
    const resp = await axios.post(
      `${PAYPAL_API_BASE}/v2/checkout/orders/${req.params.orderId}/capture`,
      {},
      { headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': `CAPTURE-${Date.now()}`
      }}
    );
    res.json(resp.data);
  } catch (err) {
    console.error('capture error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT} (${PAYPAL_MODE})`));
