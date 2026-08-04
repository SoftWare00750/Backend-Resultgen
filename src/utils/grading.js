const GRADING_SCALE = [
  { min: 75, max: 100, grade: "A", remark: "Excellent" },
  { min: 65, max: 74, grade: "B", remark: "Very Good" },
  { min: 55, max: 64, grade: "C", remark: "Good" },
  { min: 45, max: 54, grade: "D", remark: "Fair" },
  { min: 40, max: 44, grade: "E", remark: "Pass" },
  { min: 0, max: 39, grade: "F", remark: "Fail" },
];

function calculateGrade(score) {
  const g = GRADING_SCALE.find((g) => score >= g.min && score <= g.max);
  return g ? { grade: g.grade, remark: g.remark } : { grade: "F", remark: "Fail" };
}

module.exports = { GRADING_SCALE, calculateGrade };
