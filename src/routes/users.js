const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate);

function sanitize(user) {
  const { password_hash, ...rest } = user;
  return rest;
}

// GET /api/users  (admin only)
router.get(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT * FROM users ORDER BY created_at DESC");
    res.json(rows.map(sanitize));
  })
);

// DELETE /api/users/:id (admin only, cannot delete self)
router.delete(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "You cannot delete your own account" });
    }
    await query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.status(204).send();
  })
);

// PATCH /api/users/:id
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (req.user.role !== "admin" && req.user.id !== req.params.id) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    const { name, phone, signatureDataUrl } = req.body;
    const { rows } = await query(
      `UPDATE users SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         signature_url = COALESCE($3, signature_url)
       WHERE id = $4 RETURNING *`,
      [name, phone, signatureDataUrl, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(sanitize(rows[0]));
  })
);

module.exports = router;
