/**
 * Paystack API - Initialize transaction (redirect user to pay)
 * Use live keys for production. Docs: https://paystack.com/docs/api/
 */

import crypto from 'crypto';

const PAYSTACK_BASE = 'https://api.paystack.co';

export async function initializeTransaction({ reference, amount, currency, callbackUrl, customer }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');

  // Paystack amounts are in smallest unit (cents for KES, kobo for NGN)
  const amountInSmallest = Math.round(Number(amount) * 100);

  const body = {
    reference,
    amount: amountInSmallest,
    currency: currency || 'KES',
    callback_url: callbackUrl,
    email: customer.email,
    metadata: { customer_name: customer.name || 'Applicant' },
  };

  const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.status || !data.data?.authorization_url) {
    const msg = data.message || 'Paystack payment init failed';
    throw new Error(msg);
  }
  return { paymentLink: data.data.authorization_url, reference: data.data.reference };
}

/**
 * Verify Paystack webhook signature (x-paystack-signature)
 */
export function verifyWebhookSignature(payload, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return true; // skip if not set
  const hash = crypto.createHmac('sha512', secret).update(payload).digest('hex');
  return hash === signature;
}
