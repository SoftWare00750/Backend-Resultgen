require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const authCodeRoutes = require("./routes/authCodes");
const classRoutes = require("./routes/classes");
const studentRoutes = require("./routes/students");
const resultRoutes = require("./routes/results");
const sessionRoutes = require("./routes/sessions");
const schoolRoutes = require("./routes/school");

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*", credentials: true }));
app.use(express.json({ limit: "10mb" })); // generous limit for base64 logos/signatures/photos

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/auth-codes", authCodeRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/results", resultRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/school", schoolRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Centralized error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 RGS backend listening on http://localhost:${PORT}`);
});
