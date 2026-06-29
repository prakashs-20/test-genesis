#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Axira Platform -- LocalStack Resource Provisioning
#
# Creates SNS topics, SQS queues (with DLQs), subscriptions, and S3 buckets.
# Mounted at /etc/localstack/init/ready.d/init.sh - runs when LocalStack is ready.
# Idempotent: safe to re-run.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# AWS CLI (and therefore awslocal) defaults to us-east-1 regardless of
# LocalStack's DEFAULT_REGION env. Topics and queues created without an
# explicit --region therefore land in us-east-1. Export AWS_DEFAULT_REGION
# so every subsequent awslocal call uses the same region and ARN_PREFIX
# matches where resources actually live. Without this, subscribe calls
# silently bind to non-existent topics in a different region and publishes
# never reach subscribers.
export AWS_DEFAULT_REGION=us-east-1
REGION=us-east-1
ACCOUNT=000000000000
ARN_PREFIX="arn:aws:sns:${REGION}:${ACCOUNT}"
SQS_PREFIX="arn:aws:sqs:${REGION}:${ACCOUNT}"

echo "=== Axira LocalStack Init ==="

# ─── SNS Topics (per-domain) ────────────────────────────────────────────────
DOMAINS=(deal document agent mission approval loan knowledge evidence platform orchestration case compliance intake extraction investigation monitoring screening sar decision decisions rules webhook user-profile)

for domain in "${DOMAINS[@]}"; do
  awslocal sns create-topic --name "axira-events-${domain}" 2>/dev/null || true
  echo "[SNS] axira-events-${domain}"
done

# ─── SQS Queues + DLQs ──────────────────────────────────────────────────────
CONSUMERS=(projection-consumer projection-consumer-priority search-indexer notification-dispatcher compliance-monitor agui-streamer webhook-dispatcher workflow-trigger user-profile-cache-refresh)

for consumer in "${CONSUMERS[@]}"; do
  # Create DLQ first
  awslocal sqs create-queue --queue-name "${consumer}-dlq" 2>/dev/null || true

  # Create main queue with redrive policy pointing to DLQ
  DLQ_ARN="${SQS_PREFIX}:${consumer}-dlq"
  awslocal sqs create-queue \
    --queue-name "${consumer}" \
    --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"'"${DLQ_ARN}"'\",\"maxReceiveCount\":\"3\"}"}' \
    2>/dev/null || true

  echo "[SQS] ${consumer} (DLQ: ${consumer}-dlq, maxReceive: 3)"
done

# ─── Subscriptions (topic → queue) ──────────────────────────────────────────
# Subscription matrix - keep in sync with infra/lib/messaging-stack.ts
#   projection-consumer:          all except approval/mission (normal projections)
#   projection-consumer-priority: approval, mission (fast lane)
#   search-indexer:               deal, document, loan, knowledge, case
#   notification-dispatcher:      approval, mission, loan, case, monitoring
#   compliance-monitor:           deal, document, approval, loan, compliance, screening, sar, investigation
#   agui-streamer:                agent, mission, orchestration
#   webhook-dispatcher:           ALL topics (tenant-configurable)

subscribe() {
  local topic="$1"
  local queue="$2"
  awslocal sns subscribe \
    --topic-arn "${ARN_PREFIX}:${topic}" \
    --protocol sqs \
    --notification-endpoint "${SQS_PREFIX}:${queue}" \
    --attributes '{"RawMessageDelivery":"true"}' \
    2>/dev/null || true
  echo "  [SUB] ${topic} → ${queue}"
}

echo ""
echo "=== Subscriptions ==="

# projection-consumer (normal): all except approval/mission (those go to priority)
for t in deal document agent loan knowledge evidence platform orchestration case intake investigation monitoring; do
  subscribe "axira-events-${t}" "projection-consumer"
done

# projection-consumer-priority: approval, mission (fast lane)
subscribe "axira-events-approval" "projection-consumer-priority"
subscribe "axira-events-mission" "projection-consumer-priority"

# search-indexer: searchable entities
for t in deal document loan knowledge case; do
  subscribe "axira-events-${t}" "search-indexer"
done

# notification-dispatcher: user-facing notifications
for t in approval mission loan case monitoring; do
  subscribe "axira-events-${t}" "notification-dispatcher"
done

# compliance-monitor: regulatory compliance events
for t in deal document approval loan compliance screening sar investigation; do
  subscribe "axira-events-${t}" "compliance-monitor"
done

# agui-streamer: AG-UI real-time streaming
for t in agent mission orchestration; do
  subscribe "axira-events-${t}" "agui-streamer"
done

# workflow-trigger: event-driven workflow starts (deal readiness, approvals, etc.)
for t in deal mission approval orchestration; do
  subscribe "axira-events-${t}" "workflow-trigger"
done

# user-profile-cache-refresh: async profile cache refresh (Lane C)
subscribe "axira-events-user-profile" "user-profile-cache-refresh"

# webhook-dispatcher: ALL topics
for domain in "${DOMAINS[@]}"; do
  subscribe "axira-events-${domain}" "webhook-dispatcher"
done

# ─── Microsoft Teams notify (T2.1 of msteams-integration-build) ─────────────
# Dedicated topic + queue + DLQ for the workflow-engine → teams-bot fan-out.
# Subscription filters on `target_kind=teams` message attribute (matches CDK
# stack behavior). The apps/teams-bot SQS consumer long-polls this queue.
awslocal sns create-topic --name "axira-events-teams-notify" 2>/dev/null || true
echo "[SNS] axira-events-teams-notify"

awslocal sqs create-queue --queue-name "teams-notify-dlq" 2>/dev/null || true
TEAMS_NOTIFY_DLQ_ARN="${SQS_PREFIX}:teams-notify-dlq"
awslocal sqs create-queue \
  --queue-name "teams-notify" \
  --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"'"${TEAMS_NOTIFY_DLQ_ARN}"'\",\"maxReceiveCount\":\"5\"}","VisibilityTimeout":"120"}' \
  2>/dev/null || true
echo "[SQS] teams-notify (DLQ: teams-notify-dlq, maxReceive: 5)"

awslocal sns subscribe \
  --topic-arn "${ARN_PREFIX}:axira-events-teams-notify" \
  --protocol sqs \
  --notification-endpoint "${SQS_PREFIX}:teams-notify" \
  --attributes '{"RawMessageDelivery":"true","FilterPolicy":"{\"target_kind\":[\"teams\"]}","FilterPolicyScope":"MessageAttributes"}' \
  2>/dev/null || true
echo "  [SUB] axira-events-teams-notify → teams-notify (filter: target_kind=teams)"

# ─── Microsoft Teams tombstone (T7.1 of msteams-integration-build) ──────────
# DSR purge + fact deletion + legal hold events fan out here. The
# apps/teams-bot tombstone consumer long-polls the dedicated queue and
# walks card_dispatch_log for affected entities. No subscription filter —
# every message is a tombstone-relevant event; the consumer's Zod envelope
# schema dispatches on event_type.
awslocal sns create-topic --name "axira-events-teams-tombstone" 2>/dev/null || true
echo "[SNS] axira-events-teams-tombstone"

awslocal sqs create-queue --queue-name "teams-tombstone-dlq" 2>/dev/null || true
TEAMS_TOMBSTONE_DLQ_ARN="${SQS_PREFIX}:teams-tombstone-dlq"
awslocal sqs create-queue \
  --queue-name "teams-tombstone" \
  --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"'"${TEAMS_TOMBSTONE_DLQ_ARN}"'\",\"maxReceiveCount\":\"5\"}","VisibilityTimeout":"120"}' \
  2>/dev/null || true
echo "[SQS] teams-tombstone (DLQ: teams-tombstone-dlq, maxReceive: 5)"

awslocal sns subscribe \
  --topic-arn "${ARN_PREFIX}:axira-events-teams-tombstone" \
  --protocol sqs \
  --notification-endpoint "${SQS_PREFIX}:teams-tombstone" \
  --attributes '{"RawMessageDelivery":"true"}' \
  2>/dev/null || true
echo "  [SUB] axira-events-teams-tombstone → teams-tombstone"

# ─── S3 Buckets ─────────────────────────────────────────────────────────────
echo ""
echo "=== S3 Buckets ==="
BUCKETS=(axira-dev-documents axira-dev-artifacts axira-intake-staging)

CORS_CONFIG='{"CORSRules":[{"AllowedOrigins":["http://localhost:3000"],"AllowedMethods":["GET","PUT","POST","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]}'

for bucket in "${BUCKETS[@]}"; do
  awslocal s3 mb "s3://${bucket}" 2>/dev/null || true
  awslocal s3api put-bucket-cors --bucket "${bucket}" --cors-configuration "${CORS_CONFIG}" 2>/dev/null || true
  echo "[S3] ${bucket} (CORS enabled)"
done

echo ""
echo "=== Ops Plane Receiver resources ==="

# SNS topic for ops-plane-receiver fan-out (consumed by apps/ops-plane-receiver)
awslocal sns create-topic --name "axira-ops-fanout" 2>/dev/null || true
echo "[SNS] axira-ops-fanout"

# Secrets Manager secret holding the service token the receiver verifies
# on inbound calls. Dev value; rotate via awslocal in CI/staging.
awslocal secretsmanager describe-secret --secret-id "axira-ops-service-token" >/dev/null 2>&1 || \
  awslocal secretsmanager create-secret \
    --name "axira-ops-service-token" \
    --secret-string '{"token":"dev-local-ops-token"}' >/dev/null 2>&1 || true
echo "[SecretsManager] axira-ops-service-token"

echo ""
echo "=== Axira LocalStack Init Complete ==="
