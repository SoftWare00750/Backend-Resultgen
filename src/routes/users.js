const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate);

function sanitize(user) {
  const { password_hash, ...rest } = user;
  return rest;
}

// GET /api/users  (admin only — scoped to their own school)
router.get(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM users WHERE school_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC",
      [req.user.schoolId]
    );
    res.json(rows.map(sanitize));
  })
);

// DELETE /api/users/:id (admin only, own school, cannot delete self)
// This is a real, permanent delete performed by the school's own admin.
router.delete(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "You cannot delete your own account" });
    }
    const { rows } = await query(
      "DELETE FROM users WHERE id = $1 AND school_id = $2 RETURNING id",
      [req.params.id, req.user.schoolId]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
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
    const conditions = ["id = $4"];
    const params = [name, phone, signatureDataUrl, req.params.id];
    // Admins may only edit users within their own school.
    if (req.user.role === "admin") {
      params.push(req.user.schoolId);
      conditions.push(`school_id = $${params.length}`);
    }
    const { rows } = await query(
      `UPDATE users SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         signature_url = COALESCE($3, signature_url)
       WHERE ${conditions.join(" AND ")} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(sanitize(rows[0]));
  })
);

module.exports = router;
