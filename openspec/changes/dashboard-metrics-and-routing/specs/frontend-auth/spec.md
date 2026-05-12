## ADDED Requirements

### Requirement: Landing route redirects authenticated users to the dashboard

The frontend SHALL guard the `/` Landing route so that authenticated users are redirected to `/dashboard`. Unauthenticated users continue to see the Landing page as before. While the auth state is loading, the route MUST render the same loading placeholder used by other auth-aware guards rather than briefly flashing either page.

#### Scenario: Authenticated user navigates to /
- **WHEN** an authenticated user navigates to `/` (by typing the URL, clicking the logo, or any other means)
- **THEN** the app issues a client-side redirect to `/dashboard`
- **AND** the Landing page is not rendered

#### Scenario: Unauthenticated user navigates to /
- **WHEN** an unauthenticated user navigates to `/`
- **THEN** the Landing page renders as before
- **AND** no redirect occurs

#### Scenario: Auth state is still loading
- **WHEN** the page is loaded at `/` and the auth context's `isLoading` is true
- **THEN** the route renders the shared `AuthLoading` placeholder
- **AND** the Landing page is not visible
- **AND** no premature redirect to `/dashboard` occurs

### Requirement: Navbar logo's destination depends on auth state

The navbar logo SHALL link to `/dashboard` when the user is authenticated and to `/` when the user is signed out. While the auth state is loading, the logo MUST render as a non-link image to prevent a misclick that would send the user to the wrong destination.

#### Scenario: Logo while signed out
- **WHEN** the user is not authenticated
- **THEN** clicking the navbar logo navigates to `/`

#### Scenario: Logo while signed in
- **WHEN** the user is authenticated
- **THEN** clicking the navbar logo navigates to `/dashboard`

#### Scenario: Logo while auth state is loading
- **WHEN** the auth context's `isLoading` is true
- **THEN** the logo renders as a plain image, not a clickable link
- **AND** once auth settles, the logo becomes the appropriate link
