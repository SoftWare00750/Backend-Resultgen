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