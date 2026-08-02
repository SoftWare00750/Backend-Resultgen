const router = require("express").Router();
const crypto = require("crypto");
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { isValidPlan, calculatePrice, getTrialLimit } = require("../utils/pricing");
const paystack = require("../utils/paystack");

// Paystack requires a non-zero amount to create a reusable card authorization.
// We charge this small "card verification" amount up front when someone signs
// up on a free trial, purely to capture a reusable authorization_code for
// billing once the trial ends — it is NOT the plan's monthly price.
// Configurable so you can point it at whatever amount you want to (not)
// refund. Defaults to ₦50.
const CARD_VERIFICATION_KOBO = Number(process.env.PAYSTACK_CARD_VERIFICATION_KOBO || 5000);

function makeReference() {
  return `rgs_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * POST /api/payments/initialize
 * { email, plan, studentCount }
 * Called from the registration form once the admin reaches the "payment
 * details" step, BEFORE the account exists. Returns a Paystack
 * authorization_url / access_code the frontend uses to collect card details.
 */
router.post(
  "/initialize",
  asyncHandler(async (req, res) => {
    const { email, plan, studentCount } = req.body;
    if (!email || !plan) return res.status(400).json({ error: "Email and plan are required" });
    if (!isValidPlan(plan)) return res.status(400).json({ error: "Invalid plan" });

    const trialLimit = getTrialLimit(plan);
    const priced = calculatePrice(plan, studentCount || trialLimit);
    const reference = makeReference();

    await query(
      `INSERT INTO payments (reference, plan, student_count, amount_kobo, status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [reference, plan, studentCount || 0, CARD_VERIFICATION_KOBO]
    );

    const data = await paystack.initializeTransaction({
      email,
      amountKobo: CARD_VERIFICATION_KOBO,
      reference,
      metadata: {
        purpose: "card_verification_for_trial",
        plan,
        studentCount: studentCount || 0,
        monthlyRateNaira: priced.rateNaira,
      },
    });

    res.json({
      reference,
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
      publicKey: process.env.PAYSTACK_PUBLIC_KEY,
      amountKobo: CARD_VERIFICATION_KOBO,
      pricing: priced,
    });
  })
);

/**
 * GET /api/payments/verify/:reference
 * Frontend polls/calls this right after the Paystack popup closes, so it can
 * show "payment details saved" before submitting the actual registration
 * form. The webhook below is the source of truth for record-keeping, but the
 * frontend needs a synchronous answer to proceed.
 */
router.get(
  "/verify/:reference",
  asyncHandler(async (req, res) => {
    const { reference } = req.params;
    const result = await paystack.verifyTransaction(reference);

    const status = result.status === "success" ? "success" : "failed";
    await query(
      `UPDATE payments SET status = $1, paystack_raw = $2 WHERE reference = $3`,
      [status, JSON.stringify(result), reference]
    );

    res.json({
      status,
      authorizationCode: result.authorization?.authorization_code || null,
      last4: result.authorization?.last4 || null,
      cardType: result.authorization?.card_type || null,
    });
  })
);

/**
 * POST /api/payments/webhook
 * Paystack server-to-server event notification. Mounted with a raw body
 * parser in server.js so the HMAC signature can be verified against the
 * exact bytes Paystack sent.
 */
router.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    const expected = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
      .update(req.rawBody || "")
      .digest("hex");

    if (!signature || signature !== expected) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(req.rawBody || "{}");

    if (event.event === "charge.success") {
      const data = event.data;
      await query(
        `UPDATE payments SET status = 'success', paystack_raw = $1 WHERE reference = $2`,
        [JSON.stringify(data), data.reference]
      );
    }

    // Always 200 quickly so Paystack doesn't retry needlessly.
    res.sendStatus(200);
  })
);

module.exports = router;
