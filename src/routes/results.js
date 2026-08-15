const router = require("express").Router();
const { query } = require("../db/pool");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");
const { calculateGrade } = require("../utils/grading");
const overflow = require("../utils/dbOverflow");
const { isUuid } = require("../utils/isUuid");

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
      // A non-UUID studentId (e.g. a stale "local_<timestamp>" placeholder)
      // can never match a real row — short-circuit instead of letting it
      // hit Postgres and throw a type-cast error.
      if (!isUuid(req.query.studentId)) return res.json([]);
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

    // Merge in anything that got written to the Google Sheets overflow
    // store while Postgres was full, so it doesn't just disappear from
    // view. Best-effort: if Sheets is unreachable, fall back to DB-only
    // results rather than failing the whole request.
    let combined = rows;
    if (overflow.isConfigured()) {
      try {
        const overflowRows = await overflow.results.list(req.user.schoolId, (r) => {
          if (req.user.role === "teacher" && r.created_by !== req.user.id) return false;
          if (req.user.role === "parent" && !r.published) return false;
          if (req.query.studentId && r.student_id !== req.query.studentId) return false;
          if (req.query.class && r.class !== req.query.class) return false;
          if (req.query.term && r.term !== req.query.term) return false;
          if (req.query.session && r.session !== req.query.session) return false;
          if (req.query.publishedOnly === "true" && !r.published) return false;
          return true;
        });
        combined = [...overflowRows, ...rows].sort(
          (a, b) => new Date(b.created_at) - new Date(a.created_at)
        );
      } catch (err) {
        console.error("Google Sheets overflow read failed (showing DB results only):", err.message);
      }
    }

    res.json(combined);
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

    // Keep this in sync with the `result_type` Postgres enum (schema.sql) and
    // the frontend's ResultType union (src/lib/types/index.ts) / zod schema
    // (src/lib/validation.ts). Validating here turns a mismatch into a clear
    // 400 instead of a raw `invalid input value for enum result_type: "..."`
    // error bubbling up from Postgres.
    const VALID_RESULT_TYPES = ["CAT1", "CAT2", "Examination", "Midterm"];
    if (!VALID_RESULT_TYPES.includes(resultType)) {
      return res.status(400).json({
        error: `Invalid result type "${resultType}". Must be one of: ${VALID_RESULT_TYPES.join(", ")}.`,
      });
    }

    // `student_id` is a UUID column referencing students(id). A malformed id
    // here (e.g. a "local_<timestamp>" placeholder left over from a student
    // record that never actually made it to the database) would otherwise
    // reach Postgres and fail as a raw, confusing type-cast error. Catch it
    // early with a message that tells the teacher what to actually do.
    if (!isUuid(studentId)) {
      return res.status(400).json({
        error:
          "This student record isn't saved to the database yet, so a result can't be attached to it. " +
          "Please re-add the student from the Students page and try again.",
      });
    }

    const totalScore = subjects.reduce((sum, s) => sum + (Number(s.score) || 0), 0);
    const averageScore = subjects.length ? totalScore / subjects.length : 0;
    const { grade } = calculateGrade(averageScore);
    const attendanceData = attendance || { opened: 0, present: 0, absent: 0 };

    let insertedId;
    try {
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
          JSON.stringify(attendanceData),
          JSON.stringify(affectiveDomain || {}), JSON.stringify(psychomotorSkills || {}),
          house || null, club || null, age || null, req.user.id, req.user.schoolId,
        ]
      );
      insertedId = rows[0].id;
    } catch (err) {
      if (!overflow.isStorageFullError(err)) throw err;
      if (!overflow.isConfigured()) {
        console.error("Postgres is full and Google Sheets overflow is not configured:", err.message);
        throw err;
      }

      console.warn(
        `⚠ Postgres is out of storage — writing result for student ${studentId} to the ` +
          "Google Sheets overflow store instead."
      );
      const fallbackRow = await overflow.results.create({
        student_id: studentId,
        student_name: studentName,
        admission_number: admissionNumber,
        class: className,
        term,
        session,
        result_type: resultType,
        subjects,
        total_score: totalScore,
        average_score: averageScore.toFixed(2),
        overall_grade: grade,
        position: null,
        teacher_comment: teacherComment || null,
        principal_comment: principalComment || null,
        published: false,
        attendance: attendanceData,
        affective_domain: affectiveDomain || {},
        psychomotor_skills: psychomotorSkills || {},
        house: house || null,
        club: club || null,
        age: age || null,
        created_by: req.user.id,
        school_id: req.user.schoolId,
      });
      return res.status(201).json(fallbackRow);
    }

    await recalcPositions(req.user.schoolId, className, term, session, resultType);
    const { rows: finalRow } = await query("SELECT * FROM results WHERE id = $1", [insertedId]);
    res.status(201).json(finalRow[0]);
  })
);

// PATCH /api/results/:id  (teacher/admin only) — also used for publish/unpublish
router.patch(
  "/:id",
  requireRole("admin", "teacher"),
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: "Result not found" });
    }
    const { rows: existingRows } = await query(
      "SELECT * FROM results WHERE id = $1 AND school_id = $2",
      [req.params.id, req.user.schoolId]
    );
    let existing = existingRows[0];

    // Not in Postgres — check whether it was written to the Sheets overflow
    // store instead (i.e. it was created while the DB was full).
    let isOverflowRow = false;
    if (!existing && overflow.isConfigured()) {
      const overflowExisting = await overflow.results.findById(req.params.id);
      if (overflowExisting && overflowExisting.school_id === req.user.schoolId) {
        existing = overflowExisting;
        isOverflowRow = true;
      }
    }
    if (!existing) return res.status(404).json({ error: "Result not found" });

    const { subjects, teacherComment, principalComment, published,
            attendance, affectiveDomain, psychomotorSkills, house, club, age } = req.body;

    if (isOverflowRow) {
      let totalScore = existing.total_score;
      let averageScore = existing.average_score;
      let overallGrade = existing.overall_grade;
      if (subjects) {
        totalScore = subjects.reduce((sum, s) => sum + (Number(s.score) || 0), 0);
        averageScore = subjects.length ? (totalScore / subjects.length).toFixed(2) : "0.00";
        overallGrade = calculateGrade(Number(averageScore)).grade;
      }
      const updated = await overflow.results.update(req.params.id, {
        subjects: subjects || existing.subjects,
        total_score: totalScore,
        average_score: averageScore,
        overall_grade: overallGrade,
        teacher_comment: teacherComment !== undefined ? teacherComment : existing.teacher_comment,
        principal_comment: principalComment !== undefined ? principalComment : existing.principal_comment,
        published: published !== undefined ? published : existing.published,
        attendance: attendance || existing.attendance,
        affective_domain: affectiveDomain || existing.affective_domain,
        psychomotor_skills: psychomotorSkills || existing.psychomotor_skills,
        house: house !== undefined ? house : existing.house,
        club: club !== undefined ? club : existing.club,
        age: age !== undefined ? age : existing.age,
      });
      return res.json(updated);
    }

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
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: "Result not found" });
    }
    const { rows } = await query(
      "DELETE FROM results WHERE id = $1 AND school_id = $2 RETURNING id",
      [req.params.id, req.user.schoolId]
    );
    if (rows[0]) return res.status(204).send();

    if (overflow.isConfigured()) {
      const existing = await overflow.results.findById(req.params.id);
      if (existing && existing.school_id === req.user.schoolId) {
        await overflow.results.remove(req.params.id);
        return res.status(204).send();
      }
    }

    res.status(404).json({ error: "Result not found" });
  })
);

module.exports = router;