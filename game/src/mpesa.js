const BASE = () => (process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke');

let tokenCache = { value: null, exp: 0 };

async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const res = await fetch(`${BASE()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Daraja auth failed (${res.status})`);
  const j = await res.json();
  tokenCache = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  return tokenCache.value;
}

export function normalizePhone(input) {
  let p = String(input || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  else if (/^(7|1)\d{8}$/.test(p)) p = '254' + p;
  return /^254(7|1)\d{8}$/.test(p) ? p : null;
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function stkPush({ phone, amount, accountRef }) {
  const token = await getToken();
  const ts = timestamp();
  const shortcode = process.env.MPESA_SHORTCODE;
  const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${ts}`).toString('base64');
  const txnType = process.env.MPESA_TXN_TYPE || 'CustomerPayBillOnline';

  // FIX 1: Validate and normalize the phone number
  const validPhone = normalizePhone(phone);
  if (!validPhone) {
    throw new Error(`Invalid phone number: ${phone}`);
  }

  const body = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: ts,
    TransactionType: txnType,
    Amount: Math.round(amount),
    PartyA: validPhone,          // FIX 2: Use normalized phone
    PartyB: process.env.MPESA_PARTYB || shortcode,
    PhoneNumber: validPhone,     // FIX 2: Use normalized phone
    CallBackURL: process.env.MPESA_CALLBACK_URL, // FIX 3: Use the exact env variable
    AccountReference: String(accountRef).slice(0, 12), // FIX 4: Use accountRef
    TransactionDesc: 'Falcon Avi',
  };

  const res = await fetch(`${BASE()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const j = await res.json();
  if (!res.ok || j.ResponseCode !== '0') {
    throw new Error(j.errorMessage || j.ResponseDescription || 'STK push rejected');
  }

  // FIX 5: Return the mapped ID so server.js can read `result.checkoutRequestId`
  return {
    checkoutRequestId: j.CheckoutRequestID,
    merchantRequestId: j.MerchantRequestID,
    customerMessage: j.CustomerMessage
  };
}

export async function b2c({ phone, amount }) {
  const token = await getToken();
  const base = process.env.MPESA_CALLBACK_URL;
  const body = {
    InitiatorName: process.env.MPESA_INITIATOR_NAME,
    SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
    CommandID: 'BusinessPayment',
    Amount: Math.round(amount),
    PartyA: process.env.MPESA_B2C_SHORTCODE,
    PartyB: phone,
    Remarks: 'Falcon Aviator withdrawal',
    QueueTimeOutURL: `${base}/api/mpesa/b2c-timeout`,
    ResultURL: `${base}/api/mpesa/b2c-result`,
    Occasion: 'Withdrawal',
  };
  const res = await fetch(`${BASE()}/mpesa/b2c/v1/paymentrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || j.ResponseCode !== '0') {
    throw new Error(j.errorMessage || j.ResponseDescription || 'B2C rejected');
  }
  return j;
}