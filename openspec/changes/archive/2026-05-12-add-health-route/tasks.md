## 1. Route

- [x] 1.1 Create `src/routes/health.routes.js` that builds an Express router with `router.get('/health', (req, res) => res.json({ status: 'ok' }))`

## 2. Wiring

- [x] 2.1 In `src/server.js`, import the health router and `app.use('/api/v1', healthRouter)` alongside the existing telemetry router

## 3. Manual verification

- [x] 3.1 Run `node src/server.js` and confirm "Server listening on port 3000" appears in the logs
- [x] 3.2 `curl -i http://localhost:3000/api/v1/health` — expect `HTTP/1.1 200 OK`, `Content-Type: application/json`, body `{"status":"ok"}`
- [x] 3.3 Stop the Docker Postgres (`docker compose stop postgres`), re-run the curl, and confirm the response is still `200 {"status":"ok"}` (proves no DB I/O); then `docker compose start postgres` to restore
- [x] 3.4 `curl http://localhost:3000/api/v1/nonexistent` — confirm `404` (proves the 404 path is distinct from health and other routes are still reachable)
