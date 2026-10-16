# Reversible owner Access rollout

This rollout changes owner authentication only. Keep `EXECUTION_MODE` unchanged during this rollout. Do not disconnect Instagram, resave campaigns, replace provider credentials, or run a reset to enable Access.

## Current implementation and release gate

`AUTH_MODE=password` remains the default. In `access` mode, the Worker validates an RS256 Access assertion, maps its verified email to the existing owner, and issues the existing application session after an explicit same-origin POST. Protected requests require both that session and a valid Access assertion. Stored password hashes and credential versions are preserved.

Local tests snapshot campaign/conversation/job data across login and continue the existing funnel. They also cover password rollback, invalid signatures/audiences/subjects, cross-origin bootstrap, public webhooks, and scheduled execution. These tests cannot prove your deployed Access policies or Free-tier CPU usage.

**Do not enable Access in production until its path policies and destructive-action requirement are verified.** Password changes are intentionally unavailable in managed mode. The current owner UI also gates disconnect/reset in Access mode; its API requires a separate action audience and signed `auth_time` within five minutes. Ordinary JWT `iat` is not accepted as evidence of fresh authentication. An unverified Access configuration must not bypass password confirmation. Until a working fresh-verification UI is delivered, switch back to password mode for an intentional reset.

## Configure in a staging hostname first

1. Use the current owner email in an Access allow policy. Avoid an account-wide allow rule or trusting a client-supplied email header.
2. Protect `/session/access`, `/session`, `/session/*`, `/api/*`, `/admin/*`, and owner-only `/auth/*` routes. Create explicit public bypasses for `/auth/callback` and any public provider routes. Protect the owner UI hostname as appropriate, while preserving static/legal routes you intend to expose. Check actual matching precedence in your Access configuration.
3. `/webhook` (GET verification and POST events), `/auth/callback`, and `/health` must reach the Worker without an Access redirect. Cron and Queue handlers must not depend on a browser session.
4. Set `ACCESS_ISSUER` to the exact `https://<team>.cloudflareaccess.com` issuer, `ACCESS_AUDIENCE` to the application audience, and optionally `ACCESS_OWNER_SUBJECT` to the verified owner subject. Then set `AUTH_MODE=access`. Keep `AUTH_MODE=password` in the rollback configuration.
5. Sign in via the UI and explicitly continue to the application. Verify that the owner email matches, normal API operations work, and a forged/missing assertion cannot use a valid application cookie.
6. Compare campaign IDs, instance IDs, conversation versions/states, connection generation, pending job IDs and checkpoints before/after. Continue an existing lead through its next step; verify no duplicate opening or delivery. Send a signed webhook with no owner session.
7. Measure cold JWKS retrieval, warm verification, login bootstrap and private API requests on the target Free plan. Never use local request duration as Cloudflare CPU time.

## Rollback

Set `AUTH_MODE=password` and deploy the compatible build/config. Existing owner credentials remain intact. A session can be reused only according to normal expiry/version rules; otherwise use the existing password login. Verify API access and one ongoing funnel without changing provider/campaign data. Access edge policies must also permit the intended password sign-in path; changing the Worker variable does not remove an edge policy.

No live Access policies or Worker variables were changed by this implementation.
