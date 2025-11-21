const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');

// 環境変数の読み込み
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// PayPal設定
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox'; // 'sandbox' or 'live'
const PAYPAL_API_BASE = PAYPAL_MODE === 'sandbox' 
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// ミドルウェア
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ログ出力
console.log('='.repeat(50));
console.log('PayPal Vault Server Starting...');
console.log('='.repeat(50));
console.log(`Mode: ${PAYPAL_MODE}`);
console.log(`API Base: ${PAYPAL_API_BASE}`);
console.log(`Client ID: ${PAYPAL_CLIENT_ID ? PAYPAL_CLIENT_ID.substring(0, 20) + '...' : 'NOT SET'}`);
console.log(`Client Secret: ${PAYPAL_CLIENT_SECRET ? '***' : 'NOT SET'}`);
console.log('='.repeat(50));

// ===== PayPal Access Tokenの取得 =====
async function getPayPalAccessToken() {
  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    const response = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: 'grant_type=client_credentials'
    });
    
    return response.data.access_token;
  } catch (error) {
    console.error('Access Token取得エラー:', error.response?.data || error.message);
    throw new Error('PayPal認証に失敗しました');
  }
}

// ===== ルート =====

// ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    mode: PAYPAL_MODE,
    clientIdConfigured: !!PAYPAL_CLIENT_ID,
    clientSecretConfigured: !!PAYPAL_CLIENT_SECRET
  });
});

// Client ID取得（フロントエンド用）
app.get('/api/config', (req, res) => {
  if (!PAYPAL_CLIENT_ID) {
    return res.status(500).json({ error: 'PayPal Client IDが設定されていません' });
  }
  
  res.json({
    clientId: PAYPAL_CLIENT_ID,
    mode: PAYPAL_MODE
  });
});

// Order作成
app.post('/api/orders', async (req, res) => {
  try {
    console.log('Order作成リクエスト受信');
    
    const accessToken = await getPayPalAccessToken();
    console.log('Access Token取得成功');
    
    const { customerId } = req.body;
    
    // Order作成リクエストペイロード
    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'JPY',
            value: '1000'
          },
          description: 'PayPal Vault テスト商品'
        }
      ],
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
              customer_type: 'CONSUMER'
            }
          }
        }
      }
    };
    
    // Customer IDがある場合は追加
    if (customerId) {
      orderPayload.payment_source.paypal.attributes.vault.customer_id = customerId;
      console.log(`Customer ID使用: ${customerId}`);
    }
    
    console.log('PayPal Order API呼び出し中...');
    
    const response = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v2/checkout/orders`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `ORDER-${Date.now()}`
      },
      data: orderPayload
    });
    
    console.log('Order作成成功:', response.data.id);
    res.json(response.data);
    
  } catch (error) {
    console.error('Order作成エラー:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Order作成に失敗しました',
      details: error.response?.data || error.message
    });
  }
});

// Order Capture
app.post('/api/orders/:orderId/capture', async (req, res) => {
  try {
    const { orderId } = req.params;
    console.log(`Order Capture開始: ${orderId}`);
    
    const accessToken = await getPayPalAccessToken();
    
    const response = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v2/checkout/orders/${orderId}/capture`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `CAPTURE-${Date.now()}`
      }
    });
    
    console.log('Capture成功:', response.data.id);
    console.log('Vault Status:', response.data.payment_source?.paypal?.attributes?.vault?.status);
    
    res.json(response.data);
    
  } catch (error) {
    console.error('Capture エラー:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Captureに失敗しました',
      details: error.response?.data || error.message
    });
  }
});

// Payment Tokens取得（保存された支払い方法の一覧）
app.get('/api/payment-tokens/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    console.log(`Payment Tokens取得: ${customerId}`);
    
    const accessToken = await getPayPalAccessToken();
    
    const response = await axios({
      method: 'get',
      url: `${PAYPAL_API_BASE}/v3/vault/payment-tokens?customer_id=${customerId}`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Payment Tokens取得成功');
    res.json(response.data);
    
  } catch (error) {
    console.error('Payment Tokens取得エラー:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Payment Tokens取得に失敗しました',
      details: error.response?.data || error.message
    });
  }
});

// サーバー起動
app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`✅ Server is running on port ${PORT}`);
  console.log(`🌐 Access: http://localhost:${PORT}`);
  console.log('='.repeat(50));
});