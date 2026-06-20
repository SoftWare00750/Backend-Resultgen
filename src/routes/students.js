const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate);

// GET /api/students  (?class=, ?parentId=) — scoped by role
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.user.role === "parent") {
      params.push(req.user.id);
      conditions.push(`parent_id = $${params.length}`);
    } else if (req.query.parentId) {
      params.push(req.query.parentId);
      conditions.push(`parent_id = $${params.length}`);
    }

    if (req.query.class) {
      params.push(req.query.class);
      conditions.push(`class = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await query(`SELECT * FROM students ${where} ORDER BY name`, params);
    res.json(rows);
  })
);

// GET /api/students/check-admission/:admissionNumber
router.get(
  "/check-admission/:admissionNumber",
  asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT id FROM students WHERE admission_number = $1", [
      req.params.admissionNumber,
    ]);
    res.json({ exists: rows.length > 0 });
  })
);

// POST /api/students
router.post(
  "/",
  requireRole("admin", "teacher", "parent"),
  asyncHandler(async (req, res) => {
    const {
      name, admissionNumber, class: className, parentId,
      dateOfBirth, gender, guardianName, guardianPhone, address, photoUrl,
    } = req.body;

    if (!name || !admissionNumber || !className) {
      return res.status(400).json({ error: "name, admissionNumber and class are required" });
    }

    const finalParentId = req.user.role === "parent" ? req.user.id : parentId;

    try {
      const { rows } = await query(
        `INSERT INTO students
          (name, admission_number, class, parent_id, date_of_birth, gender, guardian_name, guardian_phone, address, photo_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [name, admissionNumber, className, finalParentId || null, dateOfBirth || null,
         gender || null, guardianName || null, guardianPhone || null, address || null, photoUrl || null]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Admission number already exists" });
      throw err;
    }
  })
);

// PATCH /api/students/:id
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const {
      name, class: className, dateOfBirth, gender,
      guardianName, guardianPhone, address, photoUrl,
    } = req.body;

    const { rows } = await query(
      `UPDATE students SET
         name = COALESCE($1, name),
         class = COALESCE($2, class),
         date_of_birth = COALESCE($3, date_of_birth),
         gender = COALESCE($4, gender),
         guardian_name = COALESCE($5, guardian_name),
         guardian_phone = COALESCE($6, guardian_phone),
         address = COALESCE($7, address),
         photo_url = COALESCE($8, photo_url)
       WHERE id = $9 RETURNING *`,
      [name, className, dateOfBirth, gender, guardianName, guardianPhone, address, photoUrl, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Student not found" });
    res.json(rows[0]);
  })
);

// DELETE /api/students/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await query("DELETE FROM students WHERE id = $1", [req.params.id]);
    res.status(204).send();
  })
);

module.exports = router;
