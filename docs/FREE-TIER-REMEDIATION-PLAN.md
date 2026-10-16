# Free-tier remediation plan after code review

Date: 16 October 2026. Status: implementation specification, not completed work or production authorization. Applies to the current local implementation and its nine review findings. No application code, remote resources or production settings are changed by this document.

This is the corrective execution plan for the [original approved plan](FREE-TIER-IMPLEMENTATION-PLAN.md). It takes precedence where it tightens acceptance or fixes shortcomings in the current implementation. Existing compatibility, provider-safety and campaign-preservation requirements still apply.

Implementation progress and reproducible local commands are tracked separately in the [evidence ledger](FREE-TIER-EVIDENCE-LEDGER.md). A locally verified slice is not a released or CPU-qualified deployment.

## 1. Verdict and completion contract

The 10 ms problem is **not solved**. Password authentication and inline execution remain configured. Task mode is incomplete, some operations still grow with history, and current tests do not measure deployed CPU. The old CPU evidence describes different source hashes.

Completion requires all three outcomes together:

1. The supported workload finishes correctly, preserves campaign progress and does not replay uncertain sends.
2. Every supported execution phase meets the measured Free CPU target, including owner operations, cron maintenance, cold authentication, error recovery and maximum supported inputs.
3. Queue, D1, storage and request use fit the shared Free allowances without hiding overload through hours of unexplained delay.

An average below 10 ms is insufficient. Release target: phase p99 CPU <=7 ms, no `exceededCpu` in a representative 24-hour soak, and investigation of every measured execution >=10 ms. This is a qualification target, not a guarantee against every future input or platform change. Publish the actual workload, sample count and remaining limits with the result.

Cloudflare documents 10 ms CPU for Free HTTP/cron invocations; network/database waits are separate from CPU. Check Queue consumer limits for the deployed account too; this project uses the same conservative per-unit CPU target rather than assuming transport grants extra compute. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Queue limits](https://developers.cloudflare.com/queues/platform/limits/).

## 2. Non-negotiable preservation rules

* Do not reconnect Instagram, recreate campaigns, change campaign instance IDs, clear conversation progress or reset generation to perform this migration.
* Keep inbox/outbox IDs, send-attempt evidence, deduplication and existing activation boundaries. Expand the schema before changing readers/writers.
* `sending` or `unknown` never becomes automatically retryable merely because a task lease expired, a transport retried or an operator retried scheduling.
* No full-table data rewrite or campaign resave on a hot request. Backfills are paginated, restartable and fenced.
* Do not shorten cryptographic password work to fit Free. Move the authentication responsibility to a verified managed flow.
* A CPU termination is not a catchable application yield. Commit continuation ownership before the invocation can disappear.
* Preserve typed-button ambiguity behavior, deleted-campaign button evidence and multi-campaign email semantics. Faster routing must not select a different campaign.
* No silent truncation of campaign lists, contact exports, provider pages, oversized events or legacy configurations.

## 3. Work register and order

| ID | Priority | Deliverable | Depends on | Exit proof |
| --- | --- | --- | --- | --- |
| F01 | First | Current baseline and trigger-level measurements | None | Versioned evidence matches source/build/config |
| F02 | P1 | No periodic Queue traffic for disabled work; quota model | F01 | Disabled/expired fixtures produce no continuing notifications |
| F03 | P1 | Bounded recipient routing and resumable planning | F01 | Work per unit independent of history size |
| F04 | P1 | Paginated summaries, detail reads and exports | F01 | All records accessible without unbounded Worker parse |
| F05 | P1 | Blocked-recipient recovery with explicit outcomes | F03 | Poison event cannot silently stall later work |
| F06 | P1 | Prompt, fair discovery separated from reconciliation | F02 | Coverage target passes for supported object count |
| F07 | P1 | Strict byte/shape ceilings and large-event handling | F01 | Largest accepted input passes CPU qualification |
| F08 | P1 | Maintenance throughput exceeds expiration rate | F02 | Expired backlog drains within resource allocation |
| F09 | P1 | Complete Access login and destructive confirmation | F01 | Real managed-auth flow and feature parity verified |
| F10 | P1 | Scheduler epoch, fenced transition and rollback | F02–F08 | Mixed-version/crash cutover tests pass |
| F11 | P1 | Backlog, coverage, quota and blocked-work UI | F02, F05, F06 | Owner can diagnose overload and recover safely |
| F12 | Release | Full regression, Free CPU/load/soak qualification | F03–F11 | All release gates pass; flags enabled deliberately |

F03/F04/F07/F09 may be developed independently, but production cutover remains sequential. Do not estimate completion by file count or test count. Each item closes only with its stated evidence.

## 4. F01 — rebuild evidence before optimizing further

Files: `scripts/audit-cpu-operations.mjs`, runtime test scripts, `docs/cpu-investigation-evidence.json`, deployment/config evidence manifest.

1. Keep the original investigation as a labeled baseline. Do not overwrite it with fabricated before/after numbers. Remove obsolete bug-demonstration assertions from the current audit and replace them with expected repaired behavior.
2. Generate a new evidence artifact containing source hashes, commit/working-tree patch identity, Worker bundle hash, schema version, variables excluding secrets, deployment version, fixture size and measurement date.
3. Separate HTTP routes, webhook ingestion, normalization, exact/typed/email planning, dispatch, poll discovery/pages, watchdog, retention, Access cold/warm verification and destructive operations.
4. Record outcome, actual platform CPU and wall time separately; local physical statements, D1 calls/rows, payload sizes, Queue operations, provider attempts and backlog age are additional dimensions.
5. Capture the reported production 42 ms by route/trigger/version where available. Do not infer its cause from the account-wide average. New measurement instrumentation must not write one D1 telemetry row per event or log credentials/message bodies.

Tests: evidence generated from a different bundle/config is rejected as release proof; every phase has samples or is explicitly marked unmeasured. Cold-path tests include fresh isolates/key caches. A local profile can identify hotspots but cannot certify Free CPU.

Exit: an executable baseline harness and a manifest that accurately distinguishes observed production data, local measurements and design targets. Do this before changing benchmark assertions to make failures disappear.

## 5. F02 — stop useless scheduling and enforce a capacity envelope

Files: `src/tasks/consumer.ts`, `store.ts`, `poll.ts`, `watchdog.ts`, runtime/config mutation hooks; additive task-state migration.

### Durable suspension

Add a non-runnable suspended state with a reason and eligibility revision. Polling disabled, expired credentials, deleted post and inactive/archived campaign are eligibility conditions, not every-minute execution failures. One transition records suspension; the watchdog must not republish it. Ordinary scheduled future work remains pending with a real due time.

Configuration/auth/campaign changes enqueue one bounded wake/discovery intent under the existing connection guard. A revision change while a task is leased must preserve the newer eligibility decision when the old lease settles. Prefer D1 source-of-truth configuration for runtime toggles; deployment-variable-only changes need a configuration fingerprint detected once by the watchdog and a paginated wake sweep. No sweep through every suspended task in one tick.

Distinguish suspension from blocked faults and intentionally paused sending. Pausing the sender need not stop webhook ingestion or necessary planning. Resume preserves cursors and pending work. Reconnection uses the real new connection generation; token refresh normally retains generation and wakes only eligible work.

### Daily capacity model

Queues Free includes 10,000 shared operations/day; ordinary small delivery generally costs a write, read and delete, and retries add operations. Both queues use the same allowance. [Queue pricing](https://developers.cloudflare.com/queues/platform/pricing/).

Use a versioned worksheet/harness with:

`queue_ops = 3 × (normalization + planning + dispatch + discovery + poll_pages + queued_maintenance) + extra_reads + duplicate_hints + failed_publication/recovery_overhead`

Count a continuation as another message. Do not equate a lead, provider message and Queue message. Measure the actual mix. Derive D1 rows read/written including indexes, Worker invocations and storage alongside Queue use. D1 Free currently includes 5 million rows read/day and 100,000 rows written/day; its query ceiling is separate from CPU. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Starting planning allocation, to be adjusted with evidence: 7,000 Queue operations for required ingestion/planning/dispatch, 1,500 for reconciliation/discovery, 1,500 for retry/recovery headroom. These are application allocations, not extra platform quotas or guaranteed capacity. Account for other applications sharing the account.

Quota pressure first suppresses optional repeated polls; accepted events retain durable continuation. Use a bounded repair scan when transport is unavailable, not an unbounded inline fallback. Show delayed coverage explicitly. A nonmatching event may still incur ingestion/normalization/planning cost.

Tests: simulate 24 hours with polling disabled, expired auth and 100 formerly active objects; after bounded suspension there is no recurring per-object notification. Resume wakes only eligible tasks. Simulate duplicate discovery, retries, competing publication and daily budget exhaustion. Reconcile predicted use against platform metrics; an estimated counter is not a billing oracle.

Exit: a published workload mix fitting the whole-account budget with headroom. The earlier 3,333/day figure is only a theoretical small Queue-message maximum; it is not an outbound delivery commitment.

## 6. F03 — make routing cost independent of recipient history

Files: `src/engine/engine.ts`, transitions/matching helpers, DB helpers; additive routing projection/backfill migration.

### Exact tokens and labels

Keep exact `FL1:` lookup by job ID, generation and recipient. Fetch only the addressed conversation/campaign snapshot. Validate token shape/length before DB lookup. Preserve unknown-send confirmation rules.

Replace parsing every historical `request_json` with an indexed issued-button projection written atomically with the dispatch evidence it represents. Store the exact current normalization of the button label, recipient, generation, campaign instance, action, job ID and provenance needed to reproduce ownership decisions. Include terminal/deleted campaign evidence required by existing semantics; do not index only active conversations.

For typed labels, query an index by recipient/generation/normalized label and retrieve at most two matches: zero, one and multiple are sufficient to detect ownership ambiguity. Preserve duplicate-label behavior, including labels issued by completed/deleted campaigns. For long legacy labels, apply a documented compatible lookup representation rather than silently truncating. If using a digest, compare the bounded normalized original to guard collisions.

Backfill historical issuance in small stable-ID pages. Track completeness per generation/recipient or range. During migration, an incomplete projection must defer to bounded legacy scanning with a persisted cursor, or retain inline mode until that population is complete. An incomplete projection must never be treated as proof of no match. Seed projection on postback confirmation of previously unknown sends too.

### Multi-campaign email and configuration

Read bounded candidate IDs with a stable `(created_at, campaign_id, instance_id)` ordering and a persisted planning cursor. Start with at most five candidate conversations per unit and cap decoded bytes as well as row count. Validate these provisional values on Free.

Each page transaction commits generated job intents, planning progress and ownership checks together. Do not mark the source event done until every semantically eligible candidate has been considered. Preserve the current behavior for a valid email applying across campaigns, single-action non-email replies, paused campaigns and pending transitions. Retries reuse the same deterministic job IDs.

Admission checks reserve enough physical statements for page settlement, continuation intent and lease completion before starting page work, extending the existing dispatch reservation pattern. All wrappers share the same finite allowance. Stop before starting a candidate that cannot be committed safely; do not rely on catching an exhausted budget after partial effects. Count returned bytes/candidates independently of statements. The current 40-statement ceiling remains an upper safety bound, not a target per task or a CPU conversion formula.

New writes receive field/count/byte bounds at validation. Legacy large configurations require a paginated migration or a deliberate compatibility mode; existing campaigns must not silently stop because new limits reject their stored configuration. Measure the migration path separately before enabling affected task processing.

Tests: exact, typed-label and email events against 1/100/10,000 historical jobs; duplicate and Unicode-equivalent labels; deleted campaigns; unfinished backfill; conflicting labels; crash after any candidate page; campaign edit/archive during execution; old job confirmation. Assert bounded returned/decoded bytes and correct campaign ownership, not just runtime on a tiny fixture.

Exit: no complete recipient history is loaded in Worker memory. Backfill/projection correctness and constant per-unit work are demonstrated.

## 7. F04 — bounded owner operations without missing records

Files: `src/routes/api.ts`, config/folder routes, `src/db.ts`, `frontend/src/App.tsx`, `pages.tsx`, API/resource hooks and browser-facing types.

1. Campaign lists return summaries only: ID, instance/revision, name, media, first display keyword/match mode, active/archive state, folder and update time. Start with 25 rows and an explicit response-byte ceiling. Do not parse every full campaign to build summaries; use a bounded stored projection or SQL extraction/backfill.
2. Add a detail endpoint by campaign ID. Editing fetches the full compatible configuration before constructing a draft. A list summary must never be saved as a full configuration. Preserve legacy editing and current distinct-label validation.
3. Use stable keyset pagination, initially `(updated_at DESC, campaign_id DESC)` with validated, versioned cursors. Document concurrent-update consistency; deduplicate accumulated IDs and refresh changes. Reset cursors on filter/folder changes.
4. The UI cancels stale detail/page requests, preserves dirty drafts on errors, and shows retry/load-more/end states. A late edit response cannot replace a newer draft or navigation. Search/filter must cover all matching records, using server-side filters where needed; filtering only the first loaded page is incorrect.
5. Paginate contacts, review jobs, folders and other variable-size results. Remove large OFFSET scans where keyset ordering is available. Bound status/aggregate work using indexes or maintained aggregates after profiling, with an idempotent reconciliation path.
6. Replace whole-dataset CSV/config export with paginated export reads assembled/downloaded in the browser, or a qualified asynchronous export. A streaming loop that reads every page inside one Worker invocation still accumulates CPU. Label snapshot semantics; never silently cap an export.
7. Preserve the bounded import/save changes, but add field limits and actionable errors. Stage large bulk changes as small resumable operations where their atomicity contract permits; do not silently turn an atomic replacement import into partial writes.

Tests: 0/25/26/1,000 records, equal timestamps, archive/restore during paging, Unicode/full-size configs, server search across later pages, late navigation responses, session expiry mid-export and resumable export. Compare exported IDs/counts, not just file existence.

Exit: every record remains reachable; list work does not parse full dataset configurations; large owner operations have separate invocations and accurate progress.

## 8. F05 — poison events and recipient ordering

Files: engine inbox claims, task store/consumer/status, owner review UI; additive inbox resolution/recipient-hold state as required.

Classify outcomes rather than using one generic failure counter:

| Outcome | Required handling |
| --- | --- |
| Work/byte/candidate allowance reached | Commit progress and yield; do not increment fault count |
| Temporary DB/provider-read failure before any send | Bounded exponential backoff and visible age/reason |
| Invalid or unsupported input | Explicit terminal rejection/quarantine with reason, no send |
| Ambiguous routing/uncertain send | Explicit recipient hold and owner review; never skip/replay automatically |
| Deterministic implementation failure | Block with sanitized diagnostic code and visible dependent-event count |

Keep ordering when it protects state. Do not simply remove the earlier-event predicate. Expose a recipient hold when an earlier event prevents later progress, rather than spending one Queue message per waiting event every minute. Dependency wakeup must be bounded and durable after the predecessor resolves.

Add owner actions: retry safe planning after repair; close/quarantine a confirmed non-actionable event with an audit reason; and resolve uncertain provider outcomes through the existing separate flow. Every action checks generation, event/task identity and expected revision inside the transaction. Closing an event does not reset any outbound attempt. Preserve evidence and wake a small next batch only after committed resolution.

Tests: fifth transient failure, permanent malformed input, work-budget yields across many pages, ambiguous label, older blocked event followed by tap/email, concurrent owner retry and active lease, stale generation and failed audit transaction. Verify later work either progresses safely or has a visible justified hold.

Exit: no silent indefinite recipient stall and no automatic bypass of uncertain state.

## 9. F06 — discovery, fairness and affordable coverage

Files: watchdog, poll tasks/checkpoints, campaign activation writes, auth/config wake paths.

Seed a post's polling intent atomically when it becomes active, rather than waiting for two-post discovery at the reconciliation interval. Existing installations use a separate bounded backfill cursor triggered immediately at cutover. Missing-intent repair still runs in small pages; it is not throttled by the provider reconciliation cadence.

Separate three operations: discovering objects, selecting due work and reading one provider page. Discovery creates missing intents without resetting already scheduled objects to immediate execution on every rediscovery. Give ingestion/dispatch priority, while reserving a measured minimum allowance for message and comment reconciliation so neither starves.

Hot objects poll at the configured cadence. Cold threads/posts back off adaptively within a published maximum coverage age. Inactive/deleted objects suspend. Provider failures retain individual cursors/backoff and do not block unrelated objects. Clear global poll error summaries when all applicable checkpoint errors recover; current task success must not leave stale UI failure evidence.

Do not advance historical boundaries on an assumed provider ordering guarantee. Verify provider semantics first; otherwise preserve conservative pagination and deduplication and account for its cost. Requesting ten records is not sufficient: validate/limit actual returned page shape and bytes, retaining provider continuation safely.

Provisional targets: all 100 existing active posts have durable scheduling intents within ten minutes under an uncongested migration; webhook-driven required tasks normally acquire a runnable slot within 60 seconds; optional reconciliation age is shown against the configured quota-compatible target. These are targets to test, not permission to promise every object a 15-minute full history scan. Provider attempt limits remain enforced.

Capacity check: 100 threads each polled once per 15 minutes require 9,600 poll executions/day, approximately 28,800 Queue operations before discovery, event processing or retries. That does not fit Free. Choose a measured adaptive coverage contract, a smaller supported active set or an explicitly different hosting allowance; never claim that pagination alone fixes daily capacity.

Tests: initial 100-post migration, activation/archive/restore, cold/hot thread mix, repeated discovery, broken cursor, provider 429, out-of-order pages, and sustained ingestion priority. Report object coverage and backlog percentiles, not only task throughput.

## 10. F07 — strict bytes and a usable large-event policy

Files: webhook/body helpers, task ingress/normalizer, provider parsing; fixture corpus and optional raw-event fragment schema.

Remove the first-fragment size exemption. Limits are UTF-8 bytes, nesting/shape complexity, record count and decoded output bytes; string `.length` is not a byte limit. Preserve HMAC validation over exact request bytes before accepting any event.

Start qualification with 16 KiB normalized fragment units and ten-record poll slices. Determine the maximum supported raw envelope from measured verification/persistence CPU; the current 512 KiB ceiling is not automatically acceptable. Avoid re-encoding/copying entire bodies repeatedly where exact bytes already exist.

For oversized individual events, recommended path: retain verified raw input durably, then use bounded D1-side structural extraction to retrieve only the provider fields used by normalization. Limit individual extracted fields using provider-valid semantics; ignore irrelevant metadata without parsing it into Worker memory. Do not truncate message text or identifiers in a way that changes matching. Missing required fields become an explicit quarantined event with a reason.

If extraction/verification of an allowed provider envelope still cannot qualify, this is a hard supported-input limit. Demonstrate that the provider's legitimate maximum fits, or provide a verified alternative ingestion service. Rejecting legitimate large webhooks forever with 413 is not successful preservation. Do not introduce a hand-written streaming JSON parser without exhaustive correctness tests and a demonstrated need.

Measure the current SQL `json_each`/OFFSET slicing as envelope size/cursor grows. D1 execution waits are separate from Worker CPU, but repeated full expansion can exhaust D1 read/latency budgets. Use a stable entry/part cursor or materialized bounded fragment index if the measured cost warrants it. Guard cursor advancement and fragment/task ownership in the same transaction.

Tests: a single maximum-sized event; many tiny events; four-byte Unicode; deeply nested irrelevant metadata; malformed nested types; oversized required fields; duplicate envelope; crash before/after fragment commit. Verify exact original signature bytes and no silent event loss.

## 11. F08 — maintenance that keeps up

Files: retention helpers, cron dispatcher/task scheduler, supporting timestamp/status indexes.

Give ordinary inbox/attempt/audit/event cleanup its own small execution unit, separate from token refresh. Rotate table/cursor selection and process a provisional 25–50 eligible rows per unit. Schedule only while a bounded preflight indicates eligible work; do not continually write empty deletes or automatically create a maintenance Queue message every minute per table.

Calculate needed batches from the measured expiration rate plus historical backlog. Example: 3,000 expiring rows/day at 50 rows/batch requires at least 60 batches/day for that table, not one nightly call. Set a measurable catch-up allocation above steady expiration, count index writes, and expose oldest-expired age. Maintenance must fit F02's Queue/D1 envelope and yield to required work without starving forever.

Separate payload retention from suppression/terminal ownership. Never prune live jobs, inbox dependencies, blocked evidence or button ownership needed for ambiguity checks. Retain compact suppression evidence for the supported replay horizon. Maintenance generation/lease guards must prevent a stale cleanup task from damaging a reconnected workspace.

Tests: sustained seven-/thirty-day synthetic arrivals, historical backlog, interrupted sweep, exact timestamp boundaries, active terminal conversations and late duplicate provider events. Verify storage stabilizes and cleanup throughput exceeds expiration under the supported load.

Exit: bounded invocation size AND sufficient daily throughput; neither alone passes.

## 12. F09 — finish Access without disabling reset

Files: Access verifier/owner facade, session/disconnect routes, frontend settings, managed identity configuration/runbook.

First perform a staging capability check: does the chosen managed identity flow provide verifiable recent authentication for this owner, with documented policy semantics and signed evidence the Worker can validate? Do not assume Cloudflare Access emits `auth_time`, and do not equate JWT issuance time with user reauthentication.

Recommended implementation when verified: a separate action application/path and explicit browser reauthentication, followed by a short-lived one-time action grant. Bind the grant to owner subject, current app session, connection generation, action and expiry. Store only a digest. A GET can show confirmation but cannot disconnect or mint an unconditional destructive grant. The final same-origin POST consumes the grant inside the guarded reset transaction. A fresh action assertion cannot authorize unrelated private routes.

The UI must explain permanent deletion, obtain final explicit confirmation, handle cancellation/expiry, and recover from an uncertain response without issuing another reset automatically. All existing workspace deletion/session-preservation behavior remains. Password change becomes managed-identity account management, with a working navigation/help path rather than a dead control.

If the Access policy cannot provide trustworthy freshness, select a managed identity provider with documented step-up evidence or provide a separately authenticated privileged action service. Record the decision and tested flow before implementing around an assumed claim. Password rollback remains available operationally, but requiring rollback for every reset does not pass feature-parity acceptance for the Free release.

Test real staging assertions, invalid issuer/audience/subject, replayed grant, switched browser session, cross-origin POST, expired/absent freshness, concurrent reset/reconnect and failed transaction. Snapshot campaigns/conversations/provider auth across login and rollback and continue the same leads. Public Meta routes must never receive Access redirects.

Exit: login and destructive-action features work on the intended managed configuration; cold/warm verification also meet CPU qualification. Do not enable production Access just because the JWT unit fixtures pass.

## 13. F10 — controlled activation and compatible rollback

Files: connection/runtime/entrypoint/task ownership, additive scheduler-control schema, deployment config and runbooks.

Introduce scheduler mode and monotonically increasing scheduler epoch in D1. This is separate from the Instagram connection generation. Changing scheduler mode must not invalidate campaign tokens or imply an Instagram reconnect.

Use a compatibility deployment first: both inline and task schedulers honor the epoch before claiming/planning/authorizing effects. Task claims carry the epoch; every relevant state mutation validates it. Previously deployed code that ignores this fence must be fully replaced before cutover. Tiny Queue notifications can remain hints, but a stale hint must not bypass current scheduler ownership.

Cutover sequence:

1. Backup and record invariants; apply additive migrations and deploy the epoch-aware compatibility build with current mode unchanged.
2. Complete/read-check routing and summary backfills. Create/configure both staging queues and verify one-message consumer batches and bindings.
3. Stop new old-mode claims through D1 control, let leases drain for the bounded provider deadline, then classify unresolved authorized attempts as unknown; never retry them as fresh sends.
4. Seed durable intents for existing unfinished work in stable small pages. Atomically switch scheduler epoch/mode. New mode must see preserved inbox/outbox IDs and generation.
5. Verify task execution and compare state snapshots before allowing general traffic/capacity ramp.

Rollback uses an epoch-aware build and reverse ownership handoff. Old Queue messages are acknowledged or deferred according to the documented fence, and D1 intent remains. Keep additive tables and existing hashes. Never solve rollback by wiping tasks, outbound jobs or connection data. `AUTH_MODE` and scheduler mode are separate changes so their effects can be isolated.

Tests: old/new invocations racing, stale notification after rollback, lease expiration during provider response, deployment interruption at every step, and abandoned authorized sends. Validate the exact target runtime/config; comments in Wrangler are not a migration mechanism.

## 14. F11 — visible service state

Owner UI shows bounded lists and maintained/qualified summaries for blocked tasks, recipient holds, oldest required backlog, overdue reconciliation objects, notification failures and maintenance lag. Distinguish healthy idle, intentionally suspended, provider backoff, quota pressure and implementation fault.

Expose safe retry/close actions from F05 with expected revision/generation and confirmation. Include related job status so an owner cannot mistake unknown delivery for unsent work. Use diagnostic codes with sanitized logs; never log access tokens, email bodies or raw webhook payloads merely to explain a failure.

Display Queue/D1 usage as measured or estimated explicitly, with observation window and shared-account caveat. If freshness/coverage targets cannot be met inside Free limits, show the constrained capacity instead of reporting healthy based only on the last successful poll timestamp.

## 15. F12 — qualification matrix and stopping conditions

| Dimension | Required cases |
| --- | --- |
| History | 1/100/10,000 historical jobs per recipient; 1,000 owner-list records; populated legacy schema |
| Funnels | Opening, public reply, typed/button follow, email retries, multi-campaign email, reward, duplicate lead |
| Input | Largest supported bytes, Unicode, many small records, malformed types, missing timestamps, nonmatching events |
| State | Active/stopped/archived/deleted campaigns, disabled polling, expired credentials, maintenance and recipient holds |
| Failure | DB commit failure, unavailable Queue, process death, stale lease/revision/epoch/generation, provider rejection/timeout/429 |
| Transition | Existing lead before auth switch, task cutover, migration restart and compatible rollback |
| Load | Realistic daily mix, largest supported burst, recovery backlog and 24-hour representative soak |

Run existing unit/type/build/workerd/browser gates plus targeted defect tests. Tests must assert final state, provider attempt counts, complete record access, per-unit size/work bounds and continuation ownership. A swallowed budget exception with an ever-growing backlog is a failure.

On the target Free staging deployment, record phase CPU p50/p95/p99/max, sample counts, cold/warm split, outcome, end-to-end latency excluding separately reported intentional provider holds, oldest backlog, object coverage and platform resource use. Identify the exact version and source manifest. CPU headroom and acceptable end-to-end latency are separate requirements.

The published capacity envelope must state active objects, hot/cold distribution, raw/nonmatching events/day, message/funnel mix, maximum body/field/config sizes, largest burst, retries, polling coverage, suppression horizon, expected provider holds and shared-account allocation. Do not recycle the earlier theoretical message allowance as measured capacity.

Release stops if any of these occur: recurring `exceededCpu`; required task cannot finish below 10 ms; Queue/D1 capacity cannot support the promised mix; backlog/coverage targets fail; feature parity fails; or campaign/send preservation fails. Reduce unit size when semantics allow. Otherwise narrow the published supported envelope or change the relevant service/plan explicitly. Never mark the issue fixed because the average improves.

## 16. Implementation slices and evidence ledger

| Slice | Scope | Evidence to attach |
| --- | --- | --- |
| 1 | F01 current baseline + F02 suspension | Current manifests, disabled/expired 24-hour operation model |
| 2 | F03 routing projection/backfill | Ownership equivalence, history scaling and crash recovery |
| 3 | F03 resumable planning + F05 recipient recovery | Page-yield correctness and poison-event recovery |
| 4 | F04 owner APIs/UI | Complete paging/export counts and stale-navigation browser tests |
| 5 | F07 ingestion/provider bounds | Maximum legitimate-input CPU and preservation evidence |
| 6 | F06 discovery/adaptive polls | 100-object seeding, fairness, coverage and quota model |
| 7 | F08 throughput + F11 owner health | Long-run retention stability and safe owner actions |
| 8 | F09 managed identity | Real freshness flow, feature parity, same-lead continuation |
| 9 | F10 scheduler compatibility/handoff | Mixed-version, in-flight send and rollback proof |
| 10 | F12 staging qualification and rollout | Matching build manifest, CPU/resource/latency data, 24-hour soak |

Keep each slice reviewable and update an evidence ledger with `planned / implemented / locally verified / staging verified / released`. Those statuses are distinct. Do not check the release boxes based solely on a local test run.

This plan creates no production promise beyond what is measured. The recommended path is to complete the existing durable architecture with bounded projections/pages, eligibility-aware scheduling and managed authentication, then qualify a finite Free workload. Adding more queues, weakening password security or increasing SQL-count limits is not a substitute.
