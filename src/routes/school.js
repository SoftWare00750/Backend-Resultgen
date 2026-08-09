const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate);

// GET /api/school — this user's own school branding info
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT * FROM school_info WHERE school_id = $1", [req.user.schoolId]);
    res.json(rows[0] || null);
  })
);

// PUT /api/school (admin only) — upsert this school's single info row
router.put(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name, address, motto, logoUrl } = req.body;
    if (!name) return res.status(400).json({ error: "School name is required" });

    const { rows: existing } = await query("SELECT id FROM school_info WHERE school_id = $1", [req.user.schoolId]);
    if (existing.length === 0) {
      const { rows } = await query(
        `INSERT INTO school_info (name, address, motto, logo_url, school_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, address || null, motto || null, logoUrl || null, req.user.schoolId]
      );
      return res.status(201).json(rows[0]);
    }
    const { rows } = await query(
      `UPDATE school_info SET name=$1, address=$2, motto=$3, logo_url=$4 WHERE id=$5 RETURNING *`,
      [name, address || null, motto || null, logoUrl || null, existing[0].id]
    );
    res.json(rows[0]);
  })
);

module.exports = router;
