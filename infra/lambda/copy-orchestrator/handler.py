"""axira-dw-copy-orchestrator — scheduled Lambda that loads S3 JSONL into Redshift.

Fires every 5 minutes via an EventBridge schedule rule. On each tick:

  1. Query axira.dw_copy_log to find the set of S3 keys already COPY'd
     successfully per event_type partition (the "manifest").
  2. List recent S3 partitions (current + previous hour, every event_type
     prefix that has new files) via s3:ListObjectsV2.
  3. Compute the set difference: files in S3 minus files in manifest =
     files to load this tick.
  4. For each event_type with new files, write a COPY manifest object to S3
     and issue `COPY axira.event_log FROM '<manifest>' MANIFEST ...` via the
     Redshift Data API.
  5. Poll the statement to completion; record the result back into
     axira.dw_copy_log (status='ok' on success, 'failed' on error).
  6. Emit CloudWatch metrics: RowsLoaded, FilesLoaded, CopyDurationMs per
     event_type, plus orchestrator-level TickDurationMs.

The whole loop is **idempotent**: if the Lambda crashes mid-tick (before
inserting manifest rows), the next tick recomputes the same set difference,
retries the COPY, then inserts. Duplicate rows in axira.event_log are
detectable via the unique `event_id` and dedup'd at query time.

Architecture context: see
    docs/deliverables/genesis-capital/dw-architecture-and-extensibility.md §4.5

Env vars (set by CDK at deploy time):
    DW_REDSHIFT_WORKGROUP      — workgroup name (e.g. axira-dev-dw)
    DW_REDSHIFT_DB             — database name (e.g. dev)
    DW_REDSHIFT_SCHEMA         — schema name (default "axira")
    DW_S3_BUCKET               — archive bucket (e.g. axira-dwh-archive-dev-...)
    DW_S3_JSONPATHS_KEY        — JSONPaths file key (e.g. _meta/event-log-jsonpaths.v2.json)
    DW_COPY_ROLE_ARN           — IAM role Redshift assumes for S3 read
    DW_LOOKBACK_HOURS          — how many recent hours to scan per tick (default 2)
    DW_MAX_FILES_PER_COPY      — cap files per COPY (default 200; tune for big spikes)
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from typing import Any

import boto3
from botocore.config import Config as BotoConfig
from datetime import datetime, timedelta, timezone

from fact_dispatch import FactDispatch, lookup as fact_lookup

# ─── Configuration ─────────────────────────────────────────────────────────

REDSHIFT_WORKGROUP = os.environ["DW_REDSHIFT_WORKGROUP"]
REDSHIFT_DB = os.environ["DW_REDSHIFT_DB"]
REDSHIFT_SCHEMA = os.environ.get("DW_REDSHIFT_SCHEMA", "axira")
# Secrets Manager ARN holding the admin password — we authenticate as `awsuser`
# so the orchestrator has the same DB-level access the sidecar's psycopg
# connection had. Without this, Redshift would map the Lambda's IAM role to
# an auto-created DB user with no GRANTs on `axira` schema.
REDSHIFT_SECRET_ARN = os.environ["DW_REDSHIFT_SECRET_ARN"]
S3_BUCKET = os.environ["DW_S3_BUCKET"]
# Per-fact-table JSONPaths files live under _meta/fact-jsonpaths/ and are
# written on each tick from the dispatch map (see fact_dispatch.py + _run_copy).
COPY_ROLE_ARN = os.environ["DW_COPY_ROLE_ARN"]
LOOKBACK_HOURS = int(os.environ.get("DW_LOOKBACK_HOURS", "2"))
MAX_FILES_PER_COPY = int(os.environ.get("DW_MAX_FILES_PER_COPY", "200"))

# Boto clients — created at module import so warm-container invocations reuse
# them. AWS_REGION is set automatically inside Lambda.
_boto_config = BotoConfig(retries={"max_attempts": 5, "mode": "standard"})
s3 = boto3.client("s3", config=_boto_config)
redshift_data = boto3.client("redshift-data", config=_boto_config)
cloudwatch = boto3.client("cloudwatch", config=_boto_config)

logger = logging.getLogger()
logger.setLevel(logging.INFO)


# ─── Entry point ───────────────────────────────────────────────────────────


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """EventBridge calls this every 5 minutes.

    The `event` payload is the standard EventBridge "Scheduled Event"; we
    ignore its contents. The `context` provides the AWS request id we tag
    onto manifest rows for traceability.
    """
    tick_id = getattr(context, "aws_request_id", uuid.uuid4().hex)
    tick_start = time.monotonic()

    logger.info(
        "orchestrator.tick.started "
        f"tick_id={tick_id} "
        f"workgroup={REDSHIFT_WORKGROUP} "
        f"bucket={S3_BUCKET} "
        f"lookback_hours={LOOKBACK_HOURS}"
    )

    cursors = _load_manifest_cursors()
    partitions = _enumerate_recent_partitions(LOOKBACK_HOURS)

    total_files_loaded = 0
    total_rows_loaded = 0
    total_failures = 0

    # Sort iteration order so INSERT events (no merge_key) run before MERGE
    # events within the same tick. Otherwise, if both a `.started` and its
    # paired `.completed` event arrive in the same tick, lexicographic
    # ordering processes `.completed` first → MERGE finds no target row →
    # silent 0-row UPDATE → started.INSERT later creates the row but
    # completion data is gone. Sort key: (is_merge, event_type) — False
    # sorts before True so non-MERGE entries come first; ties broken by
    # event_type for determinism.
    def _sort_key(kv: tuple[str, list[str]]) -> tuple[bool, str]:
        d = fact_lookup(kv[0])
        return (d is not None and d.is_merge, kv[0])

    for event_type, prefixes in sorted(partitions.items(), key=_sort_key):
        copied = cursors.get(event_type, set())
        new_keys: list[str] = []
        for prefix in prefixes:
            for key in _list_keys(prefix):
                if key in copied:
                    continue
                if key.endswith(".jsonl"):
                    new_keys.append(key)

        if not new_keys:
            continue

        # Look up which fact table this event_type loads into. Unmapped
        # event_types are skipped (fail-soft) — they sit in S3 indefinitely
        # until either (a) their dispatch entry is added in fact_dispatch.py
        # or (b) an out-of-band tool processes them. We do NOT mark them
        # ok/failed in the manifest so we don't lock in a "wrong" state.
        dispatch = fact_lookup(event_type)
        if dispatch is None:
            logger.warning(
                "orchestrator.event_type.unmapped "
                f"event_type={event_type} "
                f"new_files={len(new_keys)} "
                "note=add to fact_dispatch.EVENT_TYPE_TO_FACT to enable load"
            )
            _emit_metric(
                "UnmappedEventTypes", 1, dimensions={"EventType": event_type}
            )
            continue

        # Cap files per COPY — protects Redshift from a single huge load when
        # we've been down for hours and S3 has piled up. The leftover files
        # get picked up next tick.
        batch = new_keys[:MAX_FILES_PER_COPY]
        deferred = len(new_keys) - len(batch)

        copy_start = time.monotonic()
        try:
            rows_loaded = _run_copy(event_type, dispatch, batch, tick_id)
            duration_ms = int((time.monotonic() - copy_start) * 1000)
            _record_manifest(event_type, batch, "ok", rows_loaded, duration_ms, tick_id)
            total_files_loaded += len(batch)
            total_rows_loaded += rows_loaded
            # Best-effort: move loaded files from the live prefix into
            # `_archive/…` so the next tick's LIST only sees unprocessed
            # files. Failures here MUST NOT fail the tick — dw_copy_log
            # already records the load (status='ok'), so the bounded
            # cursor check will skip these files even if they remain in
            # the live prefix.
            _archive_loaded_files(batch)
            logger.info(
                "orchestrator.copy.ok "
                f"event_type={event_type} "
                f"files={len(batch)} "
                f"rows={rows_loaded} "
                f"duration_ms={duration_ms} "
                f"deferred={deferred}"
            )
            _emit_metric(
                "RowsLoaded", rows_loaded, dimensions={"EventType": event_type}
            )
            _emit_metric(
                "FilesLoaded", len(batch), dimensions={"EventType": event_type}
            )
            _emit_metric(
                "CopyDurationMs",
                duration_ms,
                dimensions={"EventType": event_type},
                unit="Milliseconds",
            )
        except Exception as err:  # noqa: BLE001
            duration_ms = int((time.monotonic() - copy_start) * 1000)
            total_failures += 1
            _record_manifest(
                event_type,
                batch,
                "failed",
                None,
                duration_ms,
                tick_id,
                error=str(err)[:2000],
            )
            logger.error(
                "orchestrator.copy.failed "
                f"event_type={event_type} "
                f"files={len(batch)} "
                f"duration_ms={duration_ms} "
                f"error={err}"
            )
            _emit_metric(
                "CopyFailures", 1, dimensions={"EventType": event_type}
            )
            # Continue to the next event_type — one partition's failure must
            # not block the rest of the tick.

    tick_duration_ms = int((time.monotonic() - tick_start) * 1000)
    _emit_metric(
        "TickDurationMs", tick_duration_ms, unit="Milliseconds"
    )

    logger.info(
        "orchestrator.tick.completed "
        f"tick_id={tick_id} "
        f"files_loaded={total_files_loaded} "
        f"rows_loaded={total_rows_loaded} "
        f"failures={total_failures} "
        f"duration_ms={tick_duration_ms}"
    )

    return {
        "statusCode": 200,
        "tick_id": tick_id,
        "files_loaded": total_files_loaded,
        "rows_loaded": total_rows_loaded,
        "failures": total_failures,
        "duration_ms": tick_duration_ms,
    }


# ─── Manifest table I/O ────────────────────────────────────────────────────


def _load_manifest_cursors() -> dict[str, set[str]]:
    """Return {event_type: {already-COPY'd s3_key, ...}} from axira.dw_copy_log.

    Bounded to (LOOKBACK_HOURS + 1) hours: the LIST enumerates only files in
    the recent lookback window, so the dedup set only has to cover that
    window. An unbounded `WHERE status='ok'` would pull every loaded key
    ever written — at 10K events/day that exceeds Lambda's 256MB RAM, and
    at 100K events/day it never returns. The existing SORTKEY (copied_at)
    on dw_copy_log makes the bounded query a zone-map-pruned range scan.
    The +1h buffer absorbs clock skew between Redshift GETDATE() and S3
    LastModified.

    Only rows with status='ok' count as "loaded" — failed rows will retry.
    """
    bounded_hours = LOOKBACK_HOURS + 1
    sql = (
        f"SELECT event_type, s3_key FROM {REDSHIFT_SCHEMA}.dw_copy_log "
        f"WHERE status = 'ok' "
        f"AND copied_at > GETDATE() - INTERVAL '{bounded_hours} hours';"
    )
    rows = _run_query(sql)
    cursors: dict[str, set[str]] = {}
    for row in rows:
        # Redshift Data API returns rows as lists of {dataType: value} dicts.
        event_type = _cell(row[0])
        s3_key = _cell(row[1])
        if event_type is None or s3_key is None:
            continue
        cursors.setdefault(event_type, set()).add(s3_key)
    return cursors


def _record_manifest(
    event_type: str,
    keys: list[str],
    status: str,
    row_count: int | None,
    duration_ms: int,
    tick_id: str,
    error: str | None = None,
) -> None:
    """Insert one manifest row per S3 key. Idempotent via the (event_type, s3_key) PK
    — if a row already exists we INSERT with the same PK and Redshift rejects;
    we wrap each row in an explicit "delete-then-insert" only on retries.

    To keep things simple for v1: use MERGE-style INSERT … (no ON CONFLICT in
    Redshift, but the orchestrator's idempotency mostly handles re-runs by
    the set-difference logic that skips ok'd files. For failed→ok transitions
    we DELETE the failed row first.
    """
    if not keys:
        return

    if status == "ok":
        # Clear any prior 'failed' rows for these keys, then insert fresh.
        _run_statement(_build_delete_sql(event_type, keys))

    rows_sql = _build_insert_sql(
        event_type=event_type,
        keys=keys,
        status=status,
        row_count=row_count,
        duration_ms=duration_ms,
        tick_id=tick_id,
        error=error,
    )
    _run_statement(rows_sql)


def _build_delete_sql(event_type: str, keys: list[str]) -> str:
    in_list = ", ".join(_quote(k) for k in keys)
    return (
        f"DELETE FROM {REDSHIFT_SCHEMA}.dw_copy_log "
        f"WHERE event_type = {_quote(event_type)} "
        f"AND s3_key IN ({in_list});"
    )


def _build_insert_sql(
    event_type: str,
    keys: list[str],
    status: str,
    row_count: int | None,
    duration_ms: int,
    tick_id: str,
    error: str | None,
) -> str:
    # Redshift INSERT with VALUES — each row is one tuple.
    # Row-count is NULL for failures (we don't know how many rows would have loaded).
    row_count_per_file = (
        max(1, row_count // len(keys)) if (row_count and len(keys)) else None
    )
    rows = []
    for k in keys:
        rc = "NULL" if row_count_per_file is None else str(row_count_per_file)
        err = "NULL" if error is None else _quote(error)
        rows.append(
            f"({_quote(event_type)}, {_quote(k)}, GETDATE(), "
            f"{rc}, NULL, {duration_ms}, {_quote(status)}, {err}, "
            f"{_quote(tick_id)})"
        )
    return (
        f"INSERT INTO {REDSHIFT_SCHEMA}.dw_copy_log "
        "(event_type, s3_key, copied_at, row_count, bytes_loaded, "
        " copy_duration_ms, status, error_message, tick_id) "
        f"VALUES {', '.join(rows)};"
    )


# ─── S3 listing ────────────────────────────────────────────────────────────


def _enumerate_recent_partitions(lookback_hours: int) -> dict[str, list[str]]:
    """For each event_type prefix under the bucket root, return the list of
    hour-grain prefixes to list this tick (current hour + lookback_hours back).

    Output: {event_type: [prefix1, prefix2, ...]}
    """
    event_types = _list_event_type_prefixes()
    now = datetime.now(timezone.utc)
    out: dict[str, list[str]] = {}
    for et in event_types:
        prefixes = []
        for offset in range(lookback_hours + 1):
            t = now - timedelta(hours=offset)
            prefixes.append(
                f"event_type={et}/year={t.year:04d}/month={t.month:02d}/"
                f"day={t.day:02d}/hour={t.hour:02d}/"
            )
        out[et] = prefixes
    return out


def _list_event_type_prefixes() -> list[str]:
    """Discover all event_type=… top-level partitions in the bucket."""
    out: list[str] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(
        Bucket=S3_BUCKET, Prefix="event_type=", Delimiter="/"
    ):
        for cp in page.get("CommonPrefixes", []) or []:
            prefix = cp["Prefix"]  # e.g. "event_type=axira.x.y.v1/"
            # Strip "event_type=" and trailing "/"
            event_type = prefix[len("event_type=") : -1]
            if event_type:
                out.append(event_type)
    return out


def _list_keys(prefix: str) -> list[str]:
    """List all object keys under an S3 prefix (paginated)."""
    keys: list[str] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []) or []:
            keys.append(obj["Key"])
    return keys


def _archive_loaded_files(keys: list[str]) -> None:
    """Move loaded files from the live prefix to `_archive/…`.

    Best-effort. Each file is moved with CopyObject → DeleteObject (S3 has
    no atomic rename). Failures are logged + counted but do NOT raise — the
    caller has already recorded status='ok' in dw_copy_log, so the bounded
    cursor check will skip the file on the next tick even if it remains in
    the live prefix. The trade-off is a slightly larger live LIST until a
    later tick (or a future janitor) finishes the move.

    The Hive partitioning is preserved under `_archive/`: a key
        event_type=X/year=2026/month=05/day=20/hour=03/<uuid>.jsonl
    becomes
        _archive/event_type=X/year=2026/month=05/day=20/hour=03/<uuid>.jsonl
    """
    for key in keys:
        archive_key = f"_archive/{key}"
        try:
            s3.copy_object(
                Bucket=S3_BUCKET,
                Key=archive_key,
                CopySource={"Bucket": S3_BUCKET, "Key": key},
            )
            s3.delete_object(Bucket=S3_BUCKET, Key=key)
        except Exception as err:  # noqa: BLE001
            logger.warning(
                "orchestrator.archive.move_failed "
                f"key={key} "
                f"archive_key={archive_key} "
                f"error={err}"
            )
            _emit_metric("ArchiveMoveFailures", 1)


# ─── COPY execution ────────────────────────────────────────────────────────


def _run_copy(
    event_type: str, dispatch: FactDispatch, keys: list[str], tick_id: str
) -> int:
    """Write a COPY manifest + JSONPaths file to S3, then load via either:
      - **INSERT** (default): COPY directly into the dispatch.table.
      - **MERGE** (when dispatch.merge_key is set): COPY into a staging table
        then UPDATE the target by joining on merge_key. Used for events that
        finalize an earlier row (e.g. mission.completed.v1 updates the row
        mission.started.v1 inserted).
    """
    # 1. Write the COPY MANIFEST (list of S3 keys to load).
    manifest_obj = {
        "entries": [
            {"url": f"s3://{S3_BUCKET}/{k}", "mandatory": True} for k in keys
        ]
    }
    manifest_key = f"_manifests/{tick_id}/{_safe_filename(event_type)}.json"
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=manifest_key,
        Body=json.dumps(manifest_obj).encode("utf-8"),
        ContentType="application/json",
    )

    # 2. Write the JSONPaths mapping (per fact table; refreshed each tick so
    #    dispatch-map code changes apply on the next deploy with zero manual
    #    S3 cleanup).
    jsonpaths_key = (
        f"_meta/fact-jsonpaths/{_safe_filename(event_type)}.v1.json"
    )
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=jsonpaths_key,
        Body=json.dumps(dispatch.jsonpaths_doc()).encode("utf-8"),
        ContentType="application/json",
    )

    # 3a. INSERT path — direct COPY into the fact table.
    if not dispatch.is_merge:
        copy_sql = _build_copy_sql(
            target_table=dispatch.table,
            column_list_sql=dispatch.column_list_sql,
            manifest_key=manifest_key,
            jsonpaths_key=jsonpaths_key,
        )
        return _run_statement(copy_sql, return_row_count=True)

    # 3b. MERGE path — staging + UPDATE in a single batched transaction.
    #     Naming the staging per-tick prevents collisions if a previous tick
    #     left a staging table behind (DROP IF EXISTS at the top also catches
    #     that case). Underscored hash because Redshift identifiers don't
    #     accept dashes.
    staging_table = (
        f"_staging_{dispatch.table}_{tick_id.replace('-', '_')[:16]}"
    )
    copy_to_staging_sql = _build_copy_sql(
        target_table=staging_table,
        column_list_sql=dispatch.column_list_sql,
        manifest_key=manifest_key,
        jsonpaths_key=jsonpaths_key,
    )
    sqls = [
        # Drop any prior staging table left over from a crashed tick.
        f"DROP TABLE IF EXISTS {REDSHIFT_SCHEMA}.{staging_table};",
        # Create the staging mirror. `LIKE … WHERE 1=0` would keep encodings
        # but also NOT NULL constraints (would block partial-column COPY).
        # `CREATE TABLE AS SELECT ... WHERE 1=0` creates a relaxed schema:
        # same column types but every column nullable, no defaults. Exactly
        # what we want — the COPY only populates the merge_key + the update
        # columns; everything else stays NULL.
        (
            f"CREATE TABLE {REDSHIFT_SCHEMA}.{staging_table} AS "
            f"SELECT * FROM {REDSHIFT_SCHEMA}.{dispatch.table} WHERE 1=0;"
        ),
        copy_to_staging_sql,
        # Update target from staging. Only rows whose merge_key matches an
        # existing target row are updated; events arriving before their
        # paired INSERT (rare edge case) leave staging rows unconsumed.
        (
            f"UPDATE {REDSHIFT_SCHEMA}.{dispatch.table} "
            f"SET {dispatch.update_set_clause('s')} "
            f"FROM {REDSHIFT_SCHEMA}.{staging_table} s "
            f"WHERE {REDSHIFT_SCHEMA}.{dispatch.table}.{dispatch.merge_key} = "
            f"s.{dispatch.merge_key};"
        ),
        f"DROP TABLE {REDSHIFT_SCHEMA}.{staging_table};",
    ]
    return _run_batch_statement(sqls)


def _build_copy_sql(
    *,
    target_table: str,
    column_list_sql: str,
    manifest_key: str,
    jsonpaths_key: str,
) -> str:
    """Build a COPY statement for either a fact table or a staging table.

    All callers share the same JSON/MANIFEST/IAM/format options — only the
    target table + column list differ.
    """
    return (
        f"COPY {REDSHIFT_SCHEMA}.{target_table} ({column_list_sql}) "
        f"FROM 's3://{S3_BUCKET}/{manifest_key}' "
        "MANIFEST "
        f"IAM_ROLE '{COPY_ROLE_ARN}' "
        f"FORMAT AS JSON 's3://{S3_BUCKET}/{jsonpaths_key}' "
        "TIMEFORMAT 'auto' "
        "DATEFORMAT 'auto' "
        "TRUNCATECOLUMNS "
        "STATUPDATE OFF "
        "COMPUPDATE OFF;"
    )


# ─── Redshift Data API helpers ─────────────────────────────────────────────


def _run_query(sql: str) -> list[list[dict[str, Any]]]:
    """Execute a SELECT statement and return rows.

    Returns a list of rows, where each row is a list of cells. Each cell is
    one of {stringValue, longValue, doubleValue, booleanValue, isNull: True}.
    """
    statement_id = _execute_statement(sql)
    _wait_for_statement(statement_id)
    return _fetch_all_rows(statement_id)


def _run_statement(sql: str, return_row_count: bool = False) -> int:
    """Execute a non-SELECT statement (DDL/DML). Returns the affected-row count
    when requested (Redshift Data API populates this for COPY/INSERT/UPDATE/DELETE).
    """
    statement_id = _execute_statement(sql)
    final = _wait_for_statement(statement_id)
    if return_row_count:
        # describe_statement returns ResultRows for COPY/INSERT/etc.
        return int(final.get("ResultRows", 0) or 0)
    return 0


def _run_batch_statement(sqls: list[str]) -> int:
    """Execute multiple SQL statements as a single Data-API batch (one
    transaction, atomic — any statement's failure rolls back all).

    Used by the MERGE path: DROP IF EXISTS staging → CREATE staging →
    COPY into staging → UPDATE target FROM staging → DROP staging. All in
    one transaction so a mid-flight failure leaves no staging-table
    residue and no partial UPDATE.

    Returns ResultRows from the final statement (the DROP TABLE), which is
    always 0 — the actual UPDATE row count isn't surfaced separately for
    batch statements. The COPY orchestrator's manifest tracks file-level
    success/failure regardless, which is the contract that matters.
    """
    resp = redshift_data.batch_execute_statement(
        WorkgroupName=REDSHIFT_WORKGROUP,
        Database=REDSHIFT_DB,
        SecretArn=REDSHIFT_SECRET_ARN,
        Sqls=sqls,
    )
    statement_id = resp["Id"]
    _wait_for_statement(statement_id)
    return 0


def _execute_statement(sql: str) -> str:
    resp = redshift_data.execute_statement(
        WorkgroupName=REDSHIFT_WORKGROUP,
        Database=REDSHIFT_DB,
        SecretArn=REDSHIFT_SECRET_ARN,
        Sql=sql,
    )
    return resp["Id"]


def _wait_for_statement(
    statement_id: str, poll_seconds: float = 0.5, max_seconds: int = 300
) -> dict[str, Any]:
    """Poll until the statement is FINISHED, FAILED, or ABORTED. Raises on
    non-success; returns the final describe_statement response on success.
    """
    deadline = time.monotonic() + max_seconds
    while True:
        resp = redshift_data.describe_statement(Id=statement_id)
        status = resp["Status"]
        if status == "FINISHED":
            return resp
        if status in ("FAILED", "ABORTED"):
            raise RuntimeError(
                f"Redshift statement {status}: {resp.get('Error', '(no error message)')}"
            )
        if time.monotonic() > deadline:
            raise TimeoutError(
                f"Redshift statement {statement_id} did not finish within {max_seconds}s"
            )
        time.sleep(poll_seconds)


def _fetch_all_rows(statement_id: str) -> list[list[dict[str, Any]]]:
    """Page through get_statement_result for all rows."""
    rows: list[list[dict[str, Any]]] = []
    next_token: str | None = None
    while True:
        kwargs: dict[str, Any] = {"Id": statement_id}
        if next_token:
            kwargs["NextToken"] = next_token
        resp = redshift_data.get_statement_result(**kwargs)
        rows.extend(resp.get("Records", []))
        next_token = resp.get("NextToken")
        if not next_token:
            break
    return rows


# ─── CloudWatch ────────────────────────────────────────────────────────────


def _emit_metric(
    name: str,
    value: float,
    *,
    dimensions: dict[str, str] | None = None,
    unit: str = "Count",
) -> None:
    """Send a single CloudWatch metric. Best-effort — errors are logged + swallowed."""
    try:
        cloudwatch.put_metric_data(
            Namespace="AxiraDW/CopyOrchestrator",
            MetricData=[
                {
                    "MetricName": name,
                    "Value": float(value),
                    "Unit": unit,
                    "Dimensions": [
                        {"Name": k, "Value": v}
                        for k, v in (dimensions or {}).items()
                    ],
                }
            ],
        )
    except Exception as err:  # noqa: BLE001
        logger.warning(f"cloudwatch.put_metric_data_failed name={name} error={err}")


# ─── Utility ───────────────────────────────────────────────────────────────


def _quote(value: str) -> str:
    """SQL-quote a string for inline literal use. Doubles single quotes per SQL spec.

    We use string interpolation rather than parameterized queries because the
    Redshift Data API doesn't bind parameters cleanly for multi-row INSERT
    VALUES, and the inputs here are tightly constrained (event_type matches a
    schema; s3_key is from S3 ListObjects). Defense-in-depth: still escape.
    """
    return "'" + value.replace("'", "''") + "'"


def _cell(cell: dict[str, Any]) -> str | None:
    """Extract a string from a Redshift Data API result cell."""
    if cell.get("isNull"):
        return None
    if "stringValue" in cell:
        return str(cell["stringValue"])
    if "longValue" in cell:
        return str(cell["longValue"])
    return None


def _safe_filename(value: str) -> str:
    """Replace characters that would conflict with S3 key safety into '-'."""
    return "".join(c if c.isalnum() or c in ".-_" else "-" for c in value)
