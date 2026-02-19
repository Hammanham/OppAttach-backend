/**
 * Flutterwave API - Initialize payment (redirect user to pay)
 * Use test keys from Flutterwave dashboard for testing.
 * Docs: https://developer.flutterwave.com/reference#initialize-payment
 */

import crypto from 'crypto';

const FLW_BASE = 'https://api.flutterwave.com/v3';

export async function initializePayment({ txRef, amount, currency, redirectUrl, customer, customizations }) {
  const secretKey = process.env.FLW_SECRET_KEY;
  if (!secretKey) throw new Error('FLW_SECRET_KEY is not set');

  const body = {
    tx_ref: txRef,
    amount: Number(amount),
    currency: currency || 'KES',
    redirect_url: redirectUrl,
    payment_options: 'card,mobilemoney,ussd',
    customer: {
      email: customer.email,
      name: customer.name || 'Customer',
    },
    customizations: {
      title: customizations?.title || 'IAS Application Fee',
      description: customizations?.description || 'Application fee',
    },
  };

  const res = await fetch(`${FLW_BASE}/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.status !== 'success' || !data.data?.link) {
    const msg = data.message || data.data?.message || 'Flutterwave payment init failed';
    throw new Error(msg);
  }
  return { paymentLink: data.data.link, id: data.data.id };
}

/**
 * Verify webhook signature (optional but recommended)
 */
export function verifyWebhookSignature(payload, signature) {
  const secret = process.env.FLW_WEBHOOK_SECRET;
  if (!secret) return true; // skip verification if not set
  const hash = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  return hash === signature;
}
