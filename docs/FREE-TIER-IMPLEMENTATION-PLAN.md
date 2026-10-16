# FadeLoop: detailed Cloudflare Free-tier implementation plan

Date: 16 October 2026. Status: approved design, local implementation in progress. No remote database, authentication-policy or deployment changes have been performed. See [Access rollout](access-rollout.md) and [task rollout/status](task-rollout.md) for implemented behavior, verification and remaining release gates.

**Post-review corrective plan:** [Free-tier remediation plan](FREE-TIER-REMEDIATION-PLAN.md) covers the nine findings in the subsequent code review, with F01–F12 implementation tasks, regression evidence, capacity constraints and release gates. Follow that execution order for the remaining work; the 10 ms issue is not yet solved.

Evidence: [CPU investigation](CPU-INVESTIGATION-2026-10-16.md) and [saved local measurements](cpu-investigation-evidence.json). Current code was rechecked when preparing this plan. The owner's existing `src/index.ts` and `wrangler.toml` edits are preserved.

## 1. Outcome and decisions

Build a deployment that supports the existing comment-to-DM, follow-confirmation, email, reward and public-reply flows within an explicitly tested Cloudflare Free capacity envelope. Every execution unit must stay small as event volume, campaign count and history increase. Existing campaigns and conversations must retain their identities and progress.

The chosen design is:

1. **Temporarily switch owner authentication to Cloudflare Access through a reversible `AUTH_MODE` setting.** Retain the existing password code and stored hash for rollback. Do not migrate or reset campaign/provider data for this change.
2. **Repair the reproduced budget and retention defects.** Do this before shrinking sender budgets or deleting historical data.
3. **Keep the current D1 inbox/outbox and state-machine rules.** Add durable task scheduling and process ingestion, planning, dispatch, polling and cleanup in separate bounded invocations.
4. **Use two small Queues on the same Worker:** one for preparation/read/maintenance tasks and one for outbound dispatch. This isolates a slow provider send from normalization. Both queues share the account's daily operations allowance; a second queue does not increase capacity.
5. **Measure every phase on the target Free plan.** Query count is a safety bound, not a conversion formula for CPU milliseconds.

This plan covers every issue identified in the investigation and the additional failure cases introduced by the proposed redesign. It does not claim an independent audit has discovered every possible bug in the repository.

### User requirements incorporated

- The password switch must be easy to reverse.
- Ongoing campaigns must continue through the authentication change.
- Free-tier resource limits are hard design constraints.
- Queue capacity must include nonmatching events, normalization, polling, retries and maintenance, not only successful funnels.
- The proposed ~12 statements per stage is a sizing objective to test. It is not a guarantee of less than 10 ms.
- The previously exercised five-post/250-event ingestion batch is a workload fixture, not proven Free-tier CPU capacity. It will be split before becoming the production execution contract.

### What can be ensured about ongoing campaigns

An authentication-only change does not need to alter `campaigns`, `conversations`, Instagram `auth`, inbox/outbox jobs, send ledgers or checkpoints. Webhooks and scheduled handlers do not require owner login. The plan isolates these paths and tests their independence.

There is still a normal Worker deployment boundary: an in-flight request can be interrupted, and existing CPU failures can continue until the relevant runtime issues are fixed. Therefore, campaign continuity must be demonstrated through durable-state comparison and continued event processing, not promised solely from code separation. **Do not combine the initial Access switch with queue migration, connection replacement, retention cleanup or a full campaign resave.**

## 2. Resource contract and capacity model

### Platform allowances to design against

Workers Free documents 10 ms CPU per HTTP/cron invocation, 100,000 requests/day, 128 MB isolate memory and limited subrequests. Network waits do not create CPU, but request preparation, parsing and application execution do. A new async function, timer or `waitUntil()` call does not create a fresh invocation budget. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

D1 Free documents 50 queries per invocation, 500 MB per database, 5 GB account storage, 100 bound parameters per query and a 2 MB maximum row/string/BLOB. Count SQL statements and binding calls separately and validate deployed accounting. Keep the application's physical-statement ceiling conservatively below the documented query ceiling. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

D1's Free daily allowance is 5 million rows read and 100,000 rows written; index maintenance contributes to written rows. Query failure after daily allowance exhaustion is an operational constraint, not just a billing concern. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [daily-limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)

Queues Free currently includes 10,000 operations/day across writes, reads and deletes, with 24-hour retention. An ordinary small delivered message usually uses three operations. The ~3,333 messages/day figure is a theoretical ceiling without retries or other work. It is not the application's outbound-delivery entitlement. [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)

Queue consumers support configurable batching and explicit per-message acknowledgement/retry. Begin with one task message per invocation. Validate actual Free consumer CPU limits; generic consumer defaults are not permission to ignore the under-10-ms design goal. [Batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), [consumer limits](https://developers.cloudflare.com/queues/platform/limits/)

### Provisional engineering bounds

These are initial test parameters, not verified production capacity or provider-specific limits:

| Execution unit | Initial work ceiling | SQL design target | CPU release target |
| --- | --- | --- | --- |
| Verified webhook persistence | One envelope, measured byte ceiling; zero planning/sending | 4–6 ordinary statements; count guards/tasks | p99 <=7 ms |
| Normalization | Up to 10 events and 16 KiB returned event data, whichever comes first | <=12 ordinary statements | p99 <=7 ms |
| Planning | One event and a bounded candidate page | Around 12 ordinary statements | p99 <=7 ms |
| Dispatch | One authorized external attempt plus its outcome | Around 12 common-path statements; larger reserved error allowance | p99 <=7 ms |
| Provider-page fetch | One provider page stored durably; no planning/sending | <=12 ordinary statements where practical | p99 <=7 ms |
| Recovery/notification publisher | Up to four task references, also byte/statement capped | <=12 ordinary statements | p99 <=7 ms |
| Cleanup | Up to 50 eligible rows from one table | Small fixed number, including guard | p99 <=7 ms |
| Owner list API | Up to 25 summary rows, max 50 | Small fixed query count | p99 <=7 ms |

Start with a **40-physical-statement absolute application ceiling per invocation**, including guards, failure probes and task bookkeeping. This is an emergency guard, not a target to consume. A unit with a 12-statement ordinary path must also reserve enough for its largest failure path. If a task needs >12 after scheduling overhead but still fits measured CPU, record the justified limit; never remove essential writes merely to hit a round number.

The 7-ms p99 target deliberately leaves headroom. All >=10-ms observations require investigation. A finite successful test cannot prove that no future invocation ever exceeds 10 ms; workload bounds, alerting and handling oversize input remain necessary.

### Capacity formula

Define daily counts:

```text
E = planning tasks for all unique inbound events, including nonmatches
A = dispatch tasks, including public replies and authorized retries
N = normalization/continuation tasks
P = discovery and reconciliation page tasks
R = recovery, cleanup, reset and other task messages
X = extra deliveries from infrastructure retries, duplicate publication and failures

ordinary_queue_operations ~= 3 * (E + A + N + P + R)
actual_queue_operations = measured writes + reads + deletes, including X
```

Some retries add a read rather than a full new write/read/delete cycle. Use actual product metrics for final accounting; the three-operations expression is a planning approximation. Task rows in D1 do not themselves count as Queue operations, but they consume D1 rows and CPU.

Illustrative envelope, **not an accepted load promise**:

| Component | Task deliveries/day |
| --- | ---: |
| 1,000 unique events, all planning checks included | 1,000 |
| 400 attempted outbound actions | 400 |
| Normalization at about ten events per task | 100 |
| Reconciliation/discovery | 288 |
| Maintenance and recovery | 50 |
| Total before retry headroom | 1,838 |
| Approximate operations | 5,514 |
| With a conservative 30% planning margin | About 7,169 |

This example leaves room under 10,000, but D1 write/read, CPU, storage, request and provider limits must pass separately. Real webhook batch sizes and skipped/duplicate task messages change it.

The quoted ~833 two-message or ~416 four-message funnels/day are idealized limits that allocate the entire Queue budget to those funnels. They cannot be combined with unrestricted raw events and reconciliation at the same time.

For reconciliation alone, polling 100 posts every 15 minutes means 9,600 page tasks/day before pagination. At approximately three operations each, that already exceeds Free's Queue allowance. **Supporting 100+ active posts requires adaptive/less-frequent cold polling, fewer measured-small tasks, or a different capacity target; pagination alone does not solve the daily quota.** Webhooks remain the immediate event transport.

The configured 180 account attempts/hour and eight DM attempts/recipient/hour remain safety ceilings, not a promise that all those attempts fit Free's daily quotas. Retries and public replies count according to existing account rules.

## 3. Complete work register

Priorities: P0 = known correctness/continuity risk; P1 = required execution/capacity work; P2 = targeted efficiency and maintainability. “Confirmed” refers to the previous code/probe evidence; other rows are design controls or conditional optimizations.

| ID | Priority | Issue / deliverable | Evidence class | Main ownership |
| --- | --- | --- | --- | --- |
| A01 | P0 | Reversible Access/password owner gate | User requirement | auth, routing, login UI |
| A02 | P0 | Active-campaign continuity and auth rollback proof | Required release gate | integration fixtures / operator runbook |
| B01 | P0 | Explicit budget object; eliminate wrapper `Infinity` | Confirmed | budget, runtime, pollers |
| B02 | P0 | Reserve sender completion/failure work before authorization | Reproduced | engine, API client, connection guard |
| B03 | P1 | Bound work dimensions separately from elapsed time | Confirmed architecture gap | runtime and every task handler |
| R01 | P0 | Correct retention units and batch historical cleanup | Reproduced | maintenance, timestamp helpers |
| R02 | P1 | Retain compact duplicate/label evidence safely | Existing invariant and growth risk | outbox/read models |
| T01 | P1 | Split runtime into ingestion/planning/dispatch/page units | Confirmed architecture gap | engine, index, runtime |
| T02 | P0 | Durable task notification and D1/Queue transaction-gap recovery | New architecture requirement | task repository, Queue handlers |
| T03 | P0 | Lease fencing, duplicate handling and recipient ordering | New architecture requirement | tasks, conversations, engine |
| I01 | P1 | Streaming input bound, exact-byte HMAC, shape validation | Confirmed boundedness gap | webhook/http helpers |
| I02 | P1 | Raw envelopes and small normalization continuations | Large-payload design requirement | ingress repository / normalizer |
| I03 | P2 | Reduce redundant serialization, hashing and imports | Profile-driven optimization | normalization, match, runtime |
| E01 | P1 | Bound comment planning/config work and timestamp lookup | Confirmed work amplification | engine/config/client |
| E02 | P1 | Exact-payload fast path and bounded typed-reply fan-out | Confirmed historical fan-out | message planner / issued labels |
| E03 | P1 | Persistent pacing/backoff and one-attempt dispatch | Required execution boundary | dispatcher/tasks |
| E04 | P2 | Eliminate growing correlated fairness selection where measured | Query-plan evidence | recipient scheduler / SQL |
| P01 | P1 | Independent discovery/comments/messages scheduling | Confirmed starvation/cadence gap | pollers/tasks |
| P02 | P1 | Safe cycle boundaries, overlap and cursor recovery | Confirmed repeated-history work | checkpoints/pollers |
| P03 | P1 | Separate completion health from discovery activity | Confirmed coarse current signal | status/checkpoints/UI |
| C01 | P1 | Bound provider response work and classify transport phases | Existing timeout/ambiguity rules | API client / dispatcher |
| U01 | P1 | Cursor-paginate owner lists and exports | Confirmed unbounded/large result work | API/db/frontend |
| U02 | P2 | Bound/measure aggregates; materialize only if needed | Growth risk | status/statistics |
| U03 | P1 | Byte/semantic bounds for configuration and bulk operations | Confirmed input-bound gap | config/API/folders |
| U04 | P1 | Bounded reset/deletion with immediate connection fence | Large-history operational risk | disconnect/cleanup/UI |
| O01 | P1 | Low-overhead metrics and quota/backlog controls | Required proof | logging/status/operator scripts |
| O02 | P2 | Remove duplicate indexes/dead runtime work; align docs/tests | Confirmed redundancy/drift | schema/runtime/docs/tests |
| M01 | P0 | Additive schema, staged cutover and durable rollback | Required release design | migrations/deployment |
| V01 | P0 | Regression, failure injection and deployed CPU gates | Required proof | test/scripts/staging |

## 4. A01–A02: reversible authentication without disrupting campaigns

### Configuration contract

Add a typed setting:

```ts
type OwnerAuthMode = 'password' | 'access';

// Planned deployment variables; names finalized in the auth implementation.
AUTH_MODE = 'password' | 'access'
ACCESS_ISSUER = 'https://<team>.cloudflareaccess.com'
ACCESS_AUDIENCE = '<application audience>'
ACCESS_OWNER_SUBJECT = '<pinned issuer subject, once enrolled>'
```

The existing owner account remains the local owner record. Its email/password hash and `credential_version` remain available for rollback. Do not run `owner:reset`, `saveAuth`, campaign upserts, connection-generation changes or reliability migrations during this isolated auth release.

`AUTH_MODE=password` follows the current session/password behavior. `AUTH_MODE=access` accepts the approved Access identity and disables password login/change/verification endpoints before they invoke hashing. Invalid/missing Access configuration fails closed for owner routes; it must not throw during module initialization and break public webhooks or scheduled work.

Keep this auth setting independent from `MODE`, which currently controls webhook reconciliation cadence. Do not reuse `MODE` for authentication.

### Route boundary

| Surface | Access mode behavior |
| --- | --- |
| `/webhook` GET/POST | Public at the edge; current challenge/HMAC verification remains mandatory |
| `/health` | Public, minimal non-secret status |
| Scheduled/Queue handlers | No browser login or Access dependency |
| `/auth/callback` | Publicly reachable; existing owner cookie, one-time OAuth state and generation/ownership checks remain |
| `/api/*`, `/config/*`, `/admin/*`, `/auth/authorize`, `/auth/status` | Require valid approved Access identity and the app's owner session as applicable |
| `/session/access` | New same-origin POST bootstrap requiring validated Access identity; issues the existing owner-session cookie |
| `/session/login`, `/session/password` | Return a small managed-auth response in Access mode, with zero password hashing |
| `/auth/disconnect` | Managed-auth fresh-action authorization; no password verification in Access mode |
| UI assets | May remain static/public; private data APIs are gated; login UI shows the selected mode |

Use hostname/path-scoped Access applications and verify every production/preview hostname. Do not enable whole-Worker/account-wide protection without proving that Meta endpoints remain reachable. Cloudflare supports Access policies scoped to hostnames, including `workers.dev`, and paths. [Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

### Identity/session implementation

1. Add `src/auth/owner.ts` as the single owner-authorization facade. It selects the configured mode and returns the existing session-shaped owner context.
2. Add `src/auth/access.ts` for bounded token validation using a reviewed JOSE implementation or narrowly scoped WebCrypto verification. Pin algorithm, issuer, audience, expiry and owner identity. Never treat an email header or an unsigned decoded JWT as authentication.
3. Fetch keys only from the configured issuer's known cert endpoint, with a bounded response/key count, timeout and cache lifetime. An unknown `kid` permits one controlled refresh, not arbitrary URL fetching or repeated refresh floods.
4. Bootstrap into the existing random-token/D1 session model through an explicit login action. Associate only the existing owner. After enrollment, pin subject plus issuer; do not automatically create an owner from the first incoming identity.
5. Protect every owner entry point through the facade. A valid legacy app cookie alone must not bypass Access mode on a private API through another hostname. Preserve same-origin checks for mutations.
6. The public OAuth callback continues to validate its app session and consumed state. It cannot require an edge assertion on a path deliberately made public. Do not loosen its state/session checks to accommodate Access.
7. Logout revokes the app session and follows the supported Access sign-out flow. Avoid silent immediate recreation of the app session on every `/session` read; the UI should offer an explicit sign-in action.

Cloudflare documents signature and claim verification for Access assertions; follow that contract and exercise invalid/wrong-owner tokens. [Access token validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

### Password settings and destructive-action confirmation

In Access mode, the login and settings UI clearly identifies managed login. Retain the password settings code for rollback, but do not let it perform hashes while that mode is active. Existing CLI password login must detect managed mode and return actionable instructions; do not silently fall back to passwords.

For disconnect/reset, replace the password field with a fresh authentication flow plus an action-specific one-time grant. The grant binds session, owner, connection generation, action and expiry, and is consumed atomically with the reset fence. The Access policy must genuinely require fresh user verification for this action; a recently issued JWT `iat` is not by itself proof of a new user authentication. Confirm the chosen IdP/MFA and Access session behavior in the pilot. [Access session controls](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

If fresh verification cannot be established, do not quietly substitute a plain confirmation button. Keep this destructive endpoint unavailable in Access mode until the fresh-action path is proven; campaign execution remains independent. This is a narrow destructive-action gate, not a reason to keep password hashing on ordinary login.

### Ongoing-campaign preservation test

Build fixtures covering `NEW`, `AWAITING_TAP`, `AWAITING_FOLLOW`, `AWAITING_EMAIL`, completed conversations, pending/retry/held jobs, one `sending` job, one `unknown` job, archived campaigns and an unfinished poll cursor.

Before switching auth mode, record canonical rows/hashes for campaign configs and instance IDs, conversation states/versions, job IDs/request/transition snapshots, connection generation, auth token identity, send attempts and poll cursors. An auth-only request may alter owner sessions/login bookkeeping; it must not mutate the recorded automation data.

Run both mode configurations against the same disposable database. Deliver a signed comment and postback without any owner cookie or Access assertion. Continue each active funnel with mocked provider requests. Check exactly the intended next action occurs, with no new opening for a previously opened recipient. Preserve `unknown` without replay. Exercise a due scheduled handler with no owner login.

Then switch back to password mode and confirm the original stored password still verifies and the same campaign/conversation/job identities remain. This rollback restores old auth behavior, including its known CPU limitation; it is an emergency compatibility path, not Free compatibility proof.

**Done when:** all preservation fixtures pass, private routes reject a plain legacy cookie in Access mode, public Meta routes have no Access redirects, both authentication modes work as specified, and the deployment runbook can switch modes without a provider reconnect or campaign rewrite.

**Files:** [index.ts](../src/index.ts), [types.ts](../src/types.ts), [session.ts](../src/auth/session.ts), [disconnect.ts](../src/auth/disconnect.ts), [routes/auth.ts](../src/routes/auth.ts), [App.tsx](../frontend/src/App.tsx), [PasswordSettings.tsx](../frontend/src/PasswordSettings.tsx), [DisconnectSettings.tsx](../frontend/src/DisconnectSettings.tsx), [session-login.mjs](../scripts/session-login.mjs). New `owner.ts` and `access.ts` are planned files, not present implementation.

## 5. B01–B03: budgets that cannot lose their identity or spend completion capacity

### B01 — explicit invocation context

Replace `remainingQueries(db)` identity discovery in application logic with one explicit per-invocation object. Pass it into wrappers, runtimes, pollers and task handlers; the guarded DB proxy is no longer asked to locate it.

Conceptual interface:

```ts
interface InvocationBudget {
  readonly statementsUsed: number;
  readonly statementsAvailable: number;
  canStart(cost: WorkCost): boolean;
  reserveStatements(count: number, purpose: string): Reservation;
  chargeStatement(pool?: Reservation): void;
  chargeBytes(kind: 'input' | 'returned', bytes: number): void;
  chargeEvents(count: number): void;
  chargeProviderRequest(): void;
}
```

Charge at the raw-binding boundary exactly once. A guarded transaction's guard and every member consume statements; `bind()`/`prepare()` alone do not. Failed attempts consume reserved accounting when they were actually submitted; denied pre-submission work must not be mislabeled as executed SQL. Track binding calls separately for diagnosis. Diagnostics after a guard error are budgeted too.

Production context is mandatory. Tests must opt into an explicitly unbounded fixture context if needed; missing context must not silently mean `Infinity`. Keep error typing so a predictable work stop is distinguishable from disconnect and database outage.

**Tests:** pass the same context through raw/budget/connection wrappers; inspect both remaining count and submitted statement count; exhaust inside a batch before submission and assert no partial mutation; prove guard-error diagnostics cannot unexpectedly use completion reserves. Replace the existing `Infinity` probe with an assertion of shared finite accounting.

### B02 — completion reservation and dispatch phases

Before changing a job to `sending`, reserve the largest supported success/failure/finalization path **including task completion and all connection-guard error probes**. Ordinary planning, telemetry or later tasks cannot consume this pool.

Start by instrumenting the current success, rejected, rate-limit, auth-held, unknown, connection-changed, missing-ack and D1-finalization-failure branches. Use their largest statement count plus documented headroom. Twelve statements reserved for completion is a prototype parameter to validate, not a proven universal count.

Use structured dispatch phases:

```text
not_authorized → authorized_not_started → request_started → acknowledged → finalized
```

- If sufficient completion capacity is unavailable before authorization, leave the job pending and arrange a fresh task. No attempt or provider request occurs.
- If provider preflight definitively fails before `fetch` starts, record a safe held/deferred result. Do not classify a known-never-started request as uncertain delivery merely because a reservation exists.
- Once the request can have reached Meta, any missing/untrusted acknowledgement is uncertain unless an explicit provider rejection proves otherwise.
- After an acknowledgement, finalize through the original owner token, job status and expected conversation version. Do not retry the external send if finalization fails.
- An actual D1 outage or runtime termination can still interrupt outcome persistence. Software cannot guarantee atomicity across Meta and D1 without provider idempotency/receipt recovery. Preserve `sending`/`unknown` and owner review in that case.

`guardedConnectionDb()` currently performs another `assertConnection()` after a failed batch. Its exception handling must not mask an original budget error or spend reserved capacity on repeated diagnostic failures. Short-circuit known pre-submission `WorkBudgetExceeded`; otherwise use a separately budgeted best-effort diagnostic and preserve the original failure cause.

**Tests:** sweep every remaining-budget boundary through dispatch; low capacity causes zero sends; sufficient capacity permits acknowledgement persistence; inject failures before request start, after accepted send, during body read and during finalization; duplicate task delivery never resends `sending`/`unknown`/confirmed jobs. The previous six-remaining-query reproduction must now stop before authorization.

### B03 — independent work dimensions

Keep wall deadlines for I/O/lifecycle safety. Add independently enforced bounds for events, bytes, returned rows, provider requests and statements. CPU is measured by Cloudflare and attributed through profiles; timers do not serve as an exact CPU meter.

Every handler returns a typed result such as `done`, `continue`, `defer_until`, `blocked`, `stale_generation` or `uncertain`. A work stop must leave durable progress and a resumable task; it is not a generic catch-and-forget success.

**Files:** [budget.ts](../src/reliability/budget.ts), [connection.ts](../src/connection.ts), [runtime.ts](../src/runtime.ts), [engine.ts](../src/engine/engine.ts), both pollers and [index.ts](../src/index.ts).

## 6. R01–R02: correct retention without reviving old sends

### R01 — explicit units and small deletes

Create a field/unit inventory before editing predicates:

| Field family | Current unit | Required treatment |
| --- | --- | --- |
| `send_attempts.dispatched_at` | Milliseconds | Compare with `nowMs - 24h` |
| `inbound_events.created_at`, `event_ms`, `next_at`, leases/touched time | Milliseconds | Completed-event retention uses `nowMs - 7d`; never delete active events |
| `outbound_jobs.created_at`, `updated_at`, dispatch/next/resolution times | Milliseconds | Retain outcome/suppression evidence; compact selectively |
| `automation_audit.created_at` | Milliseconds | Compare with `nowMs - 30d` |
| `conversations.created_at`, `updated_at` | Seconds | Current 90-day terminal-conversation policy remains second-based |
| `conversations.event_boundary_ms` | Milliseconds | Never compare directly to second-based activation fields |
| `events.created_at` | Seconds | Analytics retention uses second cutoff |
| Campaign activation/resume and checkpoint `boundary` | Seconds | Explicit conversion at event comparisons |
| Checkpoint `next_at`, attempts, update times | Milliseconds | Task deadlines stay millisecond-based |
| Owner sessions, auth expiry and most legacy KV timestamps | Seconds | Preserve established contracts |

Use named helpers `nowMs()`, `unixSeconds()` and clear argument types/names. Prefer branded timestamp types at boundary-heavy APIs; avoid rewriting every historical column merely for stylistic consistency. Correct the outdated `db.ts` “all timestamps seconds” comment.

Run the fixed predicates in bounded maintenance tasks. Use primary-key deletion selected by an indexed age predicate, for example:

```sql
DELETE FROM send_attempts
WHERE id IN (
  SELECT id FROM send_attempts
  WHERE dispatched_at < ?
  ORDER BY dispatched_at, id
  LIMIT 50
);
```

Do not assume SQLite's optional `DELETE ... LIMIT` extension. Keep cleanup age cutoffs fixed within a cleanup cycle, stop on budget, and schedule another batch if work remains. Count index writes when sizing batch size. Index creation on large existing tables is itself maintenance work and must be planned, not hidden inside the request handler.

Inspect pre-existing values before any data repair. Do not divide a column by 1,000 based on its name alone. Ten-day-old millisecond fixtures must age out; recent rows and pending/processing inbox entries must remain. Verify rate calculations around cutoff boundaries and ensure cleanup cannot remove a row still needed by the one-hour limiter.

### R02 — separate payload retention from suppression retention

Keep stable identifiers, instance/action uniqueness, recipient association and normalized issued-button ownership evidence for as long as existing behavior relies on them. Retained request/transition text can later be compacted only after all readers have moved to equivalent compact fields.

Terminal-conversation cleanup must also preserve the disposition needed to interpret later comments/replies for the same live campaign instance. Retaining a confirmed opening job while deleting its conversation must not leave a newly recreated `NEW` conversation with an already-suppressed opening and no way to advance. Test this explicitly; retain a minimal terminal conversation/tombstone or make the planner consult equivalent retained lifecycle evidence before creating a new row.

Unknown or unresolved sends retain enough original evidence for owner resolution. Deleting a campaign must not erase already-dispatched action suppression and cause a delayed postback or event to recreate delivery. Recreating a campaign gets a new instance as today.

Add a compaction migration only after typed-message ownership queries and snapshot-based state logic pass against compact records. Old request JSON stays readable during backfill. Retention cannot provide indefinite full message-body history within a finite 500-MB database; measure storage and keep necessary compact evidence rather than claiming unlimited history.

**Done when:** the existing retention defect probe asserts deletion, active rows are preserved, duplicate/comment/public-reply/legacy/button tests still suppress the same actions, cleanup operates incrementally and old audit/report text matches the actual policy.

**Files:** [index.ts](../src/index.ts), [engine.ts](../src/engine/engine.ts), [db.ts](../src/db.ts), planned maintenance helper/task, future additive indexes/compaction migration where justified.

## 7. T01–T03: execution and durable scheduling design

### T01 — responsibilities and runtime seams

Keep `Engine` as the public orchestrator initially, with methods that expose one bounded unit. Extract modules only where a responsibility needs its own lifecycle or tests; do not rewrite all business rules at once.

Planned seams:

```ts
ingestBatch(input, context): Promise<IngestResult>
normalizeEnvelope(envelopeId, context): Promise<TaskResult>
planEvent(eventId, context): Promise<TaskResult>
dispatchJob(jobId, context): Promise<TaskResult>
pollCheckpoint(checkpointKey, context): Promise<TaskResult>
recoverBatch(context): Promise<TaskResult>
cleanupBatch(cleanupKey, context): Promise<TaskResult>
```

Ingestion does not construct an Instagram sender or drain globally. Planning can perform only explicitly bounded read-only timestamp lookup when needed; otherwise it is D1/state-machine work. Dispatch accepts an identified job and sends at most once. Reconciliation does not invoke global drain before or after its page.

All production entry points—webhooks, scheduled handlers, Queue consumers and manual admin tools—use these same seams and budgets. `/admin/poll` should request bounded durable work and report progress, not bypass the architecture with synchronous global processing. Legacy direct engine methods remain test adapters temporarily, then lose production call sites.

### T02 — D1 task intents, not ephemeral scheduling

Add one `work_tasks` table for scheduling metadata. Inbox events/outbox jobs/checkpoints remain the authoritative business state. A task references a durable object; it does not copy message content or provider credentials into Queue payloads.

Draft field contract, to turn into reviewed migration SQL:

| Field | Purpose |
| --- | --- |
| `id`, `kind`, `reference`, `generation` | Deterministic task identity and referenced object |
| `revision`, `settled_revision` | New work versus the version already satisfied |
| `next_at_ms` | Earliest execution time, including pacing/backoff |
| `lease_token`, `lease_until_ms`, `leased_revision` | Execution ownership/fencing |
| `published_revision`, `notification_until_ms` | Notification already in flight; avoid repeated publication |
| `publisher_token`, `publisher_until_ms` | Short publication ownership lease |
| `failure_count`, `blocked_reason`, timestamps | Bounded retry and operator visibility |

Start with deterministic task IDs for individual event/job/envelope/checkpoint references. Duplicated provider events or repeated notification attempts reuse the same task. Do not add recipient-level coalescing unless capacity measurements require it; that is a separate optimization with additional ordering/version complexity.

Task intent is inserted/touched in the **same D1 transaction** that creates durable source work or a continuation. New work increments the task revision without erasing an active lease. Use guarded transactions where the task belongs to an Instagram connection.

Queue message contract:

```ts
type WorkNotification = {
  schema: 1;
  taskId: string;
  generation: number;
  revision: number;
};
```

Keep payloads comfortably below 1 KiB. Validate schema/type/length before looking up the task. Queue messages never carry access tokens, passwords, full webhook bodies or mutable campaign configuration.

Publication protocol:

1. Claim a due unpublished task with a short publisher token.
2. Send its notification to the correct Queue.
3. Mark the published revision/notification window only with the same publisher token and revision condition.
4. If send fails, keep/release the intent for delayed retry. If send succeeds but step 3 fails, duplicate publication is allowed; consumers fence effects through D1.
5. If the process dies before publishing, a minute watchdog finds the intent after its publisher lease expires.

An HTTP request can attempt a small publication after persistence, but only within its measured work budget. If the Queue is unavailable after a successful durable commit, acknowledgement can still succeed because the recovery contract owns the recorded intent. If D1 persistence fails, do not acknowledge success.

The watchdog only repairs **missing/expired notifications and leases**. It must not republish every pending task each minute. Polling an empty push Queue is unnecessary; avoid a pull-consumer loop.

### T03 — consumer state and stale completion

Consume one notification per invocation. The handler loads current source state and conditionally claims its task using a random lease token. Use wall time for expiry, not as the sole ownership token. An old timestamp/notification cannot authorize a newer phase.

Possible outcomes:

| Durable condition/outcome | Queue action |
| --- | --- |
| Task missing, terminal, superseded, stale connection generation | Ack harmlessly after required validation |
| Another live lease owns it | Ack duplicate; existing notification/lease recovery owns progress |
| Task is not due | Retain D1 `next_at`; publish/delay once as supported; do not hot retry |
| Success | Atomically settle the leased revision and persist source-state changes, then ack |
| Continuation remains | Persist cursor/next time plus an outstanding task revision in the same transaction; arrange one notification |
| Temporary pre-effect failure | Durable backoff plus bounded retry/republication |
| External outcome unknown | Persist `unknown`/hold; settle dispatch execution; never use Queue retry to resend |
| Invalid durable input / repeated deterministic failure | Block task with sanitized evidence and alert; stop transport retry storms |

A worker settling revision `r` must not mark revision `r+1` complete or clear its notification. A stale publisher must not overwrite newer scheduling. A delayed worker must not finalize after losing a lease unless the existing job-specific ownership rules explicitly permit a known outcome.

For recipient ordering, preserve the current ambiguity and conversation-version checks. Claim the earliest eligible event for that recipient with a deterministic timestamp/ID tie-break where required. A later event cannot be silently discarded because an earlier opening/follow job is still pending. Block/defer it with a durable wakeup dependency, not a busy loop.

Do not depend on Queue delivery ordering. Add the smallest DB recipient lease/scheduling row if the existing per-event/conversation checks cannot prevent cross-event overlap under concurrent work consumers. That extra state is justified by a demonstrated race, not by an assumption that concurrency is always unsafe.

### Queue configuration sketch

The following is a proposed config fragment, **not an applied change**:

```toml
[[queues.producers]]
binding = "WORK_QUEUE"
queue = "fadeloop-work"

[[queues.producers]]
binding = "SEND_QUEUE"
queue = "fadeloop-send"

[[queues.consumers]]
queue = "fadeloop-work"
max_batch_size = 1
max_batch_timeout = 1
max_concurrency = 2
max_retries = 3

[[queues.consumers]]
queue = "fadeloop-send"
max_batch_size = 1
max_batch_timeout = 1
max_concurrency = 1
max_retries = 3
```

Confirm schema support against the pinned Wrangler before committing the fragment. Both consumer configurations dispatch through the same exported `queue()` handler based on the Queue name. The D1 task record remains after transport retries are exhausted; the watchdog and blocked-task visibility prevent silent loss. A separate dead-letter Queue is optional only if it provides a demonstrated operational benefit; it is not required as a third service in the initial design.

Single send-consumer concurrency is conservative, but it is not the account's only safety mechanism. Keep transactional account/recipient authorization because old invocations, manual tasks and retries may overlap. Work concurrency two prevents one slow read from monopolizing all preparation; actual latency and row contention must be measured.

**Done when:** every D1/Queue crash window survives, no notification can authorize a duplicate external effect, stale revisions cannot erase new work, every deferred event/page has a discoverable owner, and slow provider sends do not block all input normalization.

**Files:** [index.ts](../src/index.ts), [runtime.ts](../src/runtime.ts), [engine.ts](../src/engine/engine.ts), [types.ts](../src/types.ts), `wrangler.toml`; planned `src/tasks/` repository/consumer/publisher modules and an additive migration.

## 8. I01–I03: bounded webhook input and normalization

### I01 — authenticate exact bytes and validate only a bounded shape

1. Inspect declared length as an early rejection hint, but do not trust it as the only bound.
2. Read the stream with a hard byte counter and cancel it when it exceeds the supported envelope limit. Keep the current 512-KiB ceiling initially as a compatibility limit **only if the raw-persistence/HMAC stage passes CPU/memory tests at that size**.
3. Verify Meta's HMAC over the original bytes. Decode only after authentication if the storage/parse path requires text. Do not reserialize JSON for signature verification.
4. Reuse one encoder/decoder where appropriate and cache the imported HMAC key by current configured secret/version. Secret rotation must select a new key; never reuse a key across differing secrets.
5. Validate top-level type, `entry` array and expected nested field types. Authenticated malformed input must get a small deterministic error or durable quarantine, rather than an uncontrolled exception or endless processing retries. Do not reject valid unknown Meta fields simply because the application does not consume them.
6. Pin the connection snapshot for accepted persistence. Moving the initial generation read after signature verification requires an explicit race test: a request that started for an old connection must not be reinterpreted as an event for a newly connected account. A cheap invalid-signature optimization is secondary to correct generation binding.

Unknown accounts/disconnected mode retain the existing intentional response contract. Never expose APP_SECRET or raw private messages in rejection logs.

**Tests:** chunked body with no length header; misleading small length; exactly-at-limit and one-byte-over payload; multibyte text; malformed validly signed JSON; absent arrays; read receipts/echoes; secret rotation; disconnect/reconnect between snapshot, verification and persistence.

### I02 — persist envelopes before expensive expansion

Use one raw-envelope path initially to avoid maintaining two different acknowledgement guarantees. Store a verified envelope and normalization task atomically; do not normalize an entire burst before acknowledging it.

Planned `ingress_batches` fields:

```text
id, generation, source, raw_payload, payload_bytes,
position/continuation, status, created_at_ms, updated_at_ms,
error_code, lease metadata where not owned by work_tasks
```

Envelope identity is a stable digest of connection generation plus original bytes/source. Byte-identical redelivery reuses its row/task. Different payloads with the same provider event IDs can coexist at the envelope level; the existing event identity/upsert handles cross-envelope dedup and richer repairs.

Store only content needed for recovery. Encrypting/partitioning raw account data is a separate requirement if hosting policy demands it; do not scatter it into notification payloads. Completed raw bodies get a short documented retention window once normalization is committed; pending batches never expire merely because Queue retention expires.

Normalization algorithm:

1. Claim the envelope task/version.
2. Extract a deterministic slice of candidate comment/messaging entries, capped by event count and returned bytes. Ignore non-content receipts/echoes with the same rules as today.
3. Preserve original timestamps and identifiers. Do not replace missing provider time with receipt time to bypass activation/window rules.
4. Build canonical normalized events and existing identity digests only for this slice.
5. In one guarded transaction, upsert the inbox rows, record their planning intents, and advance the envelope continuation under its lease/version.
6. Commit before settling the Queue notification. Persist a normalization continuation when more candidates remain.

**Large JSON parsing is itself work.** Storing a 512-KiB body does not make a later `JSON.parse()` cheap. Prototype bounded SQL JSON extraction from a stored payload and measure D1/returned-row cost; SQL `json_each` over a large body is not inherently cheap either. Where nested Meta arrays require a flattened child table, build that representation in a measured page/task, not one unbounded initial expansion.

Choose a deterministic continuation over entry/change or entry/messaging positions. Never rely on an unstable query result order without explicit ordering. A candidate larger than the normal 16-KiB slice must have a dedicated bounded large-event path; do not silently omit it or increment the cursor past it. Validate provider-defined message limits before choosing that path's cap.

If no implementation can process the supported envelope size within measured limits, reduce the *declared supported envelope* with an explicit compatibility decision or choose different compute. Repeated 413/503 responses to the same valid provider payload are not a successful scaling strategy.

Provider polling pages can use the same durable-batch representation, with a different source and checkpoint attachment. This avoids duplicate normalization logic and preserves receipt/page progress through crashes.

**Tests:** 1/6/50/100/501 entries, distinct versus identical events, richer repair after an incomplete event, nested multiple entries, one oversized event, restart at every continuation boundary, same event in webhook and poll, D1 rollback, Queue outage, old-generation raw batch. Final normalized event counts and IDs must match the existing behavior.

### I03 — optimize only equivalent work

After the new stage passes correctness tests:

- Avoid repeated encoding of the entire raw body.
- Reuse stable `TextEncoder` and bounded cached verification keys.
- Keep the existing canonical event ID algorithm and job ID algorithm during cutover. Changing hex representation or ID input would invalidate duplicate suppression.
- Limit digest concurrency within a slice; never launch one promise per event in an arbitrarily large envelope.
- Reuse serialized content once within the slice; avoid repeated `JSON.stringify` of unchanged objects.
- Preserve byte-identical in-slice deduplication and incomplete-event repair semantics.
- Keep the existing bounded escaped-regex cache. Bound keyword arrays rather than replacing Unicode word matching with substring checks.

**Files:** [webhook.ts](../src/routes/webhook.ts), [engine.ts](../src/engine/engine.ts), [match.ts](../src/engine/match.ts), planned ingress/normalization modules and migration.

## 9. E01–E04: comment/message planning and dispatch

### E01 — comment planning

Retain the indexed `media_id` lookup for the one active campaign. Select only required campaign fields rather than `SELECT *`. The one-active-automation-per-post constraint remains enforced in D1.

Validate campaign shape at write time and enforce explicit byte/array limits (U03). For existing rows, parse through the current tolerant reader; add a validated config revision so a bounded per-invocation cache can reuse a config without stale behavior. Avoid cross-invocation caching of mutable eligibility unless invalidation/version checks are explicit.

A comment plan creates at most the opening and configured public-reply jobs with their stable IDs. Source event completion and task intents for new jobs commit with those plan writes. Existing conversations retain their pending-job/version/instance checks and legacy suppression.

Missing timestamps become a dedicated lookup continuation. One lookup page is persisted with its cursor before another attempt. Do not fetch all comment pages inside one plan. An unresolved timestamp leaves a visible retry/hold state; no delivery based on invented receipt time. Validate the comment's original account/media/identity when resolving it.

**Done when:** no-match, exclude, Any activation, resumed campaign, self comment, duplicate opening, legacy claims, missing timestamps and public replies behave identically under staged execution. One event plan cannot drain unrelated jobs.

### E02 — exact payload fast path and safe typed fallback

For `FL1:<jobId>`:

1. Validate bounded syntax and load the one job under current generation and recipient.
2. Require an opening/follow action and established dispatch evidence, using the same uncertainty/postback-confirmation rules as today.
3. Load only its campaign instance and recipient conversation.
4. Apply the appropriate version-conditioned state transition and persist the next job/task.

Do not load every historical conversation before resolving that token. Unknown/wrong-recipient/cross-instance payloads cannot fall through into generic text handling and accidentally advance another funnel.

For typed labels and legacy untagged payloads, add a compact issued-label read model keyed by job ID with generation, recipient, campaign instance, action, normalized title and dispatch evidence. Populate it alongside dispatch authorization or from the exact existing eligibility rule; backfill it in small batches before switching the reader.

Reuse the current Unicode/variation-selector/whitespace/case normalization exactly. A shorter normalized label or different trim boundary could change ownership. Keep enough original button-title/snapshot data for current conversation copy behavior.

Ownership resolution should ask indexed questions returning at most the evidence needed to decide:

- Does an eligible open conversation own a matching issued label?
- Are there at least two distinct issued matches that make the reply ambiguous under current rules?
- Does the text only match a completed/old issued button and therefore need to be ignored?

Use a two-result ambiguity probe rather than transferring every matching historical snapshot. Do not choose the newest campaign as a convenient replacement for the existing ambiguity policy. Preserve distinct-label rules for opening/follow buttons and all legacy-instance restrictions.

Email replies can legitimately affect more than one eligible conversation in the current engine. Bound candidate processing with a durable plan continuation. If the complete ownership decision needs multiple candidates before any send, establish that decision first. Persist an explicit deterministic target/cursor snapshot if a mutable sort would otherwise skip/repeat candidates. Do not arbitrarily `LIMIT 1` and lose intended deliveries.

**Tests:** old completed label versus current label, duplicate labels across campaigns, same opening/follow label, custom Unicode titles, unknown exact token, postback resolving unknown delivery, typed email across multiple eligible campaigns, edits/archive/delete during candidate continuation. A task retry cannot create a second delivery or apply email to a different target set accidentally.

### E03 — dispatch, persistent pacing and failure policy

Dispatch receives a known job ID. Its primary path does not select a random global job. Check job/source state, generation, campaign eligibility, conversation version and request expiry in bounded queries.

Calculate a conservative next attempt time before authorization. If pacing is not ready, persist `next_at_ms` and arrange a delayed task; do not sleep and then drain more jobs in the same invocation. Preserve atomic account/recipient rate checks in the authorization transaction because a prior read is not a lock.

For the hour limit, use the indexed current-window attempts to find when capacity can reopen. A held job must not wake every 1.2 seconds throughout a one-hour rate hold. Respect Retry-After; add bounded jitter where appropriate. Longer-than-transport-delay scheduling remains in D1 until due.

Use the reserved completion pool (B02), one provider request, and bounded response processing (C01). Persist job outcome, conversation transition, analytics and task settlement atomically when their conditions permit. `confirmed` finalization stays idempotent; analytics must be inserted once even after duplicate notifications.

Retain current rate-limit retry cap, expired messaging windows, rejected/failed lifecycle, account pause and recipient uncertainty holds. Do not mark every 4xx safely retryable: some errors are rejected, some auth-held, and malformed or ambiguous success responses remain uncertain. Provider-specific contracts must be verified for the pinned API version.

**Tests:** 180/hour boundary, recipient limit boundary, public reply accounting, exact interval collision with two dispatchers, account pause after pacing read, expired request, provider auth failure, Retry-After, retry exhaustion, acknowledged-send finalization failure, unknown/owner resolution. Account and recipient counters remain conservative under crashes.

### E04 — queue fairness and selectors

Targeted task IDs remove the global fairness-sort query from ordinary dispatch and most planning. Recovery still needs to find old unscheduled work. Query its smallest due-key set by explicit kind/generation/time, not repeated `ORDER BY correlated MAX(...)` over the entire inbox.

If a recipient scheduling row is required for T03, store materialized last-served and next-ready metadata there and update it in the same event-claim transaction. Test bounded starvation across recipients and event ordering within a recipient. Do not introduce a second independently authoritative rate limiter.

Inspect actual query plans at increasing pending/history sizes. Add only indexes that support the new selectors. Start with existing indexes where they suffice. Retire the old correlated selector only after recovery/fairness tests show equivalent or better behavior; deleting it before tasks own all work would orphan backlog.

**Files:** [engine.ts](../src/engine/engine.ts), [transitions.ts](../src/engine/transitions.ts), [conversation.ts](../src/reliability/conversation.ts), [client.ts](../src/api/client.ts), planned issued-label read model/task helpers.

## 10. P01–P03: reconciliation that is fair, resumable and affordable

### P01 — separate scheduling from page execution

Restore a **small minute recovery watchdog**, and retain a slower discovery/reconciliation opportunity. The minute handler only inspects a bounded due-intent/lease set and publishes eligible work; it does not call global drain or both pollers.

A configuration with a minute cron and daily refresh can schedule reconciliation from a persisted `next_discovery_at_ms`; a third cron is unnecessary. Choose one scheduling source of truth and test coincident daily/minute invocations. Rename misleading comments/variables so provider-poll cadence and durable-job recovery cadence cannot be confused.

Use distinct checkpoint kinds: conversation discovery, media comments, thread messages and timestamp lookup. Replace `substr(key,...)` filtering with an explicit kind column where the new due selector needs it. Claim a known checkpoint under a random owner token/attempt revision, current generation and expiry. Never commit a page from an old failed attempt over a newer attempt's cursor.

Separate conversation discovery from reading a thread's messages. An empty account can avoid creating pointless per-thread work. An active campaign can enqueue a comment-page task; a discovered eligible thread can enqueue its own page task. Every page includes a durable continuation. Limit outstanding scheduled cold-poll notifications so they cannot flood the work Queue ahead of fresh normalization.

Adaptive cadence is required for Free capacity:

- Newly active posts and recently interacting funnel threads receive the shortest budgeted interval.
- Repeatedly empty or unchanged objects back off toward a documented longer interval.
- Failed reads use existing exponential/jitter/Retry-After behavior.
- Give aging cold objects a maximum service age within the declared capacity envelope; surface when quota makes that target impossible.
- Explicitly reserve a share of poll-page budget for comments, discovery and messages so one kind cannot consume everything.

Do not stop reconciling merely because webhooks normally work. Do not claim a 15-minute *whole-account* sweep when only one bounded page is scheduled every 15 minutes. Show next/last completed coverage per object/type.

### Page persistence and checkpoint ownership

For small measured pages, inbox upserts + continuation + planning intents can commit together. For pages requiring multiple normalization slices, store the **complete fetched page durably with its input cursor, next cursor, generation and claim token**, and mark it pending normalization. That commit is the checkpoint's recoverable page record.

Do not advance an unrecorded next cursor and rely on an in-memory response. Do not advance the completed-cycle watermark until every staged page slice commits. A late normalizer from an old read claim cannot overwrite a newer cursor or retire the wrong page. Retrying a stored page must produce the same inbox identities.

If provider fetch succeeds but page persistence fails, retain the original checkpoint cursor. Refetch with stable IDs and deduplication; do not mark the page complete or update healthy coverage.

### P02 — safe historical boundaries

The current fixed cutover boundary is conservative but revisits history. Do not replace it with `max(timestamp)` immediately: Meta pagination ordering, cursor invalidation and late visibility must support that optimization.

Add separate checkpoint fields:

```text
kind, object_id, completed_boundary_s,
cycle_started_at_ms, cycle_observed_high_ms, cycle_token,
lease_owner, lease_until_ms, pending_page_id
```

These are design fields, not a demand to rename all legacy columns in one migration. Preserve old boundary/cursor reads until new writers and backfill are validated.

Implementation gates:

1. Capture provider contract/fixtures for ordering, pagination consistency, timestamps and supported filtering. A cursor is not assumed to be a snapshot unless documented or verified.
2. Record the upper boundary observed during a cycle independently from the lower eligibility boundary.
3. Only after all staged pages finish can a supported completed-cycle boundary advance. Apply a justified overlap window, not an arbitrary guessed delay allowance.
4. Test equal timestamps, page mutation, delayed visibility, old-created/newly-visible events and invalid cursor restart.
5. If the provider cannot support a loss-safe advancing boundary, retain the conservative boundary. Reduce repeated CPU through batched known-provider-ID/status checks before expensive reserialization/hashing, plus adaptive cadence. Keep occasional full coverage according to the supported recovery contract.

For the safe fallback, add explicit provider kind/ID fields to the inbox where available, backfill in bounded chunks, and query a small page of known IDs. Skip only events already durably complete and incapable of requiring richer repair. Missing-ID fallback identities and incomplete pending records still go through the existing canonical upsert path.

This solves avoidable pre-insert work without claiming the API guarantees an infinite-history incremental feed. If the desired recovery latency cannot fit the verified provider contract and Free quotas, document that constraint rather than advancing a watermark unsafely.

### P03 — health that measures coverage

Separate `last_discovery_completed`, `last_page_persisted`, `last_normalization_completed` and `oldest_due_object_age`. The current message poll can update a global timestamp after discovery even when another thread's messages fail; a recent global timestamp is not proof of complete message coverage.

Retain sanitized per-object error evidence and failure counts. Clear an error only after the applicable owned operation succeeds. A checkpoint write without durable page progress must not mark it healthy. Status should distinguish provider failure, quota delay, pending normalization, auth expiry and disabled reconciliation.

**Tests:** many active posts/threads, full 50-item pages, empty pages, cursor invalidation, discovery success/message failure, one failing object among healthy objects, message/comment contention, restart mid-page, expired auth, no incoming HTTP traffic. Assert maximum object age under the accepted envelope, not just total eventually processed count.

**Files:** [commentPoll.ts](../src/poller/commentPoll.ts), [messagePoll.ts](../src/poller/messagePoll.ts), [checkpoint.ts](../src/poller/checkpoint.ts), [runtime.ts](../src/runtime.ts), [index.ts](../src/index.ts), [status.ts](../src/reliability/status.ts), [AutomationSafety.tsx](../frontend/src/AutomationSafety.tsx).

## 11. C01: provider requests, response limits and outcome classification

Keep a fresh generation/auth preflight before external operations; an auth value cached during ingestion cannot authorize a later send. Separate read-only API helpers from effectful sends in their error typing.

Wrap fetch plus body consumption in a deadline that actually covers both. Test headers-arrive/body-stalls behavior against the current runtime. A timer installed only around awaiting headers is insufficient. Respect the per-task remaining wall deadline and release/cancel body readers on abort/oversize.

Use a bounded response reader. Prototype a 256-KiB page-response limit and a much smaller acknowledgement/error limit, then reconcile these against real provider payloads and requested field sizes. Polling may request a smaller page if supported. Bound error fields and trace IDs before storing/logging them.

For reads, a response too large or malformed is a failed page; persist backoff without moving its cursor. For sends, an oversized/malformed body after request start is potentially accepted delivery and therefore uncertain. Never turn a parser exception into authorization to retry an external effect.

OAuth token exchanges, token refresh and profile/subscription diagnostics need equivalent time/response bounds even though their volume is low. Do not log URLs containing tokens. Preserve the currently pinned Graph version until provider contract verification justifies a separate update.

**Tests:** timeout before headers, truncated/malformed success body, HTTP 500 after accepted send, explicit 4xx rejection, missing message ID, empty successful body, oversized page, oversized error, disconnect before preflight, disconnect after provider request start, token refresh body stall. No failure is classified as never-sent without phase evidence.

## 12. U01–U04: bounded owner operations and data lifecycle

### U01 — lists and CSV

Campaign list API returns summaries with a cursor and capped page size. Add a detail endpoint for the builder's full campaign config. Update every frontend list/builder/archive consumer in the same release; backend-only pagination would silently hide campaigns.

Use a stable tuple cursor such as `(updated_at, campaign_id)` for a fixed archive/filter selection. Validate and size-bound cursor input; include filter identity to reject incompatible cursors. Specify behavior when rows update between pages. A D1 query's `LIMIT` must be accompanied by a returned-byte/config-size contract.

Contacts select only displayed/exported columns, rather than entire conversation rows. Add stable cursor pagination where needed. Automation review replaces million-row `OFFSET` pagination with a tuple incorporating status priority, timestamp and ID, preserving unknown-first review behavior.

CSV currently caps at 500 rows. Preserve a clearly labeled bounded export first, with total/truncation indication. If complete large export is required, generate durable bounded chunks and provide a paginated download protocol or an independently reviewed storage-backed export. Merely streaming one huge query still performs cumulative CPU in one invocation; do not remove the cap as an incidental performance fix.

**Tests:** 0/1/25/26/100/1,000 campaigns, large permitted configs, identical timestamps, archive/filter switch, concurrent edits, all records reachable without duplication under documented cursor semantics, contacts privacy, CSV quoting/formula neutralization and truncation visibility.

### U02 — aggregate/status work

First remove large payload/list reads and fix retention. Capture `rows_read` and query plans for `/api/status`, `/api/dashboard`, `/api/campaigns/stats` and `/api/automation` at realistic history sizes. Returned aggregate rows may be small while SQL scans are large.

Where measured necessary, maintain daily per-campaign event counters using the existing idempotent analytics finalization transaction. An outcome retried after confirmation must not increment a counter twice. Backfill from existing events by bounded day/campaign ranges, mark a known completed backfill boundary and avoid mixing approximate/live totals accidentally.

Use indexed existence/oldest-age probes for operational health before adding many hot exact counters. If cached status is used, report `computed_at` and staleness; short-lived display caches never authorize sending or hide active holds. Retention must adjust/recompute any metric whose public meaning is “currently retained rows,” while lifetime counts must be explicitly named as lifetime.

Do not create summary tables for every count by default. Their extra writes and transactional coupling are justified only when the baseline exceeds the accepted read/CPU budget.

**Tests:** event replay, owner/postback finalization, deletion/retention, day boundaries/time units, failed backfill restart, cached stale counts, live holds despite stale display data, comparison with source aggregates at a fixed boundary.

### U03 — bounded configuration and bulk APIs

Use one bounded body helper for owner JSON requests with route-specific ceilings. Prototype: 32 KiB per campaign save, 64 KiB per atomic config import, 4 KiB for simple control actions. These are proposed application caps; inventory existing saved data and actual provider copy limits before finalizing them.

Add maximum lengths/counts for IDs, names, keywords, exclusions, reply variants, copy fields and reward values. A candidate starting point is 20 keywords, 20 exclusions, 10 reply variants and explicit copy byte caps. Preserve all existing configurations in read mode; oversized legacy configurations need visible compatibility handling, not silent invalidation of active automations.

Inventory the current active configurations before enforcing new bounds. If a legacy configuration exceeds the measured work envelope, prepare an equivalent staged/compiled representation without truncating its business rules, or leave that reader transition unpromoted. A migration that simply stops an existing campaign is not accepted as a performance fix.

Compute imports from real statement cost including guard and task/intents, reserved failure budget and body size. Validate every campaign/folder/conflict before any mutation. Oversized import rejects atomically with an accurate limit derived from actual generated work, not the current potentially stale “10 keyword or 6 Any” message. Preserve one-active-campaign-per-post and distinct-button-label policies.

Folder moves remain capped and transactional with `json_each`. Bound exported config results too; large exports use pagination/chunks rather than unbounded full-account JSON.

**Tests:** byte versus character limits with Unicode, large keyword arrays, huge copy, duplicate campaign/media IDs, invalid folder, malformed root types, over-budget import with zero partial writes, legacy large active campaign preserved, D1 parameter/statement bounds.

### U04 — reset and campaign deletion at large history sizes

The initial Access-only rollout retains existing reset semantics once fresh authorization is proven. Redesigning its data deletion is a later distinct change.

For large-account reset, separate immediate logical disconnect from physical purge:

1. In one small transaction consume the fresh action grant, increment the connection generation, disable sending, invalidate provider auth, and create a reset job.
2. All workers reject the old generation. Private Instagram-dependent APIs and reconnect are gated while the reset remains incomplete, so old data cannot be presented as new-account data.
3. Delete old data in dependency-safe, bounded table/key ranges. Track a durable reset cursor and retain owner account/session records.
4. Return HTTP 202 with `disconnected=true`, `deleted=false`, and a reset status identifier. The UI shows deletion progress and retries status safely. Only report `deleted=true` once the purge is verified complete.
5. Block reconnect until cleanup finishes unless every affected table has explicit generation ownership and all read/delete predicates prove isolation. The simpler initial design blocks reconnect; it avoids adding generation columns to every campaign/folder/analytics table merely for this operation.

A retry of the same reset cannot increment generation twice or purge newly connected data. A crashed cleanup resumes from its committed cursor. If daily D1 writes are exhausted, show paused cleanup; do not falsely report deletion success or reconnect while unscoped old rows remain.

Campaign deletion can similarly cancel/archive visibility immediately and purge optional history incrementally if measured bulk deletion is too expensive. Preserve dispatched suppression/issued-label evidence and new-instance behavior on recreation.

**Tests:** accepted-reset response lost, status polling, crash in every deletion group, old queued tasks, in-flight accepted send, owner-session survival, reconnect during purge, quota exhaustion, same campaign ID recreation, no exposure/deletion of a new generation's data. Preserve the UI's current uncertain-outcome handling with the new 202/status contract.

## 13. O01–O02: production proof and resource controls

### O01 — telemetry without another hot write path

Record safe phase-level counts: CPU from platform metrics, statement/binding/provider counts, event/byte counts, retry/deferral reason, current build, source generation and oldest due-work age. Do not record tokens, passwords, cookies, access assertions, full request URLs or message contents.

Use platform metrics/log sampling for normal successes and bounded error logs. Do not add a D1 write for every performance measurement. Task/source rows already contain timestamps and failure state for diagnostics. Roll up optional quota estimates periodically, not on every statement.

Use authoritative account-level Cloudflare metrics to assess remaining Workers/Queue/D1 capacity. Local estimates do not know other Workers' usage and cannot guarantee the shared account allowance is available.

Proposed control thresholds, to tune from the measured envelope:

| Condition | Action |
| --- | --- |
| p99 phase CPU >7 ms, or any recurring >=10 ms | Reduce measured unit size / profile; prevent promotion |
| Queue or D1 daily forecast >70% | Surface warning; reduce optional cold reconciliation and avoid duplicate notifications |
| Forecast >85% | Reserve work for already accepted funnels, recovery and due sends; defer new optional cold discovery |
| Actual service quota exhausted | Fail durable persistence requests without success acknowledgement; stop spinning/republication; resume only when available |
| Oldest fresh workflow exceeds target | Show actionable backlog reason, not generic “healthy” |
| Uncertain sends / repeated deterministic task failures | Preserve existing holds and expose operator review; never bulk replay |
| Database approaching a planned storage reserve | Run eligible cleanup/compaction; stop promising unlimited history |

A policy that rejects/defer new inbound work must reflect provider retry limits: Free cannot promise lossless unlimited intake after D1 becomes unavailable. State this capacity boundary in deployment docs. Never return 200 for data that exists only in memory.

Queue/D1 operations saved by dedup and adaptive polling must be measured. Do not assume a second Queue provides separate daily free quotas. Maintain enough reserve for cleanup/notifications so optional polling cannot consume all recovery capacity.

### O02 — remove drift and low-value overhead

- Inspect both `attempts_account(dispatched_at)` and `idx_send_attempts_dispatched_at(dispatched_at)` on the actual migrated schema. Drop one equivalent index in a reviewed migration after query-plan comparison; do not drop an index based on its name alone.
- Remove the unused compatibility `SendQueue` allocation from production runtime only after all call sites/tests demonstrate the durable dispatcher owns pacing/retries. Avoid bundling two mental models of the sender.
- Hoist stable small route sets/encoders where profiling supports it; these are secondary improvements, not the primary CPU strategy.
- Keep static UI delivery. React/Radix dependencies are browser assets and should not be blamed for backend automation CPU without a changed Worker bundle graph.
- Update `docs/authentication.md`, `docs/reliability.md`, README deployment instructions, timestamp comments and benchmark claims after each implemented phase. Keep historical measurements labeled by algorithm/version.
- Replace tests that assert obsolete `MODE=polling` defaults with explicit supported-installation policy tests. Cover both a webhook-confirmed deployment and setup without a working Meta callback; do not merely delete the two failing assertions.
- Convert investigation probes into corrected behavior assertions as fixes land. Preserve the original evidence snapshot as historical evidence rather than rewriting it to look like a successful new benchmark.

**Done when:** docs match deployed architecture and defaults, every failure/backlog has a visible reason, telemetry itself stays within the phase budget, and bundle/dependency changes show no unexpected server-side UI imports.

## 14. M01: schema changes and safe rollout

### Additive migration inventory

Never edit an already-applied migration. Reserve the next available migration numbers at implementation time; the names below describe responsibilities, not committed SQL files.

| Migration responsibility | Required changes | Compatibility / backfill |
| --- | --- | --- |
| Durable tasks | `work_tasks`, minimal due/lease/publication indexes | Old engine ignores it; new consumers remain disabled until intents are seeded |
| Raw input/page staging | `ingress_batches` and page/checkpoint linkage | Keep existing inbox/outbox rows and IDs; existing webhooks can retain old ingestion until cutover |
| Checkpoint ownership/kinds | Explicit kind/object, lease owner/revision, pending-page and cycle observation fields | New fields nullable/defaulted; preserve old cursor/boundary until safe migration |
| Provider-ID / label read models | Bounded provider-ID lookup fields/index; compact issued-label evidence | Backfill small pages; dual-read equivalent old snapshots until verified complete |
| Fresh owner action grants | Hash of one-time grant, owner/session/generation/action/expiry and consumption state | Not needed for ordinary Access login; add only with fresh destructive-action implementation |
| Reset progress | Reset task/job state and cleanup cursor | Keep old atomic reset path until the 202/UI contract is implemented and tested |
| Conditional read summaries/index changes | Campaign summary/detail support, optional daily aggregates, duplicate-index removal | Add only for accepted measured costs; compare source/read-model results during backfill |

The initial Access-only change should require **no automation-schema migration**. Adding identity metadata must preserve the owner account and all automation rows; use configuration and the existing owner session model wherever sufficient.

New indexes must be justified by exact selectors and write cost. A due-task predicate over revision/lease/publication may need a maintained readiness field or partial index; do not assume one broad composite index efficiently covers every `OR`. Prove plans against both idle and large-backlog fixtures before finalizing DDL.

### Migration mechanics

1. Record the actual deployed revision, bindings, triggers, auth mode, D1 migrations and account quotas. The previous email's 1,000+ failures are account-wide; attribute them by Worker/version/handler.
2. Preserve current deployment configuration independently from the repository's uncommitted changes. A source-tree value is not proof of the deployed value.
3. Take an approved D1 backup/snapshot and record relevant durable-state counts/IDs. A backup is for disaster recovery; routinely restoring it after external sends can revive old actions.
4. Apply only the additive schema required for the next phase. Large backfills and cleanup happen as resumable tasks, not one deploy-time transaction that consumes the day's write quota.
5. Deploy code that can read old and new compatible rows with consumers/send behavior still controlled.
6. Backfill/seed intents for existing **pending** inbox events, due jobs and checkpoints. Skip terminal/unknown jobs as runnable sends. Reuse stable job/event IDs and add deterministic task IDs.
7. Audit completeness with bounded range checks and aggregate counts. Do not assume a successful deploy means every old pending row has a task.
8. Transfer one responsibility at a time from old global drain to tasks, and maintain a deployment scheduler epoch so an old build cannot continue as an authorized sender after the ownership handoff.

The scheduler epoch is separate from the Instagram connection generation. **Do not increment connection generation merely to deploy a new scheduler**; that would invalidate ongoing account work. During cutover, the send-authorization transaction checks the active scheduler version/epoch as well as the existing connection/campaign/conversation conditions. A single durable control value is sufficient; avoid many per-feature rollout flags.

### Live scheduler cutover and unavoidable in-flight work

Before switching send ownership, stop authorizing new attempts briefly and wait for the old build's bounded in-flight request horizon to pass. Keep webhook persistence active. Jobs already `sending` are not reset to pending; reconcile their final/unknown status through the existing rules.

Switch the scheduler epoch and enable the new consumer authorization atomically. Disable old cron/global/manual drains from authorizing further sends. Verify a known pending task advances and no terminal job replays. Resume sending after the preservation checks.

This brief controlled sender handoff is distinct from the Access-only rollout, which does not need to pause campaigns. A zero-pause auth change does not imply an uncoordinated sender migration is safe.

### Rollback contracts

| Failure during rollout | Safe response |
| --- | --- |
| Access config/policy blocks owner UI | Restore prior owner auth mode/policy; keep Meta public routes and automation state intact |
| Access private API gate fails closed | Roll back auth-only code/config; do not reconnect Instagram or reset owner credentials |
| Consumer code fails before external request | Stop consumers/authorization, retain D1 task/source state, deploy a compatible fix |
| Consumer may have sent but finalization failed | Preserve sending/unknown and review; never reset attempts to zero or replay all tasks |
| Queue unavailable or exhausted | Persist intents where D1 permits, surface backlog, use bounded recovery on availability; do not inline the whole engine |
| New schema/index/read model faulty | Roll back to a compatible reader; keep additive data; do not run destructive down migrations during delivery |
| Old/new scheduler overlap | Pause authorizations, audit epoch/job owner tokens and uncertain outcomes before resuming |
| D1 restore needed after external effects | Enter maintenance and reconcile effects/ledgers first; no routine stale snapshot restore |

Keep a compatible stable build and the schema-independent maintenance bridge available. Reverting to an old sender that ignores new ownership fences is not a safe rollback.

## 15. Implementation sequence and reviewable delivery slices

These are cohesive change sets, not a demand to ship everything in one large PR. Do not claim an intermediate slice alone solves all Free-tier failures.

| Slice | Scope / work IDs | Dependencies | Deliverable and stop condition |
| --- | --- | --- | --- |
| 0. Baseline | O01, A02 fixture preparation | None | Route/trigger/version incident baseline; durable preservation fixture; supported input inventory |
| 1. Reversible owner auth | A01–A02 | Slice 0 | Access pilot + password rollback, private-route tests, signed-webhook/cron continuity proof; automation schema untouched |
| 2. Budget correctness | B01–B03, C01 phase evidence | Slice 0; can be reviewed independently of auth | Finite shared context and completion reservation; every sender boundary case prevents avoidable uncertainty |
| 3. Retention repair | R01, minimal O02 docs | Slice 2 accounting | Correct-unit deletes and resumable old-data cleanup; suppression proof; no bulk destructive cleanup hidden in deploy |
| 4. Task lifecycle | T02–T03, minimal M01 | Slice 2 | Durable intents, two Queue bindings, lease/revision crash tests; sending remains controlled |
| 5. Bounded ingress | I01–I02, T01 ingestion | Slice 4 | Verify/persist-only webhook; staged normalization; source equivalence and max-size CPU proof |
| 6. Plan/send separation | T01, E01–E03, C01, R02 initial evidence | Slices 4–5 | One event/task and one identified send/task; unchanged funnel outcomes; scheduler cutover proof |
| 7. Polling and recovery | P01, P03, bounded cleanup/token refresh | Slice 6 | Fair task/page scheduling; minute watchdog; no pre/post global drain; measurable coverage |
| 8. Historical work | E02/E04 refinement, P02, R02 compaction | Slices 6–7 and query/contract evidence | Fast token route, equivalent typed-label ownership, safe dedup/watermarks; no event loss |
| 9. Owner API scale | U01–U03, U02 only when measured | Budget context; summary schema where justified | UI/API pagination and body/config bounds; source metrics remain correct |
| 10. Data lifecycle | U04, fresh-action completion if deferred | Access fresh-auth proof, tasks/cleanup | Explicit 202/reset progress, generation fence, reconnect isolation and resumable purge |
| 11. Qualification and cleanup | O01–O02, M01, V01 | All required prior slices | All tests green, measured Free envelope accepted, rollback/soak proof and accurate documentation |

Do not ship slice 1 with a variable that accidentally changes reconciliation `MODE`, cron triggers or provider configuration. Do not ship slice 6 without a reliable continuation owner already working. Do not ship list API changes without their frontend consumers.

### Planned file ownership

| Existing area | Intended change |
| --- | --- |
| `src/index.ts` | Narrow public/private routing; owner facade; queue export; bounded scheduler; remove global drains from production entry points |
| `src/types.ts` | Auth-mode/Queue binding/task result/context contracts |
| `src/runtime.ts` | Phase-specific setup; explicit budgets; no unused queue allocation; no sender setup for ingress-only work |
| `src/reliability/budget.ts`, `src/connection.ts` | Finite context, completion pools, truthful error handling and guard accounting |
| `src/engine/engine.ts` | Small public execution seams; preserve existing planning/finalization predicates; split internals only as lifecycle requires |
| `src/engine/match.ts`, `transitions.ts` | Preserve semantics; expose reusable normalized-label helper and bounded matching inputs |
| `src/poller/*` | Independent page tasks; owned checkpoints; staged normalization; accurate coverage |
| `src/api/client.ts`, `src/auth/oauth.ts`, `refresh.ts` | Transport phase evidence; time/response bounds; guarded reads/effects |
| `src/auth/session.ts`, `disconnect.ts`, `src/routes/auth.ts` | Reversible managed owner facade, session preservation, fresh action grant/reset behavior |
| `src/routes/api.ts`, `config.ts`, `folders.ts`, `src/db.ts` | Pagination/detail/read models, input/config bounds, bounded lifecycle work |
| `src/reliability/status.ts` | Phase/backlog/coverage/quota explanations; bounded review lists |
| `frontend/src/App.tsx`, settings, builder/pages, hooks/types | Mode-aware login/settings, cursor lists, full config fetch, managed-action/reset progress |
| `schema/` | Additive reviewed migrations and bounded backfill contracts |
| `wrangler.toml` | Explicit auth configuration; Queue bindings; small watchdog and documented cadence |
| `test/`, `scripts/` | Focused regression, failure injection, disposable runtime and workload probes; no live recipients in automated local runs |
| `docs/`, README | Supported limits, runtime/account behavior, authentication rollback, migration/recovery runbooks |

New production modules should follow responsibilities: `src/auth/owner.ts`, `src/auth/access.ts`, a small `src/tasks/` area and a raw-ingress/maintenance helper where needed. These are planned paths; no empty scaffolding is required merely to match this table.

## 16. V01: test plan and acceptance evidence

### Regression and targeted defect tests

| Test group | Minimum meaningful cases | Failure it prevents |
| --- | --- | --- |
| Auth-mode isolation | Both modes, wrong owner/issuer/audience/signature, missing config, alternate hostname | Access bypass, owner lockout and public-route interference |
| Campaign continuity | Every active funnel state, pending/retry/sending/unknown jobs, existing cursors, same DB through both auth modes | Resets, duplicate openings, lost in-progress replies |
| Shared budget | Wrappers/batches/guards/errors/reservations at every boundary | `Infinity`, double charging, accidental reserve spending |
| Dispatch phase/finalization | Preflight failure, accepted send/body timeout, ack then D1 failure, repeated consumer | False never-sent claims and duplicate sends |
| Timestamp/retention | Seconds/ms, boundary equality, old completed versus active/uncertain rows | Non-working cleanup or destructive over-cleanup |
| D1/Queue gaps | Crash before/after commit, before/after publish, before/after publish marker, duplicate notification | Lost accepted work and publication storms |
| Task fencing | Stale lease, new revision while active, stale publisher, old scheduler/connection epoch | Old workers clearing/replaying newer work |
| Normalization | Mixed event types, receipts/echoes, incomplete repairs, same provider ID in multiple sources, large event | Loss, invalid input loops and dedup regression |
| Comment plan | Match/exclude/Any/resume/legacy/public reply/missing timestamp | Old-comment triggers and extra provider actions |
| Message ownership | Exact token, old/ambiguous Unicode labels, email across candidates, pending previous job | Wrong campaign advances or lost intended multi-target behavior |
| Pacing/retries | Concurrent authorization, hourly/account/recipient edges, Retry-After, expired windows | Rate breaches, hot loops and expired sends |
| Polling | Many objects, failed object, full pages, cursor reset, stored page crash, late visibility | Starvation, lost pages and unsafe watermark advance |
| Read models/APIs | Cursor ties/filters/edits, large configs/history, exact summary comparison | Hidden campaigns, memory growth and wrong analytics |
| Reset/deletion | Duplicate reset, partial purge, lost response, reconnect attempted, quota stop | New data erased or falsely reported deletion |
| Quota/backlog | Queue/D1 outage/exhaustion, recovery without traffic, workload above declared envelope | Silent drops, unbounded retry spending, misleading health |

Existing tests are regression assets. The previous baseline had 304 passing and two scheduling-policy failures; resolve those intentionally with the new contract. A final release requires all applicable tests green, not “304 is close enough.”

### Disposable runtime verification

Extend [audit-cpu-operations.mjs](../scripts/audit-cpu-operations.mjs) into a phase-aware operation census. Keep the original results as a baseline. Instrument real workerd/D1 source code with mocked provider responses and Queue failures.

Report per phase: ordinary/worst-path statements, guards, binding calls, provider attempts, rows read/written, raw/returned bytes, durable before/after state and continuation ownership. Use the corrected retained-state assertions; the old bug-demonstration probes should no longer expect broken behavior after their respective fixes.

Build a seeded high-cardinality fixture with many campaigns, historical labels, completed rows and pending recipients. Keep payload/config size and row distributions explicit. “1,000 rows” without their content sizes is insufficient evidence.

Local runtime tests establish semantics and work counts. They do not establish Cloudflare billed CPU. Do not release based only on elapsed local test time or a non-enforcing Miniflare success.

### Deployed Free-tier measurement

Use a separate installation, fixture data and a dedicated test Instagram recipient for live provider contracts. Verify plan/bindings/Queue consumers/Access path policy and deploy source maps for attribution where supported. Production customer campaign data is not a load-test fixture.

For each phase and owner endpoint, collect CPU p50/p95/p99/max, error outcomes and request count across:

- Warm runs and first requests after fresh deployment/isolate startup.
- All supported payload/event/config sizes, including the maximum declared envelope.
- Representative bursts and many historical conversations/campaigns.
- Successful sends, rejections, Retry-After, timeouts and database failures.
- Coincident recovery/cleanup/token-refresh activity.

Include enough observations to interpret p99; do not label the maximum of a handful of runs a statistically meaningful p99. Keep sample count/distribution and source revision with the evidence. Capture profiles for any recurring high phase instead of guessing from average response time.

Measure full account-day usage as well: Queue writes/reads/deletes, Worker invocation count, D1 read/write/storage use, provider attempts and oldest work age. Two small Queues share the same 10,000 daily operations; successful task splitting can still fail the daily quota test.

### Product latency contract

Adopt provisional targets for the staging workload, then confirm them with the owner:

| Behavior | Proposed target under the accepted envelope |
| --- | --- |
| Webhook acknowledgement | p95 <=2 s wall time, after durable persistence |
| First opening / next funnel action | p95 <=10 s when no configured/provider hold applies |
| Missing notification recovery | Discover/requeue within two minute-watchdog opportunities when service quotas permit |
| Poll continuation | Never abandoned; age reported; scheduled according to explicit class budget |
| Reconciliation coverage | Per-object maximum age derived from active-object count and page budget; no false fixed whole-account promise |
| Paused/uncertain/rate-held work | Correct reason and next/review action visible |

These are design goals, not claims about current performance or provider network guarantees. Provider latency and intentional rate holds are separately reported rather than counted as unexplained application delay.

### Final release checklist

- [ ] Access mode and password rollback have passed the same-database campaign-preservation tests.
- [ ] Meta verification/events and scheduled/Queue processing work with no owner login and receive no Access redirects.
- [ ] Existing active campaigns, conversations, job identities, generation and provider connection are preserved.
- [ ] Every production execution unit has explicit input/output/work limits and durable continuation ownership.
- [ ] The six-query sender budget defect and both retention-unit defects are fixed with regression proof.
- [ ] Unknown/sending outcomes cannot be automatically replayed by task or transport retry.
- [ ] Every page/normalization continuation survives process death at its transaction boundary.
- [ ] All applicable unit, type, integration and UI checks pass; migration/backfill checks are complete.
- [ ] Deployed Free phase p99 CPU <=7 ms under supported load; >=10-ms outliers investigated, recurring breaches eliminated.
- [ ] Zero `exceededCpu` outcomes during representative qualification and a 24-hour soak; continue monitoring after release.
- [ ] Queue/D1/Worker/storage/provider budgets include retries, nonmatches, maintenance, indexes and shared-account use.
- [ ] Backlog/coverage targets pass; no CPU “improvement” is accepted by silently deferring work for hours.
- [ ] A compatible rollback build/config exists, including scheduler-epoch and uncertain-send handling.
- [ ] Documentation states the actually verified capacity envelope, not a theoretical free allowance or an untested SQL-count estimate.

## 17. Expected effect and explicit limits

| Work item | Intended improvement | What it does not establish by itself |
| --- | --- | --- |
| Temporary Access mode | Removes expensive password work from owner login/change/reset paths where replaced | It does not reduce webhook/cron CPU or validate campaign continuity without tests |
| Explicit budgets/reserves | Predictable work stops, fewer avoidable uncertain sends | Forty/twelve statements do not prove 10-ms CPU |
| Verify/persist-only ingress | Removes planning/sending from burst acknowledgement | Large-body verification/storage still needs measurement |
| Small task invocations | Caps per-execution phase work; prompt durable continuations | Total CPU/Queue/D1 use may increase |
| Retention correction | Stops unintended growth of two ledgers | Suppression evidence cannot simply be deleted |
| Targeted message lookups | Keeps exact-token handling independent of recipient history | Typed ambiguity and multi-campaign email semantics still need equivalent handling |
| Adaptive page tasks | Prevents one poll type starving all other work | High object counts cannot all have arbitrarily frequent full scans on Free |
| Read pagination/config bounds | Bounds owner API payload/parse work | Existing large configurations require a compatible transition |
| Quota and age controls | Exposes capacity pressure and avoids optional retry/poll waste | Free service quotas cannot be engineered into unlimited capacity |

The first practical deliverable is the **isolated, reversible Access rollout with campaign-continuity proof**. The next is budget correctness. The full Free-tier claim belongs only to the final measured deployment, after staged automation processing, fair reconciliation, bounded owner operations and quota/backlog qualification are complete.
