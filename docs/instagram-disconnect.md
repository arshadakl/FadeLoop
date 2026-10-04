# Disconnect Instagram and reset the workspace

Open **Account & appearance → Disconnect Instagram**, including when the Instagram token has expired. Confirm with the current **FadeLoop login password**, not an Instagram password. Cancellation and unsuccessful requests preserve unsaved builder changes. Success discards the draft and returns to Automations while keeping the owner signed in.

This permanently deletes active, stopped and archived automations, folders and memberships, contacts/conversations, analytics, processed comments, public-action records, send claims, Instagram credentials, pending OAuth states and polling/error/cursor state. Owner accounts, login sessions, authentication throttles and deployment configuration remain. There is no undo in FadeLoop.

The reset disconnects this installation only. It makes no Meta permission-revocation call. Messages already submitted to Instagram cannot be recalled. Generation checks stop future sends/retries and prevent stale polling, webhook, campaign-save, token-refresh and OAuth work from restoring deleted local data, including after reconnection.

## API

`POST /auth/disconnect` requires a live owner session cookie, an exact same-origin `Origin`, JSON content type and a body no larger than 4 KiB:

```json
{ "password": "your FadeLoop login password", "connection_generation": 0 }
```

Read the current `connection_generation` from authenticated `/api/status` or `/auth/status`. Do not put a real password in shell history. Passwordless requests are rejected. Five attempts per owner per 15-minute window are reserved atomically before Argon2 verification, including unsuccessful password entries. Wrong passwords return 403; expired/revoked sessions return 401; changed connections return 409; throttling returns 429 with `Retry-After`.

`{ "disconnected": true, "deleted": true }` is returned only after the transactional batch commits, or for an authenticated repetition of that same completed reset while still disconnected. A repeated request cannot delete a newly connected account. Database failures roll back every delete and the generation increment. After an uncertain network outcome, refresh status before another submission; never automatically retry the destructive request.

## Migration and rollout

Back up D1, then apply additive migration `0008_connection_generation.sql` **before** uploading this Worker. It seeds a persistent generation counter without changing existing campaigns or credentials. OAuth connection replacement and successful reset increment it; token refresh retains it.

For disposable local verification:

```powershell
npm run db:migrate:local
npm run typecheck
npm test
npm run test:worker-auth
npm run test:ui
npm run deploy:dry-run
```

For the intended preview database, select that client's Wrangler configuration and apply its remote migrations before preview upload. Test with disposable Instagram data and verify complete deletion, owner-session retention and immediate reconnection. Do not test this feature against workspace data you intend to keep. Production migration/deployment is a separate rollout action.

The connection guard adds one D1 statement and one singleton-row update to each guarded mutation batch, plus indexed connection checks before network operations/retries. It adds no cron, media scope or per-comment Worker invocation, but its D1 query/write overhead counts toward the selected plan's limits. Measure representative traffic; do not claim guaranteed Free-tier capacity.

The existing [Argon2 Free-plan CPU release limitation](authentication.md#measured-free-plan-release-limitation) still applies to password-confirmed disconnect. Hashing parameters are unchanged. Local workerd verification is not deployed CPU measurement; complete target-plan CPU/memory verification before production release.
