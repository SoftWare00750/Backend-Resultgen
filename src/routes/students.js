const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");
const overflow = require("../utils/dbOverflow");
const { isUuid } = require("../utils/isUuid");

router.use(authenticate);

// GET /api/students  (?class=, ?parentId=) — scoped by role and school
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions = ["school_id = $1", "deleted_at IS NULL"];
    const params = [req.user.schoolId];

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

    const { rows } = await query(
      `SELECT * FROM students WHERE ${conditions.join(" AND ")} ORDER BY name`,
      params
    );

    // Merge in students written to the Sheets overflow store while
    // Postgres was full. Best-effort — Sheets being unreachable shouldn't
    // break normal reads.
    let combined = rows;
    if (overflow.isConfigured()) {
      try {
        const overflowRows = await overflow.students.list(req.user.schoolId, (r) => {
          if (req.user.role === "parent" && r.parent_id !== req.user.id) return false;
          if (req.query.parentId && r.parent_id !== req.query.parentId) return false;
          if (req.query.class && r.class !== req.query.class) return false;
          return true;
        });
        combined = [...rows, ...overflowRows].sort((a, b) =>
          String(a.name).localeCompare(String(b.name))
        );
      } catch (err) {
        console.error("Google Sheets overflow read failed (showing DB students only):", err.message);
      }
    }

    res.json(combined);
  })
);

// GET /api/students/check-admission/:admissionNumber
router.get(
  "/check-admission/:admissionNumber",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "SELECT id FROM students WHERE admission_number = $1 AND school_id = $2",
      [req.params.admissionNumber, req.user.schoolId]
    );
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
          (name, admission_number, class, parent_id, date_of_birth, gender, guardian_name, guardian_phone, address, photo_url, school_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [name, admissionNumber, className, finalParentId || null, dateOfBirth || null,
         gender || null, guardianName || null, guardianPhone || null, address || null, photoUrl || null,
         req.user.schoolId]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Admission number already exists" });

      if (overflow.isStorageFullError(err) && overflow.isConfigured()) {
        console.warn(
          `⚠ Postgres is out of storage — writing student "${name}" to the Google Sheets overflow store instead.`
        );
        const fallbackRow = await overflow.students.create({
          name, admission_number: admissionNumber, class: className,
          parent_id: finalParentId || null, date_of_birth: dateOfBirth || null,
          gender: gender || null, guardian_name: guardianName || null,
          guardian_phone: guardianPhone || null, address: address || null,
          photo_url: photoUrl || null, school_id: req.user.schoolId,
        });
        return res.status(201).json(fallbackRow);
      }
      throw err;
    }
  })
);

// PATCH /api/students/:id
router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: "Student not found" });
    }

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
       WHERE id = $9 AND school_id = $10 RETURNING *`,
      [name, className, dateOfBirth, gender, guardianName, guardianPhone, address, photoUrl,
       req.params.id, req.user.schoolId]
    );
    if (rows[0]) return res.json(rows[0]);

    if (overflow.isConfigured()) {
      const existing = await overflow.students.findById(req.params.id);
      if (existing && existing.school_id === req.user.schoolId) {
        const updated = await overflow.students.update(req.params.id, {
          name: name !== undefined ? name : existing.name,
          class: className !== undefined ? className : existing.class,
          date_of_birth: dateOfBirth !== undefined ? dateOfBirth : existing.date_of_birth,
          gender: gender !== undefined ? gender : existing.gender,
          guardian_name: guardianName !== undefined ? guardianName : existing.guardian_name,
          guardian_phone: guardianPhone !== undefined ? guardianPhone : existing.guardian_phone,
          address: address !== undefined ? address : existing.address,
          photo_url: photoUrl !== undefined ? photoUrl : existing.photo_url,
        });
        return res.json(updated);
      }
    }

    res.status(404).json({ error: "Student not found" });
  })
);

// DELETE /api/students/:id — real, permanent delete by the school's own admin/teacher
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: "Student not found" });
    }
    const { rows } = await query(
      "DELETE FROM students WHERE id = $1 AND school_id = $2 RETURNING id",
      [req.params.id, req.user.schoolId]
    );
    if (rows[0]) return res.status(204).send();

    if (overflow.isConfigured()) {
      const existing = await overflow.students.findById(req.params.id);
      if (existing && existing.school_id === req.user.schoolId) {
        await overflow.students.remove(req.params.id);
        return res.status(204).send();
      }
    }

    res.status(404).json({ error: "Student not found" });
  })
);

module.exports = router;