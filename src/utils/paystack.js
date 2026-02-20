/**
 * Paystack API - Initialize transaction (redirect user to pay)
 * Use live keys for production. Docs: https://paystack.com/docs/api/
 */

import crypto from 'crypto';

const PAYSTACK_BASE = 'https://api.paystack.co';

export async function initializeTransaction({ reference, amount, currency, callbackUrl, cancelUrl, customer }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');

  // Paystack amounts are in smallest unit (cents for KES, kobo for NGN)
  const amountInSmallest = Math.round(Number(amount) * 100);

  const metadata = { customer_name: customer.name || 'Applicant' };
  if (cancelUrl) metadata.cancel_action = cancelUrl;

  const body = {
    reference,
    amount: amountInSmallest,
    currency: currency || 'KES',
    callback_url: callbackUrl,
    email: customer.email,
    metadata,
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
 * Charge via M-Pesa (Kenya) - user enters phone, we trigger STK push
 * Phone: accepts 07XXXXXXXX, 712345678, 254712345678, +254712345678
 * Returns { reference, status, display_text }
 */
export async function chargeMpesa({ reference, amount, currency, email, phone, metadata = {} }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set');

  let normalized = String(phone || '').replace(/\s/g, '').replace(/^\+/, '');
  if (normalized.startsWith('0')) normalized = '254' + normalized.slice(1);
  else if (!normalized.startsWith('254')) normalized = '254' + normalized;
  if (normalized.length < 12) throw new Error('Invalid phone number');
  // Paystack Kenya expects +254 format
  const phoneFormatted = '+' + normalized;

  const amountInSmallest = Math.round(Number(amount) * 100);

  const body = {
    email,
    amount: String(amountInSmallest),
    currency: currency || 'KES',
    reference,
    mobile_money: { phone: phoneFormatted, provider: 'mpesa' },
    metadata: { ...metadata, custom_fields: [] },
  };

  const res = await fetch(`${PAYSTACK_BASE}/charge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const d = data.data || {};

  // "Charge attempted" = success - request was sent; user completes on phone
  if (data.status && (d.status === 'pay_offline' || d.status === 'pending')) {
    return {
      reference: d.reference || reference,
      status: d.status,
      display_text: d.display_text || 'Please complete authorization on your mobile phone',
    };
  }

  // Charge failed - use a clear error message, not "Charge attempted"
  if (!data.status) {
    const raw = data.message || '';
    const msg = raw === 'Charge attempted'
      ? 'M-Pesa request could not be completed. Please try Card/Bank or check your phone number (use 2547XXXXXXXX).'
      : raw || 'M-Pesa charge failed';
    throw new Error(msg);
  }

  // Unexpected status (e.g. failed, send_otp) - surface gateway response if available
  if (d.status === 'failed') {
    const reason = d.gateway_response || d.message || 'Payment could not be processed';
    throw new Error(reason);
  }

  return {
    reference: d.reference || reference,
    status: d.status || 'pay_offline',
    display_text: d.display_text || 'Please complete authorization on your mobile phone',
  };
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
