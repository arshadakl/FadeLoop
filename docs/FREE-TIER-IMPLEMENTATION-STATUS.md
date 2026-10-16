# Local implementation checkpoint — 16 October 2026

The approved plan is being implemented in the working tree. Production has not been changed. `AUTH_MODE=password` remains configured; `EXECUTION_MODE` is unset and therefore retains inline execution. No production data was used in the tests below.

The subsequent code review found additional release blockers. The [post-review remediation plan](FREE-TIER-REMEDIATION-PLAN.md) is the execution specification for addressing them; this checkpoint is not a completion claim.

## Implemented

* Reversible native-JWT Access owner authentication, preserving stored password credentials and existing campaign/connection state. Managed-mode password operations are gated. Fresh verification for destructive actions remains a production release gate.
* Finite shared query accounting through connection wrappers, a 40-statement invocation ceiling, and reserved dispatch finalization capacity. Preflight failure before `fetch` is distinguished from uncertain provider delivery.
* Correct millisecond retention cutoffs and bounded deletes. Live terminal conversation evidence is preserved. Task history cleanup preserves pending/blocked evidence and scrubs completed raw payloads.
* Expand-only durable task schema; persist-only task-mode ingress; sliced normalization; independent planning and targeted dispatch; small polling pages; revision/lease settlement; durable publication recovery and bounded watchdog repair.
* Generation-fenced reset of task/raw data in the existing disconnect transaction, including rollback on injected delete failure. The reset also works before task-schema expansion.
* Exact button tokens resolve their job first and restrict conversation loading to that campaign instance. Broad typed-message history handling remains outstanding.
* Streaming owner write limits and validation for null/array mutation bodies. Bounded provider response reads.
* Paginated owner task evidence and a generation-fenced blocked-task retry API that preserves uncertain-send evidence.

## Verification

* Full unit/regression suite, Worker and UI TypeScript checks, and production dry-run bundle are exercised locally. Latest machine-readable unit results are in the ignored `.wrangler/implementation-unit-results.json` artifact.
* workerd/D1 authentication integration passes password login/rotation, CSRF, OAuth/session ownership, transactional disconnect/rollback, campaign/folder operations and logout. Password hashing remains expensive; local wall time is not deployed CPU.
* workerd/D1 reliability integration passes duplicate bursts (501 duplicate events), HTTP failure/body-timeout uncertainty without replay, transaction rollback/503, expired-auth ingestion, and polling pages. Its 16 exercised invocations use at most 40 SQL statements. One polling continuation reaches the explicit budget stop; this is retained work, not proof of prompt backlog completion or <10 ms CPU.
* All 64 browser tests pass across mobile/desktop widths and light/dark themes, including builder edits, folder navigation, archive/restore/delete, contacts, settings, accessibility, and disconnect.
* Added tests continue existing funnels across Access login and exercise a 26-comment task burst, opening/follow/email/reward progression, duplicate transport, stale generations/leases/revisions, unavailable publication, task cleanup, reset atomicity and owner-write bounds.

## Outstanding before production enablement

The implementation is **not complete** and **under-10-ms CPU has not been proven**. Read [task rollout and remaining gates](task-rollout.md) and [Access rollout](access-rollout.md) before changing either mode. The approved [full plan](FREE-TIER-IMPLEMENTATION-PLAN.md) remains the acceptance contract. Existing list/export/history/fan-out paths, mixed-version scheduler handoff and quota/backlog qualification still need work. Keep new modes disabled until their gates pass.
