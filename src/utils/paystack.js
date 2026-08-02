const PAYSTACK_BASE = "https://api.paystack.co";

function secretKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is not set");
  return key;
}

async function paystackFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.status === false) {
    const err = new Error(data.message || `Paystack request failed (${res.status})`);
    err.status = res.status;
    err.paystack = data;
    throw err;
  }
  return data;
}

/**
 * Initializes a transaction. Returns { authorization_url, access_code, reference }.
 * amountKobo must be an integer (₦1 = 100 kobo).
 */
function initializeTransaction({ email, amountKobo, reference, metadata, callback_url }) {
  return paystackFetch("/transaction/initialize", {
    method: "POST",
    body: { email, amount: amountKobo, reference, metadata, callback_url },
  }).then((r) => r.data);
}

/** Verifies a transaction by reference. Returns Paystack's transaction data object. */
function verifyTransaction(reference) {
  return paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`).then((r) => r.data);
}

/**
 * Charges a previously-authorized card on file (used for recurring/monthly
 * billing after the first successful payment captured the authorization code).
 */
function chargeAuthorization({ email, amountKobo, authorization_code, reference, metadata }) {
  return paystackFetch("/transaction/charge_authorization", {
    method: "POST",
    body: { email, amount: amountKobo, authorization_code, reference, metadata },
  }).then((r) => r.data);
}

module.exports = { initializeTransaction, verifyTransaction, chargeAuthorization };
