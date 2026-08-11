const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { normalizeEmail } = require("../utils/normalizeEmail");
const { authenticate, requireRole } = require("../middleware/auth");

// Every route here is Central Admin only.
router.use(authenticate, requireRole("central_admin"));

function sanitize(user) {
  if (!user) return user;
  const { password_hash, ...rest } = user;
  return rest;
}

/**
 * Rough per-school storage estimate. Postgres doesn't meter space per
 * tenant, so this sums pg_column_size() across the row-owning tables for a
 * school as a stand-in for "database space consumption". Good enough for a
 * relative/administrative view, not a billing-grade metric.
 */
const STORAGE_QUERY = `
  SELECT
    s.id,
    s.name,
    s.status,
    s.deleted_at,
    COALESCE(u.cnt, 0)  AS user_count,
    COALESCE(st.cnt, 0) AS student_count,
    COALESCE(r.cnt, 0)  AS result_count,
    COALESCE(c.cnt, 0)  AS class_count,
    COALESCE(u.bytes, 0) + COALESCE(st.bytes, 0) + COALESCE(r.bytes, 0) + COALESCE(c.bytes, 0) AS estimated_bytes
  FROM schools s
  LEFT JOIN (
    SELECT school_id, COUNT(*) cnt, SUM(pg_column_size(users.*)) bytes
    FROM users WHERE deleted_at IS NULL GROUP BY school_id
  ) u ON u.school_id = s.id
  LEFT JOIN (
    SELECT school_id, COUNT(*) cnt, SUM(pg_column_size(students.*)) bytes
    FROM students WHERE deleted_at IS NULL GROUP BY school_id
  ) st ON st.school_id = s.id
  LEFT JOIN (
    SELECT school_id, COUNT(*) cnt, SUM(pg_column_size(results.*)) bytes
    FROM results WHERE deleted_at IS NULL GROUP BY school_id
  ) r ON r.school_id = s.id
  LEFT JOIN (
    SELECT school_id, COUNT(*) cnt, SUM(pg_column_size(classes.*)) bytes
    FROM classes WHERE deleted_at IS NULL GROUP BY school_id
  ) c ON c.school_id = s.id
  WHERE s.deleted_at IS NULL
  ORDER BY estimated_bytes DESC NULLS LAST;
`;

// ---------- OVERVIEW ----------

// GET /api/central/overview
router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const [{ rows: schoolCount }, { rows: byRole }, { rows: storage }] = await Promise.all([
      query("SELECT COUNT(*) FROM schools WHERE deleted_at IS NULL"),
      query(
        `SELECT role, COUNT(*) FROM users WHERE deleted_at IS NULL GROUP BY role`
      ),
      query(STORAGE_QUERY),
    ]);

    const totalBytes = storage.reduce((sum, r) => sum + Number(r.estimated_bytes || 0), 0);

    res.json({
      totalSchools: Number(schoolCount[0].count),
      usersByRole: Object.fromEntries(byRole.map((r) => [r.role, Number(r.count)])),
      estimatedTotalStorageBytes: totalBytes,
      schools: storage.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        userCount: Number(r.user_count),
        studentCount: Number(r.student_count),
        resultCount: Number(r.result_count),
        classCount: Number(r.class_count),
        estimatedStorageBytes: Number(r.estimated_bytes),
      })),
    });
  })
);

// GET /api/central/storage — per-school storage/space breakdown
router.get(
  "/storage",
  asyncHandler(async (req, res) => {
    const { rows } = await query(STORAGE_QUERY);
    res.json(
      rows.map((r) => ({
        schoolId: r.id,
        name: r.name,
        status: r.status,
        userCount: Number(r.user_count),
        studentCount: Number(r.student_count),
        resultCount: Number(r.result_count),
        classCount: Number(r.class_count),
        estimatedStorageBytes: Number(r.estimated_bytes),
      }))
    );
  })
);

// ---------- SCHOOLS ----------

// GET /api/central/schools
router.get(
  "/schools",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT * FROM schools WHERE deleted_at IS NULL ORDER BY created_at DESC`
    );
    res.json(rows);
  })
);

// POST /api/central/schools — onboard a school, optionally with its first admin
router.post(
  "/schools",
  asyncHandler(async (req, res) => {
    const { name, address, motto, logoUrl, contactEmail, contactPhone,
            adminName, adminEmail, adminPassword } = req.body;
    if (!name) return res.status(400).json({ error: "School name is required" });

    const { rows: schoolRows } = await query(
      `INSERT INTO schools (name, address, motto, logo_url, contact_email, contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, address || null, motto || null, logoUrl || null, contactEmail || null, contactPhone || null]
    );
    const school = schoolRows[0];

    await query(`INSERT INTO school_info (name, address, motto, logo_url, school_id) VALUES ($1,$2,$3,$4,$5)`,
      [name, address || null, motto || null, logoUrl || null, school.id]);

    let admin = null;
    if (adminEmail && adminPassword) {
      const normalizedAdminEmail = normalizeEmail(adminEmail);
      const { rows: existing } = await query("SELECT id FROM users WHERE email = $1", [normalizedAdminEmail]);
      if (existing.length) return res.status(409).json({ error: "An account with this admin email already exists" });
      const hash = await bcrypt.hash(adminPassword, 10);
      const { rows: adminRows } = await query(
        `INSERT INTO users (name, email, password_hash, role, school_id)
         VALUES ($1,$2,$3,'admin',$4) RETURNING *`,
        [adminName || "School Admin", normalizedAdminEmail, hash, school.id]
      );
      admin = sanitize(adminRows[0]);
    }

    res.status(201).json({ school, admin });
  })
);

// GET /api/central/schools/:id
router.get(
  "/schools/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT * FROM schools WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "School not found" });

    const { rows: admins } = await query(
      "SELECT * FROM users WHERE school_id = $1 AND role = 'admin' AND deleted_at IS NULL",
      [req.params.id]
    );
    const { rows: counts } = await query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE school_id = $1 AND role = 'teacher' AND deleted_at IS NULL) AS teachers,
         (SELECT COUNT(*) FROM users WHERE school_id = $1 AND role = 'parent'  AND deleted_at IS NULL) AS parents,
         (SELECT COUNT(*) FROM students WHERE school_id = $1 AND deleted_at IS NULL) AS students,
         (SELECT COUNT(*) FROM results  WHERE school_id = $1 AND deleted_at IS NULL) AS results`,
      [req.params.id]
    );

    res.json({ school: rows[0], admins: admins.map(sanitize), counts: counts[0] });
  })
);

// PATCH /api/central/schools/:id — edit details or set status active/suspended
router.patch(
  "/schools/:id",
  asyncHandler(async (req, res) => {
    const { name, address, motto, logoUrl, contactEmail, contactPhone, status } = req.body;
    if (status && !["active", "suspended"].includes(status)) {
      return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
    }
    const { rows } = await query(
      `UPDATE schools SET
         name = COALESCE($1, name), address = COALESCE($2, address),
         motto = COALESCE($3, motto), logo_url = COALESCE($4, logo_url),
         contact_email = COALESCE($5, contact_email), contact_phone = COALESCE($6, contact_phone),
         status = COALESCE($7, status)
       WHERE id = $8 AND deleted_at IS NULL RETURNING *`,
      [name, address, motto, logoUrl, contactEmail, contactPhone, status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "School not found" });
    res.json(rows[0]);
  })
);

// DELETE /api/central/schools/:id — soft-delete the school and all its data.
// This hides it platform-wide immediately. It does NOT reach into any
// school device's local cache — that clears only when the school's own
// admin deletes the same records from within their portal.
router.delete(
  "/schools/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "UPDATE schools SET deleted_at = now(), status = 'suspended' WHERE id = $1 AND deleted_at IS NULL RETURNING id",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "School not found" });

    await Promise.all([
      query("UPDATE users SET deleted_at = now() WHERE school_id = $1 AND deleted_at IS NULL", [req.params.id]),
      query("UPDATE students SET deleted_at = now() WHERE school_id = $1 AND deleted_at IS NULL", [req.params.id]),
      query("UPDATE results SET deleted_at = now() WHERE school_id = $1 AND deleted_at IS NULL", [req.params.id]),
      query("UPDATE classes SET deleted_at = now() WHERE school_id = $1 AND deleted_at IS NULL", [req.params.id]),
    ]);

    res.status(204).send();
  })
);

// PATCH /api/central/schools/:id/restore — undo a soft-delete
router.patch(
  "/schools/:id/restore",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "UPDATE schools SET deleted_at = NULL, status = 'active' WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "School not found" });

    await Promise.all([
      query("UPDATE users SET deleted_at = NULL WHERE school_id = $1", [req.params.id]),
      query("UPDATE students SET deleted_at = NULL WHERE school_id = $1", [req.params.id]),
      query("UPDATE results SET deleted_at = NULL WHERE school_id = $1", [req.params.id]),
      query("UPDATE classes SET deleted_at = NULL WHERE school_id = $1", [req.params.id]),
    ]);
    res.json({ restored: true });
  })
);

// POST /api/central/schools/:id/admins — add/reset an admin for a school
router.post(
  "/schools/:id/admins",
  asyncHandler(async (req, res) => {
    const { name, email: rawEmail, password } = req.body;
    if (!name || !rawEmail || !password) {
      return res.status(400).json({ error: "name, email and password are required" });
    }
    const email = normalizeEmail(rawEmail);
    const { rows: school } = await query("SELECT id FROM schools WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
    if (!school.length) return res.status(404).json({ error: "School not found" });

    const { rows: existing } = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length) return res.status(409).json({ error: "An account with this email already exists" });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, role, school_id)
       VALUES ($1,$2,$3,'admin',$4) RETURNING *`,
      [name, email, hash, req.params.id]
    );
    res.status(201).json(sanitize(rows[0]));
  })
);

// ---------- USERS (admins / teachers / parents across every school) ----------

// GET /api/central/users?role=&schoolId=
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const conditions = ["deleted_at IS NULL"];
    const params = [];
    if (req.query.role) {
      params.push(req.query.role);
      conditions.push(`role = $${params.length}`);
    }
    if (req.query.schoolId) {
      params.push(req.query.schoolId);
      conditions.push(`school_id = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT * FROM users WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params
    );
    res.json(rows.map(sanitize));
  })
);

// DELETE /api/central/users/:id — soft-delete any user on the platform
router.delete(
  "/users/:id",
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "You cannot delete your own account" });
    }
    const { rows } = await query(
      "UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.status(204).send();
  })
);

// PATCH /api/central/users/:id/restore
router.patch(
  "/users/:id/restore",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "UPDATE users SET deleted_at = NULL WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(sanitize(rows[0]));
  })
);

// POST /api/central/central-admins — create another Central Admin
router.post(
  "/central-admins",
  asyncHandler(async (req, res) => {
    const { name, email: rawEmail, password } = req.body;
    if (!name || !rawEmail || !password) {
      return res.status(400).json({ error: "name, email and password are required" });
    }
    const email = normalizeEmail(rawEmail);
    const { rows: existing } = await query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length) return res.status(409).json({ error: "An account with this email already exists" });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, role, school_id)
       VALUES ($1,$2,$3,'central_admin',NULL) RETURNING *`,
      [name, email, hash]
    );
    res.status(201).json(sanitize(rows[0]));
  })
);

// ---------- STUDENTS & RESULTS (cross-school visibility + soft delete) ----------

// GET /api/central/students?schoolId=
router.get(
  "/students",
  asyncHandler(async (req, res) => {
    const conditions = ["deleted_at IS NULL"];
    const params = [];
    if (req.query.schoolId) {
      params.push(req.query.schoolId);
      conditions.push(`school_id = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT * FROM students WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params
    );
    res.json(rows);
  })
);

// DELETE /api/central/students/:id
router.delete(
  "/students/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "UPDATE students SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Student not found" });
    res.status(204).send();
  })
);

// GET /api/central/results?schoolId=
router.get(
  "/results",
  asyncHandler(async (req, res) => {
    const conditions = ["deleted_at IS NULL"];
    const params = [];
    if (req.query.schoolId) {
      params.push(req.query.schoolId);
      conditions.push(`school_id = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT * FROM results WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params
    );
    res.json(rows);
  })
);

// DELETE /api/central/results/:id
router.delete(
  "/results/:id",
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "UPDATE results SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Result not found" });
    res.status(204).send();
  })
);

// ---------- PLATFORM SETTINGS ----------

// GET /api/central/settings
router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT key, value, updated_at FROM platform_settings ORDER BY key");
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  })
);

// PUT /api/central/settings/:key
router.put(
  "/settings/:key",
  asyncHandler(async (req, res) => {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: "value is required" });
    const { rows } = await query(
      `INSERT INTO platform_settings (key, value, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3
       RETURNING *`,
      [req.params.key, JSON.stringify(value), req.user.id]
    );
    res.json(rows[0]);
  })
);

module.exports = router;
