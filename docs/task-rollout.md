# Durable task execution: staging rollout

The task implementation is opt-in. The checked-in configuration keeps the inline path and password authentication. This is not yet a qualified under-10-ms release.

## Added execution contract

* Signed webhook bodies are bounded to 512 KiB, verified as exact bytes, and persisted with a deterministic generation-scoped digest. Task mode acknowledges after durable storage; it does not plan or send in that request.
* A normalization task reads at most ten fragments, normally bounded to 16 KiB total. One large event can still occupy the envelope ceiling and needs separate CPU qualification.
* Planning reuses the existing inbox/state machine; dispatch targets one existing outbound job. Exact button tokens fetch the addressed job before loading its matching conversation.
* Provider response bodies are bounded to 256 KiB. Poll tasks request ten records per page. A provider ignoring the requested record count still needs validation against the response ceiling.
* Task and send notifications contain only schema version, task ID and generation. D1 retains intent when Queue publication fails. Notification and execution leases have separate ownership; settlement checks the lease token and revision.
* One task runs per consumer invocation. Excess messages in an incorrectly configured batch are retried individually. Both consumers must use batch size one.
* Migration `0013_task_eligibility.sql` adds orthogonal suspension metadata. Publication and claim check current polling configuration, credentials and active post eligibility. A four-row watchdog repair records suspension/resume without resetting checkpoints or faults. Disabled/expired/inactive polling does not create recurring no-op Queue continuations. Task status accepts `status=suspended` and includes its reason.
* Repeated task failures become `blocked` after five failures, retaining their evidence. They require diagnosis; they are not silently discarded or replayed indefinitely.
* Owner-gated `GET /api/automation/tasks?status=blocked` returns at most 25 task records, with an ID cursor. `POST /api/automation/tasks/retry` accepts `{task_id, connection_generation}` and only requeues a blocked scheduling unit. Dispatch retry requires an already-runnable outbound job; it cannot reset `sending` or `unknown`. The watchdog publishes the committed retry. These operational endpoints are not yet exposed in the owner UI.
* Abandoned authorized sends become `unknown`, never runnable sends. Generation changes reject old work. Disconnect deletes the new task and raw tables in the same guarded reset transaction.
* Every-minute recovery repairs a bounded number of leases/intents and publishes at most two hints. Reconciliation keeps its configured cadence. Completed raw payloads are scrubbed in bounded batches; completed history expires after seven days. Pending/blocked work is retained.

## Resource configuration

Create two dedicated queues for this installation, then add the following top-level sections to your deployment config, using their real names. Do this in staging first. Do not reuse queues consumed by another Worker.

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
max_concurrency = 1

[[queues.consumers]]
queue = "fadeloop-send"
max_batch_size = 1
max_batch_timeout = 1
max_concurrency = 1
```

Set `EXECUTION_MODE="tasks"` inside `[vars]` only after applying the expand-only task migrations (`0012` and `0013`), verifying both bindings and completing the remaining release gates. Do not append this variable after a consumer table, where TOML would associate it with the wrong section. Keep the every-minute recovery cron and the daily refresh cron.

## Cutover and rollback gates

1. Save a compatible code/config rollback build and a database backup. Record active campaigns, conversation states, job IDs/statuses, connection generation and checkpoint cursors. Authentication rollout must already be independently verified.
2. Migrate the staging database first. Existing inline code ignores the new tables. Run representative existing funnels and durable task fixtures against that schema.
3. A scheduler epoch/fence for mixed deployed versions is still required before production cutover. Do not run old inline scheduling and new task scheduling concurrently merely because send IDs are deterministic.
4. Verify persisted-before-notified recovery, stale generation rejection, duplicate notification suppression, lost leases, uncertain sends, polling pagination, paused/archived campaigns, and reset rollback. Run these using real workerd/D1 as well as unit fixtures.
5. Measure each phase separately on Free, including cold starts/JWKS, large payloads, overlapping campaigns, long recipient history, backlogs and provider errors. Qualify p99 CPU <=7 ms and investigate every >=10-ms execution. Run a representative 24-hour soak with zero `exceededCpu`.
6. Count all Queue writes/reads/deletes/retries, Worker invocations, D1 reads/writes/storage, polls and shared account usage. A three-operation message is only a theoretical transport unit: one lead can create normalization, planning and multiple dispatch messages.
7. On rollback, stop new task publication/consumption with a verified handoff procedure, inspect authorized/unknown jobs, then enable inline scheduling. Keep the expand-only tables. Never reset an uncertain send to pending or wipe campaign state to resolve a handoff.

## Remaining release blockers

The full approved plan remains in progress: scheduler epoch/handoff proof; paginated owner list/detail APIs; bounded typed-label and multi-campaign planning; fair/adaptive polling at high object counts; backlog/quota UI and retry controls; target-platform CPU measurements and capacity qualification. Owner POST bodies now have streaming ceilings (32 KiB campaign save, 16 KiB other API actions, 64 KiB config import); reads/exports and legacy large configurations still require compatibility work. The existing CPU audit captures the old baseline and must be refreshed before claiming improvement.

No queues were created, no remote migrations were applied, and no deployment was performed by the local implementation.
