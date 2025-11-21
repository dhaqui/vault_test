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

console.log('='.repeat(50));
console.log('PayPal Vault Server Starting...');
console.log('='.repeat(50));
console.log(`Mode: ${PAYPAL_MODE}`);
console.log(`Client ID: ${PAYPAL_CLIENT_ID ? PAYPAL_CLIENT_ID.substring(0, 20) + '...' : 'NOT SET'}`);
console.log('='.repeat(50));

// ===== PayPal Access Token取得 =====
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

// ===== User ID Token生成（target_customer_id対応）=====
async function generateUserIdToken(customerId = null) {
  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    // ベースとなるPOSTデータ
    let postData = 'grant_type=client_credentials&response_type=id_token';
    
    // Returning payer用にtarget_customer_idを追加（重要！）
    if (customerId) {
      postData += `&target_customer_id=${customerId}`;
      console.log(`✓ Returning payer用User ID Token生成: target_customer_id=${customerId}`);
    } else {
      console.log('✓ 新規payer用User ID Token生成');
    }
    
    const response = await axios({
      method: 'post',
      url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: postData
    });
    
    console.log('User ID Token生成成功');
    return {
      access_token: response.data.access_token,
      id_token: response.data.id_token
    };
  } catch (error) {
    console.error('User ID Token取得エラー:', error.response?.data || error.message);
    throw new Error('User ID Token生成に失敗しました');
  }
}

// ===== ルート =====

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    mode: PAYPAL_MODE,
    clientIdConfigured: !!PAYPAL_CLIENT_ID,
    clientSecretConfigured: !!PAYPAL_CLIENT_SECRET
  });
});

app.get('/api/config', (req, res) => {
  if (!PAYPAL_CLIENT_ID) {
    return res.status(500).json({ error: 'PayPal Client IDが設定されていません' });
  }
  
  res.json({
    clientId: PAYPAL_CLIENT_ID,
    mode: PAYPAL_MODE
  });
});

// User ID Token生成エンドポイント（target_customer_id対応）
app.get('/api/generate-client-token', async (req, res) => {
  try {
    // クエリパラメータからcustomer_idを取得
    const { customer_id } = req.query;
    
    if (customer_id) {
      console.log(`Returning payer用User ID Token生成リクエスト: ${customer_id}`);
    } else {
      console.log('新規payer用User ID Token生成リクエスト');
    }
    
    // customer_idを渡してToken生成
    const tokens = await generateUserIdToken(customer_id);
    
    res.json({ id_token: tokens.id_token });
  } catch (error) {
    console.error('Client Token生成エラー:', error.message);
    res.status(500).json({ 
      error: 'Client Token生成に失敗しました',
      details: error.message
    });
  }
});

// Payment Tokens取得
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

// Order作成
app.post('/api/orders', async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();
    const { customerId, vaultId } = req.body;
    
    let orderPayload;
    
    // Vault IDがある場合（保存された支払い方法を使用）
    if (vaultId) {
      console.log('='.repeat(50));
      console.log('💳 保存された支払い方法でOrder作成');
      console.log(`Vault ID: ${vaultId}`);
      console.log(`Customer ID: ${customerId}`);
      console.log('※ このOrderは自動的にCaptureされます');
      console.log('='.repeat(50));
      
      orderPayload = {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'JPY',
            value: '100'
          },
          description: 'PayPal Vault テスト商品（保存済み）'
        }],
        payment_source: {
          token: {
            id: vaultId,
            type: 'PAYMENT_METHOD_TOKEN'
          }
        }
      };
    } else {
      // 新規購入
      console.log('='.repeat(50));
      console.log('🆕 新規Order作成（Vault保存付き）');
      if (customerId) {
        console.log(`既存Customer ID使用: ${customerId}`);
      } else {
        console.log('新規Customer（初回購入）');
      }
      console.log('='.repeat(50));
      
      orderPayload = {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'JPY',
            value: '100'
          },
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
                customer_type: 'CONSUMER'
              }
            }
          }
        }
      };
      
      if (customerId) {
        orderPayload.payment_source.paypal.attributes.vault.customer_id = customerId;
        console.log('既存Customer IDをVault設定に追加');
      }
    }
    
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
    console.log('Order Status:', response.data.status);
    
    // Vault IDを使った場合、自動的にCaptureされる
    if (vaultId && response.data.purchase_units?.[0]?.payments?.captures) {
      const capture = response.data.purchase_units[0].payments.captures[0];
      console.log('✓ 自動Capture完了（Vault ID使用）');
      console.log(`Capture ID: ${capture.id}`);
      console.log(`Capture Status: ${capture.status}`);
    }
    
    console.log('='.repeat(50));
    
    res.json(response.data);
    
  } catch (error) {
    console.error('Order作成エラー:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Order作成に失敗しました',
      details: error.response?.data || error.message
    });
  }
});

// Order Capture（初回購入時のみ使用）
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

app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log('='.repeat(50));
});
