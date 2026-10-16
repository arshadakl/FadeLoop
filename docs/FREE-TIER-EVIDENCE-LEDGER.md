# Remediation evidence ledger

Date: 16 October 2026. No production deployment, remote migration, queue creation or live Access configuration has been performed. This ledger distinguishes implementation from release evidence.

| Item | State | Evidence and remaining work |
| --- | --- | --- |
| F01 current baseline | Local harness implemented; deployed verification pending | Audit uses current 40-statement ceiling, tests repaired budget/retention behavior, hashes source/bundle/schema/dependencies and labels local measurements as non-production CPU. Inline work-ceiling result is retained as an explicit 503 probe. Task eligibility has a separate disposable workerd/D1 report. Broader phase CPU measurements and deployment manifest remain required. |
| F02 suspension | Implemented and locally verified | Additive `0013_task_eligibility.sql`; live publication/claim eligibility predicates; four-row metadata suspension/resume repair; no periodic Queue continuations for disabled/expired polls. Unit fixture simulates 24 hours and 100 objects. workerd/D1 exercises disabled/expired repair and bounded resume. |
| F02 capacity controls | Model implemented; enforcement/qualification pending | Queue accounting utility counts all stages, retries and shared account operations. Adaptive polling allocation, operational counters, D1/storage envelope and measured daily reconciliation are still outstanding. |
| F03–F12 | Planned / previously partial implementation | See the remediation plan. No new completion claim for routing, owner pagination, poison-event recovery, discovery coverage, large-input qualification, retention throughput, Access parity, scheduler cutover or deployed CPU. |

## Local commands

```powershell
npx vitest run
npm run typecheck
node scripts/test-worker-task-eligibility.mjs
node scripts/audit-cpu-operations.mjs
node scripts/verify-cpu-evidence.mjs
```

The audit writes `.wrangler/cpu-investigation/results.json`, the bundled fixture Worker and a full source identity manifest. The eligibility runtime writes `.wrangler/task-eligibility-runtime/results.json`. These ignored artifacts are reproducible local evidence; `docs/cpu-investigation-evidence.json` remains the original historical baseline. Do not rename either as production CPU measurements.

Verify evidence after the final code changes. The verifier rejects changed source or bundle hashes, including changes in benchmark scripts. A matching hash establishes identity, not 10 ms compliance. Generated timestamps and public fixture configuration are included; secrets and `.env` contents are not read.

## Capacity worksheet

Run `node scripts/free-tier-capacity.mjs workload.json` with daily counts, for example:

```json
{
  "messages": {
    "normalization": 100,
    "planning": 100,
    "dispatch": 400,
    "discovery": 10,
    "pollPages": 100,
    "maintenance": 60,
    "duplicateHints": 5
  },
  "retryReads": 20,
  "otherOperations": 10,
  "sharedAccountOperations": 500
}
```

This illustrative mix estimates 2,855 Queue operations. It does not establish D1/CPU/storage/provider capacity or a delivery entitlement. The tool always returns `qualifiedFreeTier: false`; qualification requires the complete measurement contract. Count every continuation and include retries/publication ambiguity rather than entering only successful outbound deliveries.

## Schema and rollback

`0013` adds nullable suspension metadata, preserving the existing status constraint, IDs, revision, lease ownership, cursor references and job data. Logical suspension is orthogonal to fault/lease status. No schema contraction or production cleanup is included.

Task-mode deployments must apply both task migrations before running eligibility-aware code. Inline execution remains configured and does not need the new task column for normal automation. An old task scheduler ignores suspension metadata, so do not roll back to an eligibility-unaware task scheduler while expecting suspension to hold. The full scheduler-epoch handoff remains a release blocker under F10.
