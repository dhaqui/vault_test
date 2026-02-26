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

async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const resp = await axios.post(
    `${PAYPAL_API_BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return resp.data.access_token;
}

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

app.get('/health', (req, res) => res.json({ status: 'OK', mode: PAYPAL_MODE }));

app.get('/api/config', (req, res) => {
  if (!PAYPAL_CLIENT_ID) return res.status(500).json({ error: 'PAYPAL_CLIENT_ID未設定' });
  res.json({ clientId: PAYPAL_CLIENT_ID, mode: PAYPAL_MODE });
});

app.get('/api/generate-client-token', async (req, res) => {
  try {
    const idToken = await getUserIdToken(req.query.customer_id || null);
    res.json({ id_token: idToken });
  } catch (err) {
    console.error('id_token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

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
// shippingMode: 'none' | 'no_shipping' | 'set_provided'
app.post('/api/orders', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { customerId, shippingMode = 'no_shipping' } = req.body || {};

    // テスト用住所
    const shippingAddress = {
      name: { full_name: 'テスト 太郎' },
      address: {
        address_line_1: '1-1-1 Shinjuku',
        admin_area_2: 'Shinjuku-ku',
        admin_area_1: 'Tokyo',
        postal_code: '160-0022',
        country_code: 'JP'
      }
    };

    // shipping_preference の設定
    // none        → 住所なし・NO_SHIPPING（純粋なワンクリック基準）
    // no_shipping → 住所あり・NO_SHIPPING（ワンクリック期待、Seller Protection なし）
    // set_provided→ 住所あり・SET_PROVIDED_ADDRESS（Seller Protection あり、ワンクリック不可の可能性）
    const shippingPreference =
      shippingMode === 'set_provided' ? 'SET_PROVIDED_ADDRESS' : 'NO_SHIPPING';

    const includeAddress = shippingMode !== 'none';

    const purchaseUnit = {
      amount: { currency_code: 'JPY', value: '100' },
      description: 'PayPal Vault テスト商品',
      ...(includeAddress && { shipping: shippingAddress })
    };

    const experienceContext = {
      payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
      brand_name: 'PayPal Vault Demo',
      locale: 'ja-JP',
      landing_page: 'LOGIN',
      user_action: 'PAY_NOW',
      shipping_preference: shippingPreference,
      return_url: `${req.protocol}://${req.get('host')}/success`,
      cancel_url: `${req.protocol}://${req.get('host')}/cancel`
    };

    const payload = {
      intent: 'CAPTURE',
      purchase_units: [purchaseUnit],
      payment_source: {
        paypal: {
          experience_context: experienceContext,
          ...(!customerId && {
            attributes: {
              vault: {
                store_in_vault: 'ON_SUCCESS',
                usage_type: 'MERCHANT',
                customer_type: 'CONSUMER'
              }
            }
          })
        }
      }
    };

    console.log('='.repeat(50));
    console.log(`Order: ${customerId ? 'Returning Payer' : 'New Payer'}`);
    console.log(`shippingMode: ${shippingMode}`);
    console.log(`shipping_preference: ${shippingPreference}`);
    console.log(`includeAddress: ${includeAddress}`);
    console.log('='.repeat(50));

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
