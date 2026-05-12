## 1. App entry point

- [x] 1.1 Create `src/server.js` with `import 'dotenv/config'` as the first line, then import `express`, helmet, cors, and the router; export the `app` and start `listen(PORT)` when run directly
- [x] 1.2 Add `app.use(express.json())` with a reasonable body limit (e.g. `{ limit: '1mb' }`) so telemetry batches don't get truncated
- [x] 1.3 Add a final error-handling middleware that logs via `logger.error` and returns `{ error: 'Internal server error' }` with HTTP `500`

## 2. Service layer

- [x] 2.1 Create `src/services/telemetry.service.js` exporting `ingestBatch({ user_id, events })`
- [x] 2.2 Inside `ingestBatch`, open a `sequelize.transaction` and pass the transaction to every model call
- [x] 2.2a Before session resolution, verify `User.findByPk(user_id, { transaction })` exists; if not, throw a `UserNotFoundError` (custom error class exported from the service)
- [x] 2.3 For each unique `session_id` in `events`, call `Session.findOrCreate({ where: { id: session_id }, defaults: { user_id, start_time: <earliest-event-timestamp-for-that-session>, is_active: true }, transaction })`
- [x] 2.4 Bulk-insert activities via `Activity.bulkCreate(rows, { transaction })`, mapping each event to `{ session_id, event_type, file_path, metadata, timestamp }`
- [x] 2.5 On any thrown error, the transaction auto-rolls back; re-throw so the controller can map it to a `500`
- [x] 2.6 Return `{ accepted_count: events.length }` on success

## 3. Controller

- [x] 3.1 Create `src/controllers/telemetry.controller.js` exporting `submitTelemetry(req, res, next)`
- [x] 3.2 Call `telemetryService.ingestBatch(req.body)`; on success respond `202` with `{ message: 'Telemetry accepted', accepted_count }`
- [x] 3.3a If the thrown error is a `UserNotFoundError`, respond `404` with `{ error: 'User not found' }`
- [x] 3.3 On any other thrown error, call `next(err)` so the global error middleware handles it

## 4. Route

- [x] 4.1 Create `src/routes/telemetry.routes.js` that builds an Express router
- [x] 4.2 Wire `router.post('/telemetry', validateRequest('/telemetry'), submitTelemetry)`
- [x] 4.3 In `src/server.js`, mount the router at `/api/v1` (so the final path is `POST /api/v1/telemetry`, matching `openspec.yaml`'s `servers.url`)

## 5. Manual verification

- [x] 5.0 Seed one test user (one-liner): `node --input-type=module -e "import 'dotenv/config'; const {User} = await import('./src/models/index.js'); const u = await User.create({username:'tester'}); console.log(u.id); process.exit(0);"` — record the printed UUID for the curl commands below
- [x] 5.1 Run `node src/server.js` and confirm the process starts on `PORT` from `.env`
- [x] 5.2 `curl -X POST http://localhost:3000/api/v1/telemetry -H 'Content-Type: application/json' -d '{"user_id":"<uuid>","events":[{"event_type":"file_save","timestamp":"2026-05-12T15:00:00Z","session_id":"<uuid>","file_path":"src/x.js","metadata":{"lines_added":3}}]}'` — expect `202` and a new `Session` + `Activity` row
- [x] 5.3 Repeat the same request and confirm the second call reuses the existing `Session` (only one `sessions` row for that `session_id`)
- [x] 5.4 Post a malformed body (missing `events`) and confirm `400` with `error: 'Validation failed'` and no rows written
- [x] 5.5 Post a batch where one event has a `session_id` that violates a constraint and confirm no rows from the batch are persisted (transaction rollback verified)
- [x] 5.6 Post a batch with a random `user_id` UUID that doesn't exist in `users`; confirm `404` with `{ error: 'User not found' }` and no rows written
