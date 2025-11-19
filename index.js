// index.js
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ───────────────────────────────────────────────
// Middleware
// ───────────────────────────────────────────────
app.use(bodyParser.json({ limit: '2mb' }));

// Log every request so we can see activity in Railway logs
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ───────────────────────────────────────────────
// ENV VARS
// ───────────────────────────────────────────────
const PARAGON_API_BASE = 'https://channel.paragon.online';
const PARAGON_ENDPOINT = (process.env.PARAGON_ENDPOINT || '7592').trim();
const PARAGON_METHOD   = 'sale';
const PARAGON_CONTROL  = (process.env.PARAGON_CONTROL || '').trim();

const BONGS_REDIRECT_URL =
  process.env.BONGS_REDIRECT_URL || 'https://bongs.co.uk/payment-complete';
const BONGS_WEBHOOK_URL  =
  process.env.BONGS_WEBHOOK_URL  || 'https://bongs.co.uk/paragon-callback';

// SMTP / Gmail
const EMAIL_FROM  = process.env.EMAIL_FROM;
const EMAIL_USER  = process.env.EMAIL_USER;
const EMAIL_PASS  = process.env.EMAIL_PASS;

console.log('Startup env check:', {
  PARAGON_ENDPOINT,
  hasParagonControl: !!PARAGON_CONTROL,
  BONGS_REDIRECT_URL,
  BONGS_WEBHOOK_URL,
  hasEmailUser: !!EMAIL_USER,
});

// Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// ───────────────────────────────────────────────
// Build Paragon request from Shopify order
// ───────────────────────────────────────────────
function buildParagonRequestFromShopify(order) {
  if (!PARAGON_CONTROL) {
    console.log('buildParagon: missing PARAGON_CONTROL env var');
    return null;
  }

  const gateways = order.payment_gateway_names || [];
  const isCard = gateways.some(g =>
    /card payments?/i.test(g) || /card/i.test(g)
  );

  if (!isCard) return null;

  let orderNumber =
    order.name ||
    (order.order_number != null ? String(order.order_number) : '');

  if (!orderNumber) {
    orderNumber = 'no-order-' + Date.now();
  }

  let amountRaw =
    order.total_price ||
    order.current_total_price ||
    order.subtotal_price;

  let amount = '';
  if (typeof amountRaw === 'number') {
    amount = amountRaw.toFixed(2);
  } else if (typeof amountRaw === 'string') {
    amount = amountRaw.trim();
  } else {
    amount = '0.00';
  }

  const shipping = order.shipping_address || order.billing_address || {};
  const customer = order.customer || {};

  const firstName = shipping.first_name || customer.first_name || '';
  const lastName  = shipping.last_name  || customer.last_name  || '';
  const customerName = (firstName + ' ' + lastName).trim() || 'Customer';

  const addressLine = [
    shipping.address1 || '',
    shipping.address2 || ''
  ].filter(Boolean).join(', ');

  const cityLine      = shipping.city || '';
  const postcodeLine  = shipping.zip || '';
  const countryCode   = (shipping.country_code || 'GB').toUpperCase();
  const customerEmail = order.email || customer.email || '';

  const paragonOrder = {
    clientOrderId: '',
    amount,
    currency: 'GBP',
    buyerDetails: {
      firstName: firstName || 'Customer',
      lastName: lastName || 'Customer',
      email: customerEmail || '',
      address: addressLine,
      city: cityLine,
      state: '',
      zipCode: postcodeLine,
      country: countryCode,
    },
    technicalDetails: {
      ipaddress: '1.2.3.4',
      redirectUrl: BONGS_REDIRECT_URL,
      webhookUrl: BONGS_WEBHOOK_URL,
      payByLink: true,
    },
    orderDescription: '',
    merchantControl: PARAGON_CONTROL,
  };

  let clientOrderId = orderNumber.toString().trim();
  if (!clientOrderId.startsWith('bongs-')) {
    clientOrderId = 'bongs-' + clientOrderId;
  }

  paragonOrder.clientOrderId = clientOrderId;
  paragonOrder.orderDescription = `Bongs order #${clientOrderId}`;

  // IMPORTANT: bodyString is what we sign AND send
  const bodyString = JSON.stringify(paragonOrder);
  const requestUrl = `${PARAGON_API_BASE}/v4/${PARAGON_ENDPOINT}/form/${PARAGON_METHOD}`;

  const hmacHexLower = crypto
    .createHmac('sha256', PARAGON_CONTROL)
    .update(bodyString + requestUrl, 'utf8')
    .digest('hex');

  return {
    paragonOrder,
    bodyString,
    requestUrl,
    authHeader: `Bearer ${hmacHexLower}`,
    parsed: {
      orderNumber,
      amount,
      customerName,
      customerEmail,
      addressLine,
      cityLine,
      postcodeLine,
      countryCode,
    },
  };
}

// ───────────────────────────────────────────────
// Health + debug routes
// ───────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.send('Bongs Paragon paylink service running.');
});

// ───────────────────────────────────────────────
// Shopify Webhook Route
// ───────────────────────────────────────────────
app.post('/shopify-order', async (req, res) => {
  console.log('Received /shopify-order webhook');

  try {
    const order = req.body;
    console.log('Shopify body snippet:', JSON.stringify({
      id: order.id,
      email: order.email,
      gatewayNames: order.payment_gateway_names,
      total_price: order.total_price,
    }));

    const built = buildParagonRequestFromShopify(order);
    if (!built) {
      console.log('buildParagon returned null – probably not card / bad payload / missing env.');
      return res.status(200).json({ ok: true, skipped: true });
    }

    const {
      paragonOrder,
      bodyString,
      requestUrl,
      authHeader,
      parsed,
    } = built;

    console.log('Sending request to Paragon:', requestUrl);

    // IMPORTANT: send the exact bodyString we signed
    const paragonResp = await axios.post(
      requestUrl,
      bodyString,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        timeout: 15000,
      }
    );

    const pData = paragonResp.data || {};
    const paymentLink = pData.redirectUrl;
    console.log('Paragon response:', pData);

    if (parsed.customerEmail && paymentLink) {
      const html = `
        <p><strong>Gorilla Bongs – Payment Instructions</strong></p>
        <p>Hi ${parsed.customerName || 'there'},</p>
        <p>Thanks for your order <strong>${parsed.orderNumber}</strong>.</p>
        <p>Please use the secure link below to complete your card payment:</p>
        <p><a href="${paymentLink}">${paymentLink}</a></p>
        <p>Amount: £${parsed.amount}</p>
        <p>
          ${parsed.addressLine}<br>
          ${parsed.cityLine} ${parsed.postcodeLine}<br>
          ${parsed.countryCode}
        </p>
        <p>Cheers,<br>Gorilla Bongs</p>
      `;

      console.log('Sending email to', parsed.customerEmail);

      await transporter.sendMail({
        from: EMAIL_FROM,
        to: parsed.customerEmail,
        subject: `Payment link for order ${parsed.orderNumber}`,
        html,
      });
    } else {
      console.log('Missing email or payment link, email not sent.');
    }

    return res.status(200).json({
      ok: true,
      paymentLink,
      clientOrderId: paragonOrder.clientOrderId,
    });

  } catch (err) {
    console.error(
      'Error in /shopify-order:',
      err.message,
      err.response && err.response.status,
      err.response && err.response.data
    ); 
    return res.status(500).json({ ok: false, error: 'internal-error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
