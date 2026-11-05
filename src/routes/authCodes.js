const crypto = require("crypto");
const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate, requireRole("admin"));

// Codes are now reusable until they expire, so use a CSPRNG rather than Math.random().
function generateSixDigitCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

// GET /api/auth-codes
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM auth_codes WHERE school_id = $1 ORDER BY created_at DESC",
      [req.user.schoolId]
    );
    res.json(rows);
  })
);

// POST /api/auth-codes  { role }
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    if (!["teacher", "parent"].includes(role)) {
      return res.status(400).json({ error: "Invalid role — Admin/School Owner/School Proprietor accounts no longer use pre-issued codes" });
    }
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // `code` is globally UNIQUE; retry on the (rare) collision instead of 500ing.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { rows } = await query(
          `INSERT INTO auth_codes (code, role, expires_at, created_by, school_id)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [generateSixDigitCode(), role, expiresAt.toISOString(), req.user.id, req.user.schoolId]
        );
        return res.status(201).json(rows[0]);
      } catch (err) {
        if (err.code !== "23505") throw err; // not a unique violation
      }
    }
    res.status(503).json({ error: "Could not generate a unique code, please try again" });
  })
);

// DELETE /api/auth-codes/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "DELETE FROM auth_codes WHERE id = $1 AND school_id = $2 RETURNING id",
      [req.params.id, req.user.schoolId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Auth code not found" });
    res.status(204).send();
  })
);

module.exports = router;
