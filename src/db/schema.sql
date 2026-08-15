-- ============================================================
-- Result Generation System (RGS) — PostgreSQL schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------- ENUM TYPES ----------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'teacher', 'parent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE class_category AS ENUM ('Nursery', 'Kindergarten', 'Primary', 'JSS', 'SSS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE term_type AS ENUM ('First', 'Second', 'Third');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE result_type AS ENUM ('Midterm', 'Examination');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE gender_type AS ENUM ('Male', 'Female');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- USERS ----------
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(255) NOT NULL,
  email            VARCHAR(255) NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  role             user_role NOT NULL,
  phone            VARCHAR(20),
  assigned_classes JSONB NOT NULL DEFAULT '[]',
  signature_url    TEXT,            -- base64 or storage URL
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ---------- PLAN TYPE ----------
DO $$ BEGIN
  CREATE TYPE plan_type AS ENUM ('starter', 'standard', 'premium');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- SCHOOL INFO (single row, but keyed for multi-tenant future) ----------
CREATE TABLE IF NOT EXISTS school_info (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  address     VARCHAR(500),
  motto       VARCHAR(255),
  logo_url    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- AUTH CODES ----------
CREATE TABLE IF NOT EXISTS auth_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        VARCHAR(6) NOT NULL UNIQUE,
  role        user_role NOT NULL,
  is_used     BOOLEAN NOT NULL DEFAULT FALSE,
  used_by     VARCHAR(255),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_code ON auth_codes(code);

-- ---------- ADMIN SIGNUP CODES ----------
-- Separate from auth_codes: these are the codes the *system* emails to a
-- prospective Admin/School Owner/School Proprietor to verify their email
-- during registration (before an account or auth_codes even exist for
-- their school). One row per email address; re-requesting overwrites it
-- subject to a resend cooldown.
CREATE TABLE IF NOT EXISTS admin_signup_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  code           VARCHAR(6) NOT NULL,
  is_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_signup_codes_email ON admin_signup_codes(email);

-- ---------- SUBSCRIPTIONS (one per Admin / school) ----------
CREATE TABLE IF NOT EXISTS subscriptions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan                      plan_type NOT NULL,
  status                    subscription_status NOT NULL DEFAULT 'trialing',
  student_limit             INTEGER,              -- null once trial converts to paid, unlimited-ish
  trial_student_limit       INTEGER NOT NULL,      -- 10 / 5 / 8 depending on plan
  trial_ends_at             TIMESTAMPTZ,
  paystack_customer_code    VARCHAR(100),
  paystack_authorization_code VARCHAR(100),        -- reusable card token from first charge
  paystack_email            VARCHAR(255),
  last_charged_amount_kobo  BIGINT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

-- ---------- PAYMENTS (Paystack transaction log) ----------
CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  subscription_id   UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  reference         VARCHAR(100) NOT NULL UNIQUE,
  plan              plan_type NOT NULL,
  student_count     INTEGER NOT NULL DEFAULT 0,
  amount_kobo       BIGINT NOT NULL,
  currency          VARCHAR(10) NOT NULL DEFAULT 'NGN',
  status            VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | success | failed
  paystack_raw      JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);

-- ---------- SESSIONS (academic year) ----------
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year        VARCHAR(20) NOT NULL UNIQUE,  -- e.g. 2024/2025
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one active session at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_active
  ON sessions (is_active) WHERE is_active = TRUE;

-- ---------- CLASSES ----------
CREATE TABLE IF NOT EXISTS classes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(100) NOT NULL UNIQUE,
  category            class_category NOT NULL,
  assigned_teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subjects            JSONB NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(assigned_teacher_id);

-- ---------- STUDENTS ----------
CREATE TABLE IF NOT EXISTS students (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              VARCHAR(255) NOT NULL,
  admission_number  VARCHAR(50) NOT NULL UNIQUE,
  class             VARCHAR(100) NOT NULL,
  parent_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  date_of_birth     DATE,
  gender            gender_type,
  guardian_name     VARCHAR(255),
  guardian_phone    VARCHAR(20),
  address           VARCHAR(500),
  photo_url         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_students_parent ON students(parent_id);
CREATE INDEX IF NOT EXISTS idx_students_class  ON students(class);

-- ---------- RESULTS ----------
CREATE TABLE IF NOT EXISTS results (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id         UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  student_name       VARCHAR(255) NOT NULL,    -- denormalized snapshot
  admission_number   VARCHAR(50)  NOT NULL,    -- denormalized snapshot
  class              VARCHAR(100) NOT NULL,
  term               term_type NOT NULL,
  session            VARCHAR(20) NOT NULL,
  result_type        result_type NOT NULL,
  subjects           JSONB NOT NULL DEFAULT '[]', -- [{name,cat1,cat2,exam,score,grade,remark}]
  total_score        NUMERIC(6,2) DEFAULT 0,
  average_score      NUMERIC(5,2) DEFAULT 0,
  overall_grade      VARCHAR(5),
  position           INTEGER,
  teacher_comment    TEXT,
  principal_comment  TEXT,
  published          BOOLEAN NOT NULL DEFAULT FALSE,
  pdf_url            TEXT,
  attendance         JSONB DEFAULT '{"opened":0,"present":0,"absent":0}',
  affective_domain   JSONB DEFAULT '{}',
  psychomotor_skills JSONB DEFAULT '{}',
  house              VARCHAR(100),
  club               VARCHAR(100),
  age                VARCHAR(20),
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_results_student ON results(student_id);
CREATE INDEX IF NOT EXISTS idx_results_class_term_session
  ON results(class, term, session, result_type);
CREATE INDEX IF NOT EXISTS idx_results_created_by ON results(created_by);

-- ---------- updated_at triggers ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_students_updated_at ON students;
CREATE TRIGGER trg_students_updated_at BEFORE UPDATE ON students
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_results_updated_at ON results;
CREATE TRIGGER trg_results_updated_at BEFORE UPDATE ON results
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_school_info_updated_at ON school_info;
CREATE TRIGGER trg_school_info_updated_at BEFORE UPDATE ON school_info
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- MULTI-TENANCY + CENTRAL ADMIN
-- Adds a platform-wide `central_admin` role that oversees every school,
-- a `schools` registry, per-school scoping (school_id) on tenant data,
-- and soft-delete columns so the Central Admin can remove/hide data from
-- the platform without hard-purging it (a school's own admin still does a
-- real, permanent delete via the existing per-resource DELETE routes).
-- Requires PostgreSQL 12+ (ALTER TYPE ... ADD VALUE IF NOT EXISTS).
-- ============================================================

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'central_admin';

DO $$ BEGIN
  CREATE TYPE school_status AS ENUM ('active', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- SCHOOLS (tenant registry, owned by Central Admin) ----------
CREATE TABLE IF NOT EXISTS schools (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(255) NOT NULL,
  address        VARCHAR(500),
  motto          VARCHAR(255),
  logo_url       TEXT,
  contact_email  VARCHAR(255),
  contact_phone  VARCHAR(20),
  status         school_status NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ  -- soft-deleted by Central Admin; NULL = active
);
CREATE INDEX IF NOT EXISTS idx_schools_deleted_at ON schools(deleted_at);

DROP TRIGGER IF EXISTS trg_schools_updated_at ON schools;
CREATE TRIGGER trg_schools_updated_at BEFORE UPDATE ON schools
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Tenant scoping + soft-delete columns on existing tables ----------
ALTER TABLE users       ADD COLUMN IF NOT EXISTS school_id  UUID REFERENCES schools(id) ON DELETE CASCADE;
ALTER TABLE users       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE classes     ADD COLUMN IF NOT EXISTS school_id  UUID REFERENCES schools(id) ON DELETE CASCADE;
ALTER TABLE classes     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE students    ADD COLUMN IF NOT EXISTS school_id  UUID REFERENCES schools(id) ON DELETE CASCADE;
ALTER TABLE students    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE results     ADD COLUMN IF NOT EXISTS school_id  UUID REFERENCES schools(id) ON DELETE CASCADE;
ALTER TABLE results     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE sessions    ADD COLUMN IF NOT EXISTS school_id  UUID REFERENCES schools(id) ON DELETE CASCADE;
ALTER TABLE school_info ADD COLUMN IF NOT EXISTS school_id  UUID REFERENCES schools(id) ON DELETE CASCADE;
ALTER TABLE auth_codes  ADD COLUMN IF NOT EXISTS school_id  UUID REFERENCES schools(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_users_school       ON users(school_id);
CREATE INDEX IF NOT EXISTS idx_classes_school      ON classes(school_id);
CREATE INDEX IF NOT EXISTS idx_students_school     ON students(school_id);
CREATE INDEX IF NOT EXISTS idx_results_school      ON results(school_id);
CREATE INDEX IF NOT EXISTS idx_sessions_school     ON sessions(school_id);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at    ON users(deleted_at);
CREATE INDEX IF NOT EXISTS idx_students_deleted_at ON students(deleted_at);
CREATE INDEX IF NOT EXISTS idx_results_deleted_at  ON results(deleted_at);
CREATE INDEX IF NOT EXISTS idx_classes_deleted_at  ON classes(deleted_at);

-- `email` above only has a case-SENSITIVE UNIQUE constraint, but every route
-- now normalizes email to lowercase before reading/writing it (see
-- src/utils/normalizeEmail.js) — this backfills any rows that predate that
-- fix and adds a case-insensitive unique index as a defense-in-depth
-- backstop, so a duplicate-by-casing account (e.g. "Admin@x.com" vs
-- "admin@x.com") can never be created even if some future code path forgets
-- to normalize.
DO $$
DECLARE
  r RECORD;
BEGIN
  -- Row-by-row (not a single bulk UPDATE) so that if two existing rows
  -- happen to collide once lowercased (e.g. "Admin@x.com" and "admin@x.com"
  -- both already exist as separate accounts), we skip and warn about just
  -- that pair instead of the whole migration failing on a unique_violation.
  FOR r IN SELECT id, email FROM users WHERE email <> LOWER(email) LOOP
    BEGIN
      UPDATE users SET email = LOWER(r.email) WHERE id = r.id;
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'Skipped lowercasing email for user %: an account with % already exists — resolve this pair manually.', r.id, LOWER(r.email);
    END;
  END LOOP;
END $$;

DO $$ BEGIN
  CREATE UNIQUE INDEX idx_users_email_lower ON users (LOWER(email));
EXCEPTION WHEN duplicate_table THEN NULL;
WHEN unique_violation THEN
  RAISE NOTICE 'Skipping idx_users_email_lower: some existing accounts still collide by case after best-effort cleanup above — resolve manually, then re-run migrations.';
END $$;

-- Uniqueness that used to be global now needs to be per-school
ALTER TABLE classes  DROP CONSTRAINT IF EXISTS classes_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_school_name ON classes(school_id, name);

ALTER TABLE students DROP CONSTRAINT IF EXISTS students_admission_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_school_admission ON students(school_id, admission_number);

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_year_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_school_year ON sessions(school_id, year);

DROP INDEX IF EXISTS idx_sessions_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_active_per_school
  ON sessions (school_id) WHERE is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_school_info_school ON school_info(school_id);

-- ---------- Backfill: give every pre-existing row a "Legacy School" tenant ----------
-- Runs once — safe/no-op on a fresh database, and safe to re-run.
DO $$
DECLARE
  legacy_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE school_id IS NULL AND role <> 'central_admin')
     OR EXISTS (SELECT 1 FROM students WHERE school_id IS NULL)
  THEN
    SELECT id INTO legacy_id FROM schools WHERE name = 'Legacy School' LIMIT 1;

    IF legacy_id IS NULL THEN
      INSERT INTO schools (name, address, motto, logo_url)
        SELECT COALESCE(name, 'Legacy School'), address, motto, logo_url
        FROM school_info LIMIT 1
        RETURNING id INTO legacy_id;

      IF legacy_id IS NULL THEN
        INSERT INTO schools (name) VALUES ('Legacy School') RETURNING id INTO legacy_id;
      END IF;
    END IF;

    UPDATE users       SET school_id = legacy_id WHERE school_id IS NULL AND role <> 'central_admin';
    UPDATE classes     SET school_id = legacy_id WHERE school_id IS NULL;
    UPDATE students    SET school_id = legacy_id WHERE school_id IS NULL;
    UPDATE results     SET school_id = legacy_id WHERE school_id IS NULL;
    UPDATE sessions    SET school_id = legacy_id WHERE school_id IS NULL;
    UPDATE school_info SET school_id = legacy_id WHERE school_id IS NULL;
    UPDATE auth_codes  SET school_id = legacy_id WHERE school_id IS NULL;
  END IF;
END $$;

-- ---------- PLATFORM SETTINGS (Central Admin managed, key/value) ----------
CREATE TABLE IF NOT EXISTS platform_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================
-- MIGRATION: CAT1 / CAT2 result types
-- ============================================================
-- The teacher portal's "Create Result" form (src/app/teacher/results/page.tsx
-- in the frontend repo) has only ever sent resultType 'CAT1', 'CAT2', or
-- 'Examination' — see the ResultType union in src/lib/types/index.ts and the
-- zod schema in src/lib/validation.ts, both of which enumerate exactly those
-- three values. The result_type enum created above, however, only ever had
-- 'Midterm' and 'Examination'. 'Midterm' was never sent by the frontend and
-- 'CAT1'/'CAT2' were never in the enum, so every CAT1/CAT2 submission failed
-- at the database with `invalid input value for enum result_type: "CAT1"`
-- (or "CAT2") and no result row was ever created for those two (of the three
-- possible) result types.
--
-- Requires PostgreSQL 12+ (ALTER TYPE ... ADD VALUE IF NOT EXISTS) — same
-- requirement as the 'central_admin' migration above.
ALTER TYPE result_type ADD VALUE IF NOT EXISTS 'CAT1';
ALTER TYPE result_type ADD VALUE IF NOT EXISTS 'CAT2';