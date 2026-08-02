/**
 * Pricing rules for the three plans.
 *
 * NOTE ON THE VOLUME-DISCOUNT BANDS (Standard & Premium):
 * The spec says "price reduces as the number of students increases from 10
 * to 20 and so on" without specifying exact percentages. This file implements
 * a simple, clearly-documented band schedule below — tune BAND_DISCOUNTS if
 * you want different numbers, everything else keys off this one table.
 *
 * All amounts are in NGN kobo (₦1 = 100 kobo) because that's what Paystack's
 * API expects.
 */

const NAIRA = 100; // kobo per naira

const PLANS = {
  starter: {
    key: "starter",
    label: "School Starter",
    basePriceNaira: 2000,       // flat monthly rate, does not decline with volume
    trialStudentLimit: 10,      // free trial covers up to 10 students
    perStudentDiscountBands: false,
  },
  standard: {
    key: "standard",
    label: "School Standard",
    basePriceNaira: 3000,       // starting per-student-band monthly rate
    trialStudentLimit: 5,       // free trial covers up to 5 students
    perStudentDiscountBands: true,
  },
  premium: {
    key: "premium",
    label: "School Premium",
    basePriceNaira: 4000,       // starting per-student-band monthly rate
    trialStudentLimit: 8,       // free trial covers up to 8 students
    perStudentDiscountBands: true,
  },
};

// Every 10 additional students, the effective per-student rate drops by this
// much, down to a floor of 50% of the base rate.
const BAND_SIZE = 10;
const DISCOUNT_PER_BAND = 0.1; // 10% off per band
const MAX_DISCOUNT = 0.5; // never discount more than 50%

function isValidPlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLANS, plan);
}

/**
 * Returns { rateNaira, totalNaira, totalKobo, band, discountPct } for a
 * given plan + student count.
 */
function calculatePrice(plan, studentCount) {
  const cfg = PLANS[plan];
  if (!cfg) throw new Error(`Unknown plan: ${plan}`);

  const students = Math.max(0, Number(studentCount) || 0);

  if (!cfg.perStudentDiscountBands) {
    // Starter: flat monthly fee regardless of student count.
    const totalNaira = cfg.basePriceNaira;
    return {
      plan,
      rateNaira: cfg.basePriceNaira,
      totalNaira,
      totalKobo: totalNaira * NAIRA,
      band: 0,
      discountPct: 0,
    };
  }

  // Standard / Premium: rate declines by DISCOUNT_PER_BAND for every full
  // BAND_SIZE block of students beyond the first band, capped at MAX_DISCOUNT.
  const band = Math.floor(students / BAND_SIZE);
  const discountPct = Math.round(Math.min(band * DISCOUNT_PER_BAND, MAX_DISCOUNT) * 100) / 100;
  const rateNaira = Math.round(cfg.basePriceNaira * (1 - discountPct));
  const totalNaira = rateNaira * Math.max(students, 1);

  return {
    plan,
    rateNaira,
    totalNaira,
    totalKobo: totalNaira * NAIRA,
    band,
    discountPct,
  };
}

function getTrialLimit(plan) {
  return PLANS[plan]?.trialStudentLimit ?? 0;
}

module.exports = { PLANS, isValidPlan, calculatePrice, getTrialLimit, NAIRA };
