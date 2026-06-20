const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate, requireRole("admin"));

function generateSixDigitCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// GET /api/auth-codes
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT * FROM auth_codes ORDER BY created_at DESC");
    res.json(rows);
  })
);

// POST /api/auth-codes  { role }
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    if (!["admin", "teacher", "parent"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    const code = generateSixDigitCode();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const { rows } = await query(
      `INSERT INTO auth_codes (code, role, expires_at, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [code, role, expiresAt.toISOString(), req.user.id]
    );
    res.status(201).json(rows[0]);
  })
);

// DELETE /api/auth-codes/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await query("DELETE FROM auth_codes WHERE id = $1", [req.params.id]);
    res.status(204).send();
  })
);

module.exports = router;
