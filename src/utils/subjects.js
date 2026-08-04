const NURSERY_SUBJECTS = ["Numeracy", "Literacy", "Creative Arts", "Physical Development", "Social Skills"];
const KINDERGARTEN_SUBJECTS = ["Mathematics", "English Language", "Phonics", "Science", "Creative Arts", "Physical Education"];
const PRIMARY_SUBJECTS = [
  "Mathematics", "English Language", "Science", "Social Studies", "Religious Knowledge",
  "Civic Education", "Physical Education", "Creative Arts", "Computer Studies", "French", "Handwriting",
];
const JSS_SUBJECTS = [
  "Mathematics", "English Language", "Basic Science", "Basic Technology", "Social Studies",
  "Civic Education", "Christian Religious Studies", "Islamic Religious Studies",
  "Physical & Health Education", "French Language", "Yoruba / Igbo / Hausa", "Agricultural Science",
  "Home Economics", "Computer Studies", "Fine Arts", "Music", "Business Studies",
];
const SSS_SUBJECTS = [
  "Mathematics", "English Language", "Economics", "Government", "Literature in English",
  "Christian Religious Studies", "Islamic Religious Studies", "Further Mathematics", "Physics",
  "Chemistry", "Biology", "Agricultural Science", "Commerce", "Accounting", "Geography",
  "French Language", "Computer Studies", "Civic Education", "Physical & Health Education",
];

function getSubjectsByCategory(className) {
  if (className.includes("Nursery")) return NURSERY_SUBJECTS;
  if (className.includes("Kindergarten")) return KINDERGARTEN_SUBJECTS;
  if (className.startsWith("JSS")) return JSS_SUBJECTS;
  if (className.startsWith("SS")) return SSS_SUBJECTS;
  return PRIMARY_SUBJECTS;
}

module.exports = { getSubjectsByCategory };
