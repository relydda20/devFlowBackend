## ADDED Requirements

### Requirement: Real backend calls from Login and Register

The frontend Login page SHALL call `POST /api/v1/auth/login` with `{ email, password }` and `credentials: 'include'`. The Register page SHALL call `POST /api/v1/auth/register` with `{ email, password }` and `credentials: 'include'`. Neither page may write authentication state to `localStorage`. On a 2xx response, the page MUST navigate to `/dashboard`. On any non-2xx, the page MUST display the server's `error` message inline, keep the form populated, and clear the password field.

#### Scenario: Successful login
- **WHEN** the user submits a valid email/password
- **THEN** the page issues `POST /api/v1/auth/login` with `credentials: 'include'`
- **AND** on HTTP 200, the auth context refreshes from `me`, the user is navigated to `/dashboard`, and no error is shown

#### Scenario: Login with wrong password
- **WHEN** the backend returns HTTP 401 with `{ error: "Invalid credentials" }`
- **THEN** the page shows the message "Invalid credentials" inline below the form
- **AND** the email field retains its value
- **AND** the password field is cleared
- **AND** no navigation occurs

#### Scenario: Successful registration
- **WHEN** the user submits a valid email/password on the Register page
- **THEN** the page issues `POST /api/v1/auth/register` with `credentials: 'include'`
- **AND** on HTTP 201, the auth context refreshes from `me`, the user is navigated to `/dashboard`

#### Scenario: Registration with existing email
- **WHEN** the backend returns HTTP 409 with `{ error: "Email already registered" }`
- **THEN** the page shows the message "Email already registered" inline below the form
- **AND** no navigation occurs

#### Scenario: Network failure
- **WHEN** the request fails before reaching the backend (offline, DNS, CORS reject)
- **THEN** the page shows a generic message "Could not reach the server. Check your connection and try again."
- **AND** the form retains email and clears password

#### Scenario: No localStorage writes
- **WHEN** any auth-related event occurs (success or failure)
- **THEN** the code MUST NOT call `localStorage.setItem` with auth state
- **AND** any pre-existing `localStorage.devflow_user` key is removed during this change

### Requirement: AuthProvider context drives the React app

The frontend SHALL expose a single `AuthProvider` context wrapping the routed app, exposing `{ user, isAuthenticated, isLoading, login, register, logout, refresh }`. On mount, the provider MUST issue exactly one `GET /api/v1/auth/me` request to derive initial state. The context MUST be the single source of truth for "is this user authenticated"; no component may read auth state from `localStorage`, `document.cookie`, or other side channels.

#### Scenario: Initial mount with valid cookie
- **WHEN** the app loads and the browser has a valid `session` cookie
- **THEN** `AuthProvider` issues `GET /api/v1/auth/me`
- **AND** receives HTTP 200 with the user
- **AND** transitions state to `{ user, isAuthenticated: true, isLoading: false }`

#### Scenario: Initial mount with no cookie / expired cookie
- **WHEN** the app loads and no valid cookie is presented
- **THEN** `GET /api/v1/auth/me` returns HTTP 401
- **AND** the context settles at `{ user: null, isAuthenticated: false, isLoading: false }`
- **AND** no error notification is shown — being logged out is not an error

#### Scenario: Login action updates context
- **WHEN** the `login` action returns 200
- **THEN** the context calls `refresh()` (re-`me`) and updates `user` and `isAuthenticated`
- **AND** all consumers re-render with the new state

#### Scenario: Logout action
- **WHEN** any component calls `auth.logout()`
- **THEN** the context issues `POST /api/v1/auth/logout` with credentials
- **AND** unconditionally sets state to `{ user: null, isAuthenticated: false, isLoading: false }`
- **AND** ignores any error from the logout call (failure is logged to the console only)

### Requirement: Route guards block on the auth-loading state

`ProtectedRoute` and `PublicRoute` SHALL read `isLoading` and `isAuthenticated` from the auth context. While `isLoading` is true, both guards MUST render a loading placeholder rather than redirecting. Only once `isLoading` is false may they redirect.

#### Scenario: Logged-in user reloads /dashboard
- **WHEN** an authenticated user reloads `/dashboard`
- **THEN** `ProtectedRoute` renders a loading placeholder while `me` is pending
- **AND** the user does NOT briefly see `/login` while `me` resolves

#### Scenario: Logged-out user visits /dashboard
- **WHEN** an unauthenticated user navigates to `/dashboard`
- **THEN** `ProtectedRoute` renders the loading placeholder while `me` is pending
- **AND** once `me` returns 401, redirects to `/login`

#### Scenario: Logged-in user visits /login
- **WHEN** an authenticated user navigates to `/login`
- **THEN** `PublicRoute` renders the loading placeholder while `me` is pending
- **AND** once `me` returns 200, redirects to `/dashboard`

### Requirement: API client reads VITE_API_URL with a clear fallback

The frontend API client SHALL read its base URL from `import.meta.env.VITE_API_URL`. When the variable is unset, the client MUST fall back to `http://localhost:3000` AND log a single warning to `console.warn` on module load if `window.location.hostname` is not `localhost` or `127.0.0.1`. Every fetch issued by the client MUST set `credentials: 'include'` and `headers: { 'Content-Type': 'application/json' }` (for non-GET requests with a body).

#### Scenario: Configured base URL
- **WHEN** `VITE_API_URL=https://api.example.com` at build time
- **THEN** all fetches go to `https://api.example.com/...`

#### Scenario: Unset variable in production
- **WHEN** `VITE_API_URL` is unset AND `window.location.hostname` is not localhost
- **THEN** the module emits `console.warn` once explaining the misconfiguration
- **AND** falls back to `http://localhost:3000` (which will fail, but with a discoverable reason)

#### Scenario: Unset variable in dev
- **WHEN** `VITE_API_URL` is unset AND the page is loaded on localhost
- **THEN** the client uses `http://localhost:3000` with no warning

#### Scenario: Credentials are always included
- **WHEN** the client issues any request
- **THEN** the `fetch` call includes `credentials: 'include'`

### Requirement: Logout action is reachable from authenticated views

The frontend SHALL provide a visible Logout action accessible to any signed-in user. The action MUST call `auth.logout()` from the context and MUST navigate (or re-render) such that the user lands on a public page after.

#### Scenario: Logout from the dashboard
- **WHEN** an authenticated user clicks the Logout action
- **THEN** the auth context calls `POST /api/v1/auth/logout`
- **AND** state transitions to logged-out
- **AND** the user is shown a public page (Landing or Login)
