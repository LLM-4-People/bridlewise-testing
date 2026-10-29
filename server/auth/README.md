# Auth domain

The auth domain owns who the caller is and what they may do: passwords,
sessions, CSRF protection, and the per-request user context that scopes every
database read. Routes do not authenticate themselves — they call the one gate.

## What each file does

- `auth.ts` — password hashing (scrypt) and the session-cookie operations, the
  single owner so the algorithm and cookie shape are decided once.
- `session.ts` — session creation, rotation, and scoping.
- `csrf.ts` — the CSRF guard that protects session-cookie routes from
  cross-site request forgery.
- `user-context.ts` — the `requireUserContext` / `requireAdminContext` gate.
  Every authenticated route resolves the user through here; the result scopes
  the database so a route never sees another user's rows.

## Where it lives

The folder lives at `server/auth/`.
