#!/bin/bash
# Wait for all platform services to be healthy
set -euo pipefail

MAX_WAIT=120
INTERVAL=5
ELAPSED=0

echo "Waiting for platform services to be healthy..."

wait_for_service() {
  local name=$1
  local url=$2
  local elapsed=0

  while [ $elapsed -lt $MAX_WAIT ]; do
    if curl -sf "$url" > /dev/null 2>&1; then
      echo "  $name is healthy"
      return 0
    fi
    sleep $INTERVAL
    elapsed=$((elapsed + INTERVAL))
  done

  echo "  $name failed to become healthy after ${MAX_WAIT}s"
  return 1
}

wait_for_port() {
  local name=$1
  local host=$2
  local port=$3
  local elapsed=0

  while [ $elapsed -lt $MAX_WAIT ]; do
    if nc -z "$host" "$port" 2>/dev/null; then
      echo "  $name is ready on port $port"
      return 0
    fi
    sleep $INTERVAL
    elapsed=$((elapsed + INTERVAL))
  done

  echo "  $name failed to be ready on port $port after ${MAX_WAIT}s"
  return 1
}

# Core services
wait_for_port "PostgreSQL" localhost 5432
wait_for_port "Redis" localhost 6379
wait_for_service "OpenSearch" "http://localhost:9200/_cluster/health"

# Temporal (if running)
if docker ps --format '{{.Names}}' | grep -q axira-temporal-engine; then
  wait_for_port "Temporal gRPC" localhost 7233
  echo "  Temporal UI at http://localhost:8080"
fi

# LocalStack (if running)
if docker ps --format '{{.Names}}' | grep -q axira-localstack; then
  wait_for_service "LocalStack" "http://localhost:4566/_localstack/health"
fi

echo "All platform services are healthy."
