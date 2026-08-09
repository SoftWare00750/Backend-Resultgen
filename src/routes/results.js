const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");
const { calculateGrade } = require("../utils/grading");

router.use(authenticate);

async function recalcPositions(schoolId, className, term, session, resultType) {
  const { rows } = await query(
    `SELECT id, average_score FROM results
     WHERE school_id = $1 AND class = $2 AND term = $3 AND session = $4 AND result_type = $5
       AND deleted_at IS NULL
     ORDER BY average_score DESC NULLS LAST`,
    [schoolId, className, term, session, resultType]
  );
  for (let i = 0; i < rows.length; i++) {
    await query("UPDATE results SET position = $1 WHERE id = $2", [i + 1, rows[i].id]);
  }
}

// GET /api/results (?studentId=, ?class=, ?term=, ?session=, ?publishedOnly=true) — scoped by role + school
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const conditions = ["school_id = $1", "deleted_at IS NULL"];
    const params = [req.user.schoolId];

    if (req.user.role === "teacher") {
      params.push(req.user.id);
      conditions.push(`created_by = $${params.length}`);
    }

    if (req.user.role === "parent") {
      conditions.push(
        `student_id IN (SELECT id FROM students WHERE parent_id = $${params.length + 1})`
      );
      params.push(req.user.id);
      conditions.push("published = TRUE");
    }

    if (req.query.studentId) {
      params.push(req.query.studentId);
      conditions.push(`student_id = $${params.length}`);
    }
    if (req.query.class) {
      params.push(req.query.class);
      conditions.push(`class = $${params.length}`);
    }
    if (req.query.term) {
      params.push(req.query.term);
      conditions.push(`term = $${params.length}`);
    }
    if (req.query.session) {
      params.push(req.query.session);
      conditions.push(`session = $${params.length}`);
    }
    if (req.query.publishedOnly === "true") {
      conditions.push("published = TRUE");
    }

    const { rows } = await query(
      `SELECT * FROM results WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      params
    );
    res.json(rows);
  })
);

// POST /api/results  (teacher/admin only)
router.post(
  "/",
  requireRole("admin", "teacher"),
  asyncHandler(async (req, res) => {
    const {
      studentId, studentName, admissionNumber, class: className,
      term, session, resultType, subjects = [],
      teacherComment, principalComment, attendance, affectiveDomain,
      psychomotorSkills, house, club, age,
    } = req.body;

    if (!studentId || !className || !term || !session || !resultType) {
      return res.status(400).json({ error: "Missing required result fields" });
    }

    const totalScore = subjects.reduce((sum, s) => sum + (Number(s.score) || 0), 0);
    const averageScore = subjects.length ? totalScore / subjects.length : 0;
    const { grade } = calculateGrade(averageScore);

    const { rows } = await query(
      `INSERT INTO results
        (student_id, student_name, admission_number, class, term, session, result_type,
         subjects, total_score, average_score, overall_grade, teacher_comment, principal_comment,
         published, attendance, affective_domain, psychomotor_skills, house, club, age, created_by, school_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [
        studentId, studentName, admissionNumber, className, term, session, resultType,
        JSON.stringify(subjects), totalScore, averageScore.toFixed(2), grade,
        teacherComment || null, principalComment || null,
        JSON.stringify(attendance || { opened: 0, present: 0, absent: 0 }),
        JSON.stringify(affectiveDomain || {}), JSON.stringify(psychomotorSkills || {}),
        house || null, club || null, age || null, req.user.id, req.user.schoolId,
      ]
    );

    await recalcPositions(req.user.schoolId, className, term, session, resultType);
    const { rows: finalRow } = await query("SELECT * FROM results WHERE id = $1", [rows[0].id]);
    res.status(201).json(finalRow[0]);
  })
);

// PATCH /api/results/:id  (teacher/admin only) — also used for publish/unpublish
router.patch(
  "/:id",
  requireRole("admin", "teacher"),
  asyncHandler(async (req, res) => {
    const { rows: existingRows } = await query(
      "SELECT * FROM results WHERE id = $1 AND school_id = $2",
      [req.params.id, req.user.schoolId]
    );
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Result not found" });

    const { subjects, teacherComment, principalComment, published,
            attendance, affectiveDomain, psychomotorSkills, house, club, age } = req.body;

    let totalScore = existing.total_score;
    let averageScore = existing.average_score;
    let overallGrade = existing.overall_grade;

    if (subjects) {
      totalScore = subjects.reduce((sum, s) => sum + (Number(s.score) || 0), 0);
      averageScore = subjects.length ? totalScore / subjects.length : 0;
      overallGrade = calculateGrade(averageScore).grade;
      averageScore = averageScore.toFixed(2);
    }

    const { rows } = await query(
      `UPDATE results SET
         subjects = COALESCE($1, subjects),
         total_score = $2,
         average_score = $3,
         overall_grade = $4,
         teacher_comment = COALESCE($5, teacher_comment),
         principal_comment = COALESCE($6, principal_comment),
         published = COALESCE($7, published),
         attendance = COALESCE($8, attendance),
         affective_domain = COALESCE($9, affective_domain),
         psychomotor_skills = COALESCE($10, psychomotor_skills),
         house = COALESCE($11, house),
         club = COALESCE($12, club),
         age = COALESCE($13, age)
       WHERE id = $14 RETURNING *`,
      [
        subjects ? JSON.stringify(subjects) : null, totalScore, averageScore, overallGrade,
        teacherComment, principalComment, published,
        attendance ? JSON.stringify(attendance) : null,
        affectiveDomain ? JSON.stringify(affectiveDomain) : null,
        psychomotorSkills ? JSON.stringify(psychomotorSkills) : null,
        house, club, age, req.params.id,
      ]
    );

    if (subjects) {
      await recalcPositions(req.user.schoolId, existing.class, existing.term, existing.session, existing.result_type);
      const { rows: refreshed } = await query("SELECT * FROM results WHERE id = $1", [req.params.id]);
      return res.json(refreshed[0]);
    }
    res.json(rows[0]);
  })
);

// DELETE /api/results/:id — real, permanent delete by the school's own admin/teacher
router.delete(
  "/:id",
  requireRole("admin", "teacher"),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "DELETE FROM results WHERE id = $1 AND school_id = $2 RETURNING id",
      [req.params.id, req.user.schoolId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Result not found" });
    res.status(204).send();
  })
);

module.exports = router;
