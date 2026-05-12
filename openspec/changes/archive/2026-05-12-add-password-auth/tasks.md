## 1. Dependency and model

- [x] 1.1 `npm install bcrypt` (fall back to `bcryptjs` and update the import in `password.service.js` if the native build fails on the target image)
- [x] 1.2 Update `src/models/user.model.js`: extend `provider` enum to include `'password'`; add column `password_hash` (TEXT, nullable)
- [x] 1.3 Apply schema change to the active database:
  - Hackathon/local Postgres: `node --input-type=module -e "import 'dotenv/config'; const m=await import('./src/models/index.js'); await m.User.sequelize.sync({ alter: true }); process.exit(0);"` (additive — keeps existing rows)
  - If `alter: true` complains about the enum change, fall back to raw SQL: `ALTER TYPE enum_users_provider ADD VALUE IF NOT EXISTS 'password';` then re-run `sync({ alter: true })`

## 2. Service layer

- [x] 2.1 Create `src/services/password.service.js` exporting:
  - `hash(plaintext)` → bcrypt with cost factor 12
  - `verify(plaintext, hash)` → boolean
  - `normalizeEmail(email)` → lowercased + trimmed
- [x] 2.2 Extend `src/services/user-auth.service.js` (or create `password-user.service.js`) with:
  - `registerPasswordUser({ email, password, username })` — normalize email, check no existing `(provider='password', provider_user_id=email)`, derive username if not given, hash password, create User, return user
  - `authenticatePasswordUser({ email, password })` — normalize email, look up by `(provider='password', provider_user_id=email)`, bcrypt-verify; return user or `null` on any failure (no distinguishing 404 vs wrong password)

## 3. Validation schemas

- [x] 3.1 Add to `openspec.yaml` under `components.schemas`:
  - `RegisterRequest`: required `email` (email format), `password` (minLength 8), optional `username` (string, 3–50 chars)
  - `LoginRequest`: required `email` (email format), `password` (string)
  - `AuthResponse`: required `user` (with `id`, `username`, `email`, `provider` enum extended to include `password`) and `token`
- [x] 3.2 Add `POST /auth/register` and `POST /auth/login` operations referencing those schemas

## 4. Controller and routes

- [x] 4.1 Create `src/controllers/password-auth.controller.js` with `register` and `login` handlers
  - `register`: validate, call service, on `409` (email exists) respond accordingly, on success sign JWT, set `session` cookie (same options as OAuth controller), return `{ user, token }` with status 201
  - `login`: validate, call service, on `null` return `401 { error: 'Invalid credentials' }`, on success sign JWT, set cookie, return `{ user, token }` with status 200
- [x] 4.2 In `src/routes/auth.routes.js`, add `router.post('/auth/register', validateRequest('/auth/register'), register)` and `router.post('/auth/login', validateRequest('/auth/login'), login)`. Position BEFORE the `/auth/:provider` catch-all so they aren't shadowed (the file already declares `/auth/me` and `/auth/logout` before `/auth/:provider` for the same reason)

## 5. Manual verification

- [x] 5.1 Start the server (`node src/server.js`); confirm `Server listening on port 3000`
- [x] 5.2 Register: `curl -s -i -X POST http://localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' -d '{"email":"alice@example.com","password":"correcthorsebatterystaple"}'` — expect `201`, `Set-Cookie: session=...`, JSON body with `user` and `token`. Save the token to `TOKEN` shell variable
- [x] 5.3 Re-register the same email → expect `409 {"error":"Email already registered"}`
- [x] 5.4 Register with bad input (short password): `curl ... -d '{"email":"bob@example.com","password":"123"}'` → expect `400 {"error":"Validation failed", ...}`
- [x] 5.5 Login correct: `curl -s -i -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"alice@example.com","password":"correcthorsebatterystaple"}'` → expect `200`, `Set-Cookie: session=...`, JSON body with `user` and a fresh `token`
- [x] 5.6 Login wrong password → expect `401 {"error":"Invalid credentials"}`
- [x] 5.7 Login unknown email → expect `401 {"error":"Invalid credentials"}` (same shape as 5.6 — enumeration prevented)
- [x] 5.8 Login email case-insensitivity: register as `Carol@Example.com`, then log in as `carol@example.com` → expect success
- [x] 5.9 `curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/auth/me` → expect `{ id, username, email, provider: "password" }`
- [x] 5.10 Telemetry with password JWT: `curl -X POST http://localhost:3000/api/v1/telemetry -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"events":[{"event_type":"file_save","timestamp":"2026-05-12T15:00:00Z","session_id":"22222222-2222-2222-2222-222222222222"}]}'` → expect `202`
- [x] 5.11 Logout with cookie: `curl -i -X POST http://localhost:3000/api/v1/auth/logout -b "session=$TOKEN"` → expect `204` and `Set-Cookie: session=; Max-Age=0`
- [x] 5.12 Verify DB shape: `psql ... -c "SELECT id, username, provider, length(password_hash) FROM users WHERE provider='password';"` → expect `password_hash` length ~60, never the plaintext

## 6. Documentation

- [x] 6.1 Update `.env.example` to note that `bcrypt` is required and no new env vars are needed beyond the existing `JWT_SECRET`
- [x] 6.2 (Optional) Add a small `README.md` snippet showing the three curl commands (register/login/logout) for whoever's testing the demo
