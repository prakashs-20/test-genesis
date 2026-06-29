# axira-dw-copy-orchestrator

Scheduled AWS Lambda that loads JSONL event files from S3 into the Redshift
`axira.event_log` table via the COPY command. Triggered every 5 minutes by
an EventBridge schedule rule defined in `infra/lib/redshift-stack.ts`.

## Algorithm (per tick)

1. Read `axira.dw_copy_log` → set of S3 keys already COPY'd successfully.
2. List recent S3 partitions (current hour + `DW_LOOKBACK_HOURS` back).
3. Set difference → files to COPY this tick.
4. For each event_type with new files: write a COPY MANIFEST to S3, then
   `COPY axira.event_log FROM '<manifest>' MANIFEST IAM_ROLE '...' ...`.
5. Record manifest rows (status='ok' or 'failed') back to `axira.dw_copy_log`.
6. Emit CloudWatch metrics.

See [§4.5 of the architecture doc](../../../docs/deliverables/genesis-capital/dw-architecture-and-extensibility.md)
for the full design discussion.

## Local testing

```bash
cd infra/lambda/copy-orchestrator
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Set env vars to match the dev workgroup
export DW_REDSHIFT_WORKGROUP=axira-dev-dw
export DW_REDSHIFT_DB=dev
export DW_S3_BUCKET=axira-dwh-archive-dev-000000000000
export DW_COPY_ROLE_ARN=arn:aws:iam::000000000000:role/axira-dev-redshift-copy
export AWS_REGION=us-east-1

# Invoke once locally (requires AWS credentials with permissions matching the
# CDK-provisioned role: redshift-data:ExecuteStatement, s3:ListBucket on the
# archive bucket, s3:PutObject for the _manifests prefix, cloudwatch:PutMetricData).
.venv/bin/python -c "from handler import handler; print(handler({'source':'aws.events'}, None))"
```

## Idempotency

The manifest table `axira.dw_copy_log` is the source of truth for "what's
been loaded." If the Lambda crashes mid-tick:

- **Before COPY**: nothing happened; next tick recomputes set difference, retries.
- **After COPY, before INSERT manifest**: rows are in `event_log` but the manifest
  doesn't know. Next tick treats those files as "new," COPYs them again — duplicate
  rows in `event_log` (detectable via unique `event_id`, dedup'd at query time).

This is **at-least-once delivery** by design. The COPY ↔ manifest race is rare,
and downstream queries handle dedup via `DISTINCT event_id` or window functions.

## Failure handling

- **COPY fails** (one partition): manifest gets `status='failed'`; the other
  event_types in the same tick continue to run; next tick retries the failed one.
- **Whole Lambda fails** (e.g., Redshift unreachable): no manifest rows written;
  next tick (5 min later) picks up where this one left off.
- **Truly broken files**: retry forever until a human marks them
  `status='abandoned'` via a manual UPDATE. A future enhancement could add a
  retry_count column and auto-abandon after N attempts.
