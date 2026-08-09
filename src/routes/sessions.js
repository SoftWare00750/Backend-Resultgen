const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate);

// GET /api/sessions
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM sessions WHERE school_id = $1 ORDER BY created_at DESC",
      [req.user.schoolId]
    );
    res.json(rows);
  })
);

// GET /api/sessions/active
router.get(
  "/active",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "SELECT * FROM sessions WHERE school_id = $1 AND is_active = TRUE LIMIT 1",
      [req.user.schoolId]
    );
    res.json(rows[0] || null);
  })
);

// POST /api/sessions (admin only)
router.post(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { year, isActive = false } = req.body;
    if (!year) return res.status(400).json({ error: "year is required" });
    try {
      if (isActive) {
        await query(
          "UPDATE sessions SET is_active = FALSE WHERE is_active = TRUE AND school_id = $1",
          [req.user.schoolId]
        );
      }
      const { rows } = await query(
        "INSERT INTO sessions (year, is_active, school_id) VALUES ($1,$2,$3) RETURNING *",
        [year, isActive, req.user.schoolId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: `Session ${year} already exists` });
      throw err;
    }
  })
);

// PATCH /api/sessions/:id/activate (admin only)
router.patch(
  "/:id/activate",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await query(
      "UPDATE sessions SET is_active = FALSE WHERE is_active = TRUE AND school_id = $1",
      [req.user.schoolId]
    );
    const { rows } = await query(
      "UPDATE sessions SET is_active = TRUE WHERE id = $1 AND school_id = $2 RETURNING *",
      [req.params.id, req.user.schoolId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Session not found" });
    res.json(rows[0]);
  })
);

// DELETE /api/sessions/:id (admin only)
router.delete(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "SELECT is_active FROM sessions WHERE id = $1 AND school_id = $2",
      [req.params.id, req.user.schoolId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Session not found" });
    if (rows[0].is_active) return res.status(400).json({ error: "Cannot delete the active session" });
    await query("DELETE FROM sessions WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    res.status(204).send();
  })
);

module.exports = router;
