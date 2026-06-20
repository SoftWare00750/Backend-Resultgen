# RGS Backend (Node.js + Express + PostgreSQL)

A real backend for the Result Generation System, replacing the `localStorage` mock layer
(`src/lib/storage.ts`) in the Next.js frontend with a proper Express API backed by PostgreSQL.

## 1. Install PostgreSQL & create the database

```bash
# macOS (Homebrew)
brew install postgresql@16
brew services start postgresql@16

# Ubuntu/Debian
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
```

Create the database and a dedicated user:

```bash
sudo -u postgres psql
```
```sql
CREATE DATABASE rgs_db;
CREATE USER rgs_user WITH ENCRYPTED PASSWORD 'rgs_password';
GRANT ALL PRIVILEGES ON DATABASE rgs_db TO rgs_user;
\c rgs_db
GRANT ALL ON SCHEMA public TO rgs_user;
\q
```

## 2. Configure environment

```bash
cd backend
cp .env.example .env
# edit .env with your real DB credentials and a strong JWT_SECRET
```

## 3. Install dependencies, migrate, and seed

```bash
npm install
npm run migrate   # creates all tables, enums, indexes, triggers (src/db/schema.sql)
npm run seed       # creates default admin, active session, and starter classes
```

Default seeded admin login (override in `.env`):
- email: `admin@school.edu.ng`
- password: `Admin@123`

## 4. Run the server

```bash
npm run dev     # nodemon, auto-restarts on changes
# or
npm start
```

Server starts on `http://localhost:4000` (configurable via `PORT`).
Health check: `GET /health`

## Database schema

| Table        | Purpose                                                   |
|--------------|-------------------------------------------------------------|
| `users`      | Admins, teachers, parents (bcrypt password hashes)          |
| `auth_codes` | One-time 6-digit registration codes, scoped by role          |
| `sessions`   | Academic year sessions, only one can be `is_active`          |
| `classes`    | Class list, category, assigned teacher, subject list (JSONB) |
| `students`   | Student records, linked to parent (`users.id`)               |
| `results`    | Subject scores (JSONB), grade, position, publish flag         |
| `school_info`| Single-row school name/logo/address/motto for PDF headers     |

All UUID primary keys use `gen_random_uuid()`. `updated_at` columns auto-update via triggers.

## API overview

All routes are prefixed `/api`. Except `/auth/register` and `/auth/login`, every route
requires `Authorization: Bearer <token>` (JWT issued at login/register).

| Method | Route                              | Role(s)                | Description                       |
|--------|-------------------------------------|-------------------------|------------------------------------|
| POST   | `/auth/register`                    | public                  | Register with a valid auth code    |
| POST   | `/auth/login`                       | public                  | Login, returns JWT + user          |
| GET    | `/auth/me`                          | any                      | Current user profile               |
| GET    | `/users`                            | admin                    | List all users                     |
| DELETE | `/users/:id`                        | admin                    | Delete a user                      |
| PATCH  | `/users/:id`                        | admin or self            | Update name/phone/signature        |
| GET    | `/auth-codes`                       | admin                    | List auth codes                    |
| POST   | `/auth-codes`                       | admin                    | Generate a 6-digit code            |
| DELETE | `/auth-codes/:id`                   | admin                    | Delete a code                      |
| GET    | `/classes`                          | any (teacher sees own)   | List classes                       |
| POST   | `/classes`                          | admin                    | Create class                       |
| PATCH  | `/classes/:id`                      | admin                    | Update teacher/subjects            |
| DELETE | `/classes/:id`                      | admin                    | Delete class                       |
| GET    | `/students`                         | any (scoped)             | List students                      |
| GET    | `/students/check-admission/:no`     | any                      | Check admission number uniqueness  |
| POST   | `/students`                         | admin/teacher/parent     | Create student                     |
| PATCH  | `/students/:id`                     | any                      | Update student                     |
| DELETE | `/students/:id`                     | any                      | Delete student                     |
| GET    | `/results`                          | any (scoped)             | List results (filters: studentId, class, term, session) |
| POST   | `/results`                          | admin/teacher            | Create result (auto grade + position) |
| PATCH  | `/results/:id`                      | admin/teacher            | Update/publish/unpublish result    |
| DELETE | `/results/:id`                      | admin/teacher            | Delete result                      |
| GET    | `/sessions`                         | any                      | List sessions                      |
| GET    | `/sessions/active`                  | any                      | Get active session                 |
| POST   | `/sessions`                         | admin                    | Create session                     |
| PATCH  | `/sessions/:id/activate`            | admin                    | Set session active                 |
| DELETE | `/sessions/:id`                     | admin                    | Delete session (not if active)     |
| GET    | `/school`                           | any                      | Get school info                    |
| PUT    | `/school`                           | admin                    | Upsert school info                 |

## Connecting the Next.js frontend

Replace the calls in `src/lib/services/*.ts` (which currently read/write `localStorage`)
with `fetch` calls to this API, attaching the JWT from login in an `Authorization` header.
Set `NEXT_PUBLIC_API_URL=http://localhost:4000/api` in the frontend's `.env.local`.
