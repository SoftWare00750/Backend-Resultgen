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
    let sql = "SELECT * FROM classes";
    const params = [];
    if (req.user.role === "teacher") {
      sql += " WHERE assigned_teacher_id = $1";
      params.push(req.user.id);
    }
    sql += " ORDER BY name";
    const { rows } = await query(sql, params);
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
        `INSERT INTO classes (name, category, assigned_teacher_id, subjects)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [name, category, assignedTeacherId || null, JSON.stringify(finalSubjects)]
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
       WHERE id = $3 RETURNING *`,
      [assignedTeacherId, subjects ? JSON.stringify(subjects) : null, req.params.id]
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
    await query("DELETE FROM classes WHERE id = $1", [req.params.id]);
    res.status(204).send();
  })
);

module.exports = router;
