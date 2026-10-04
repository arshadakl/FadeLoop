# Owner login and release checklist

Dashboard authentication is separate from Instagram OAuth. The single owner email and salted Argon2id hash live in D1; passwords never belong in `.env`. There is no signup or email provider. Existing automation tables and feature behavior are unchanged.

## Provision and recover

Apply migrations before deploying, then use an interactive terminal:

```bash
npm run db:migrate:remote
npm run owner:create -- --remote
```

The command prompts for email and a password of 8–128 characters, followed by confirmation. Passwords are invisible and never appear in process arguments. The single-owner constraint prevents a second create from overwriting the owner. Use `--local` for development. Local and remote accounts are separate: creating or resetting a local owner does not change production login. The command checks the selected database before requesting a password; if no owner exists, use `owner:create` for that target first.

Forgotten passwords are reset by the operator:

```bash
npm run owner:reset -- --remote
```

Enter the existing email and a new password. Credential versioning immediately invalidates every existing session, including when a login races a reset. Pending Instagram connection requests are revoked too.

## Browser and CLI sessions

`POST /session/login` accepts JSON `{ "email": "...", "password": "..." }` and the same-origin `Origin` header. `GET /session` returns only `email` and `expires_at`. `POST /session/logout` revokes the session and clears its cookie. Sessions last seven days without sliding renewal. Responses are not cached.

Cookies use `__Host-fadeloop_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`. D1 stores SHA-256 hashes of random 256-bit session tokens. Mutations require an exact matching Origin header; Instagram onboarding also accepts same-origin navigation metadata. Five attempts per hashed email/IP bucket are permitted in a fixed 15-minute window. Successful requests give back their reserved slot; previous failures remain counted.

Log in from the terminal without putting a password in shell history:

```bash
npm run session:login -- https://fadeloop.abc123.workers.dev
curl -b .fadeloop-cookies https://fadeloop.abc123.workers.dev/api/status
curl -b .fadeloop-cookies -H "Origin: https://fadeloop.abc123.workers.dev" -X POST https://fadeloop.abc123.workers.dev/session/logout
```

Delete the cookie jar when finished; it is a credential and is gitignored. Token query parameters and bearer credentials no longer authenticate any route. Instagram OAuth state is hashed, session-bound, single-use, and valid for ten minutes. Its callback stays publicly routable, with the account takeover guard preserved. Meta webhook verification and event processing remain independent of dashboard sessions.

## Argon2 and deployment gate

### Change a password while signed in

Open **Account & appearance** (the account icon on mobile), enter **New password** and **Confirm new password**, then choose **Change password**. The current password and email verification are not required: possession of a valid owner session authorizes the change. Keep signed-in devices private; anyone who controls that session can change the password.

Passwords remain 8–128 characters, including spaces. Success rotates this browser's session, signs out other devices, and cancels outstanding Instagram authorization states. Unsaved editor drafts remain available. An expired session cannot change the password; use the operator reset command for recovery. Five attempts per owner per 15 minutes limit expensive hashing.

The same-origin JSON endpoint is `POST /session/password` with `{ "new_password": "..." }`. It returns the owner's email and new session expiry and sets the replacement HttpOnly cookie. Never pass real passwords in shell arguments or commit them.

### Measured Free-plan release limitation

On 2026-10-04, a disposable Worker on the existing Cloudflare account ran the unchanged Argon2id implementation five times. Cloudflare tail reported **78, 97, 97, 98, and 153 ms CPU** per invocation. Each request returned 200, but all exceeded the documented **10 ms Free-plan CPU budget**. Successful requests are not evidence that the hash fits the plan. The temporary Worker was deleted; no production credentials or D1 data were changed.

The password-change feature is implemented and locally tested, but production rollout is held until a deployed plan supports that CPU requirement or a separately agreed architecture removes hashing from the constrained Worker. Do not reduce hashing strength. This limitation also applies to existing password verification, which uses the same hash operation.

Passwords use Argon2id v19, 19 MiB memory, two iterations, parallelism one, a random 16-byte salt and a 32-byte digest. `scripts/build-argon2.mjs` adapts the pinned hash-wasm distribution into statically imported WASM modules because Workers prohibits runtime WASM compilation. The algorithm and upstream MIT license remain unchanged.

The dry-run bundle passes real workerd tests. Local login wall time is approximately 50ms; this does **not** measure deployed CPU usage. [Cloudflare Free allows 10ms CPU per invocation](https://developers.cloudflare.com/workers/platform/limits/), so do not assume this version is compatible with the Free plan. Verify target-plan CPU and memory limits using a staging deployment and Cloudflare invocation metrics before production rollout. Do not weaken hashing parameters to fit a limit. A plan with sufficient CPU may be necessary.

```bash
npm run typecheck
npm test
npm run test:worker-auth
npm run test:ui
```

Browser tests require Chromium: install it with `npx playwright install chromium` if it is not already available. The suite starts a disposable in-memory D1 instance; it never touches the owner's local or remote database.

Back up D1, apply migration 0006, provision the owner, complete target-plan runtime verification, then deploy. Confirm login, existing campaign/contact access and an existing Instagram funnel. Only afterwards remove the obsolete deployed secret:

```bash
npx wrangler secret delete OWNER_TOKEN
```

Old token browser sessions end at cutover. Cron and webhooks continue without dashboard sessions.
