const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");
const { getSubjectsByCategory } = require("../utils/subjects");

router.use(authenticate);

// GET /api/classes
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions = ["school_id = $1", "deleted_at IS NULL"];
    const params = [req.user.schoolId];
    if (req.user.role === "teacher") {
      params.push(req.user.id);
      conditions.push(`assigned_teacher_id = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT * FROM classes WHERE ${conditions.join(" AND ")} ORDER BY name`,
      params
    );
    res.json(rows);
  })
);

// POST /api/classes (admin only)
router.post(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { name, category, assignedTeacherId, subjects } = req.body;
    if (!name || !category) return res.status(400).json({ error: "name and category are required" });

    const finalSubjects = subjects && subjects.length ? subjects : getSubjectsByCategory(name);
    try {
      const { rows } = await query(
        `INSERT INTO classes (name, category, assigned_teacher_id, subjects, school_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, category, assignedTeacherId || null, JSON.stringify(finalSubjects), req.user.schoolId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: `Class "${name}" already exists` });
      throw err;
    }
  })
);

// PATCH /api/classes/:id (admin only)
router.patch(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { assignedTeacherId, subjects } = req.body;
    const { rows } = await query(
      `UPDATE classes SET
         assigned_teacher_id = COALESCE($1, assigned_teacher_id),
         subjects = COALESCE($2, subjects)
       WHERE id = $3 AND school_id = $4 RETURNING *`,
      [assignedTeacherId, subjects ? JSON.stringify(subjects) : null, req.params.id, req.user.schoolId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Class not found" });
    res.json(rows[0]);
  })
);

// DELETE /api/classes/:id (admin only)
router.delete(
  "/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "DELETE FROM classes WHERE id = $1 AND school_id = $2 RETURNING id",
      [req.params.id, req.user.schoolId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Class not found" });
    res.status(204).send();
  })
);

module.exports = router;
