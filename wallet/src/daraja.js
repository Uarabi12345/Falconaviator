import 'dotenv/config';

const BASE = process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// Normalize Kenyan phone numbers to international format
// "0712345678" → "254712345678"
// "+254712345678" → "254712345678"
export function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

async function getToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const r = await fetch(
    `${BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Daraja auth failed (${r.status}): ${body.slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j.access_token) throw new Error('No access_token in Daraja response');
  return j.access_token;
}

function getTimestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function stkPush({ phone, amount, accountRef, description }) {
  const token = await getToken();
  const timestamp = getTimestamp();
  const password = Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
  ).toString('base64');

  const normalized = normalizePhone(phone);
  if (!/^254(7|1)\d{8}$/.test(normalized)) {
    throw new Error(`Invalid phone number: ${phone} (normalized: ${normalized})`);
  }

  const payload = {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(Number(amount)),
    PartyA: normalized,
    PartyB: process.env.MPESA_SHORTCODE,
    PhoneNumber: normalized,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: String(accountRef).slice(0, 12),
    TransactionDesc: String(description).slice(0, 13),
  };

  const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const j = await r.json();

  if (!r.ok || j.ResponseCode !== '0') {
    throw new Error(`STK Push failed: ${j.errorMessage || j.ResponseDescription || JSON.stringify(j)}`);
  }

  return {
    merchantRequestId: j.MerchantRequestID,
    checkoutRequestId: j.CheckoutRequestID,
    customerMessage: j.CustomerMessage,
  };
}