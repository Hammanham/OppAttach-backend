/**
 * M-Pesa Daraja API - STK Push (Lipa Na M-Pesa Online)
 * Used when user submits application: prompt phone number, then STK push for KES 350.
 */

const MPESA_BASE = 'https://sandbox.safaricom.co.ke'; // Production: https://api.safaricom.co.ke

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const res = await fetch(`${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error('M-Pesa auth failed');
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

export async function initiateSTKPush(phone, amount, reference, description) {
  const token = await getAccessToken();
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const formattedPhone = phone.startsWith('254') ? phone : `254${phone.replace(/^0/, '')}`;

  const body = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: formattedPhone,
    PartyB: shortcode,
    PhoneNumber: formattedPhone,
    CallBackURL: callbackUrl,
    AccountReference: reference,
    TransactionDesc: description,
  };

  const res = await fetch(`${MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || 'STK Push failed');
  }
  const data = await res.json();
  return {
    CheckoutRequestID: data.CheckoutRequestID,
    MerchantRequestID: data.MerchantRequestID,
    ResponseCode: data.ResponseCode,
    ResponseDescription: data.ResponseDescription,
  };
}
