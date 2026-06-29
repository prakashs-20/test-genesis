"""Event-type → fact-table dispatch map for the COPY orchestrator.

The S3-first architecture has S3 as the durable raw layer (Bronze) and per-
family fact tables as the queryable analytics layer (Silver). The orchestrator
does NOT populate a generic `event_log` — each event lands directly in the
fact table for its family, with typed columns.

For each event_type, this module defines:
  - target Redshift fact table
  - the ordered list of columns the COPY will target
  - the matching JSONPaths (each path projects from the wire envelope into
    one column, in the same order as `columns`)

Adding a new event_type:
  1. Append a new entry to `EVENT_TYPE_TO_FACT` below.
  2. Run `axira-dw apply` if the fact table doesn't exist yet (migrations 002).
  3. Redeploy the Lambda: `cdk deploy Axira-dev-Redshift`.

Unified-with-discriminator fact tables (e.g. fact_lending_deal_event,
fact_human_loop_event, fact_safety_event, fact_stage_transitions) are listed
multiple times below — once per event_type that targets them — each with a
different column tuple matching what that event_type carries. The envelope's
`$['type']` value is mapped to the discriminator column (typically `event_type`).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class FactDispatch:
    """One event_type → one fact table load definition.

    Two strategies are supported via `merge_key`:

    - **INSERT** (`merge_key is None`, default): COPY directly into the fact
      table. Each event lands as a new row. Used by most event types.

    - **MERGE** (`merge_key` set): COPY into a staging table mirroring the
      fact-table schema, then UPDATE the target by joining on `merge_key`.
      Used when an event finalizes a row created by an earlier event in the
      same family — e.g., `mission.completed.v1` updates the row inserted
      by `mission.started.v1` for the same `fact_mission_id`.

      The MERGE runs as a single batched transaction in Redshift; if any
      step fails (CREATE staging / COPY / UPDATE / DROP) the whole batch
      rolls back so the manifest stays accurate.
    """

    table: str
    columns: tuple[str, ...]
    jsonpaths: tuple[str, ...]
    # When set, orchestrator does MERGE instead of INSERT. The named column
    # must appear in `columns` (typically the natural-key column the prior
    # INSERT populated, e.g. `fact_mission_id`).
    merge_key: str | None = None

    def __post_init__(self) -> None:
        if len(self.columns) != len(self.jsonpaths):
            raise ValueError(
                f"{self.table}: columns ({len(self.columns)}) and "
                f"jsonpaths ({len(self.jsonpaths)}) must be the same length",
            )
        if self.merge_key is not None and self.merge_key not in self.columns:
            raise ValueError(
                f"{self.table}: merge_key '{self.merge_key}' must be one of "
                f"the loaded columns {self.columns}",
            )

    @property
    def column_list_sql(self) -> str:
        return ", ".join(self.columns)

    @property
    def is_merge(self) -> bool:
        return self.merge_key is not None

    def jsonpaths_doc(self) -> dict[str, list[str]]:
        return {"jsonpaths": list(self.jsonpaths)}

    def update_set_clause(self, source_alias: str = "s") -> str:
        """SQL fragment for the UPDATE's SET clause.

        Sets every loaded column EXCEPT envelope columns (event_id,
        event_time, tenant_id, case_id) and the merge_key itself. We don't
        overwrite envelope cols because the .started row's envelope is the
        authoritative one; the .completed event just adds completion data.
        """
        if not self.is_merge:
            raise ValueError(f"{self.table}: update_set_clause requires merge_key")
        skip = {
            "event_id", "event_time", "tenant_id", "case_id",
            self.merge_key,
        }
        cols = [c for c in self.columns if c not in skip]
        return ", ".join(f"{c} = {source_alias}.{c}" for c in cols)


# ─── Shared envelope-level paths ───────────────────────────────────────────
# These appear at the top of (almost) every column tuple — every fact table
# stores the CloudEvents envelope basics for traceability.

_ENV_EVENT_ID = "$['id']"
_ENV_EVENT_TIME = "$['time']"
_ENV_TYPE = "$['type']"
_ENV_TENANT_ID = "$['tenantid']"
_ENV_CASE_ID = "$['caseid']"

_ENVELOPE_COLS = ("event_id", "event_time", "tenant_id", "case_id")
_ENVELOPE_PATHS = (_ENV_EVENT_ID, _ENV_EVENT_TIME, _ENV_TENANT_ID, _ENV_CASE_ID)


# ─── Dispatch map ──────────────────────────────────────────────────────────
# Covers all 32 documented M1 event types. The orchestrator silently skips
# event_types not in this map (with a warning log) so the deploy is safe
# even with partial coverage.

EVENT_TYPE_TO_FACT: dict[str, FactDispatch] = {
    # ─── Orchestration ─────────────────────────────────────────────────────
    "axira.orchestration.mission.started.v1": FactDispatch(
        table="fact_orchestration_mission",
        columns=(
            *_ENVELOPE_COLS,
            "fact_mission_id", "parent_mission_id", "scope",
            "process_spec_id", "process_spec_version", "template_name",
            "entity_type", "entity_id", "started_by", "workflow_run_id",
            "priority", "started_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['missionId']",
            "$['data']['parentMissionId']",
            "$['data']['scope']",
            "$['data']['processSpecId']",
            "$['data']['processSpecVersion']",
            "$['data']['templateName']",
            "$['data']['entityType']",
            "$['data']['entityId']",
            "$['data']['startedBy']",
            "$['data']['workflowRunId']",
            "$['data']['priority']",
            "$['data']['startedAt']",
        ),
    ),

    # mission.completed.v1 — UPDATES the row that mission.started.v1 already
    # inserted (matched on fact_mission_id). The .completed event only carries
    # completion data; the envelope+process fields stay as they were on the
    # .started row. The orchestrator detects the `merge_key` field on this
    # dispatch and uses the staging-table + UPDATE strategy.
    "axira.orchestration.mission.completed.v1": FactDispatch(
        table="fact_orchestration_mission",
        columns=(
            *_ENVELOPE_COLS,
            "fact_mission_id",
            "completed_at", "total_duration_ms", "steps_executed",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['missionId']",
            "$['data']['completedAt']",
            "$['data']['totalDurationMs']",
            "$['data']['stepsExecuted']",
        ),
        merge_key="fact_mission_id",
    ),

    "axira.orchestration.mission.state_changed.v1": FactDispatch(
        table="fact_orchestration_mission_state",
        columns=(
            *_ENVELOPE_COLS,
            "fact_mission_id", "from_state", "to_state",
            "duration_in_from_state_ms", "transition_reason", "transitioned_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['missionId']",
            "$['data']['fromState']",
            "$['data']['toState']",
            "$['data']['durationInFromStateMs']",
            "$['data']['transitionReason']",
            "$['data']['transitionedAt']",
        ),
    ),

    # ─── Capability ────────────────────────────────────────────────────────
    "axira.capability.completed.v1": FactDispatch(
        table="fact_capability_invocation",
        columns=(
            *_ENVELOPE_COLS,
            "call_id", "fact_capability_id", "fact_capability_version",
            "kind", "duration_ms", "output_size_bytes", "side_effects",
            "idempotent_hit", "manifest_hash", "completed_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['callId']",
            "$['data']['capabilityId']",
            "$['data']['capabilityVersion']",
            "$['data']['kind']",
            "$['data']['durationMs']",
            "$['data']['outputSize']",
            "$['data']['sideEffects']",
            "$['data']['idempotentHit']",
            "$['data']['manifestHash']",
            "$['data']['completedAt']",
        ),
    ),

    # ─── Agent task lifecycle ──────────────────────────────────────────────
    # Lifecycle: submitted → started → (completed | failed | cancelled |
    # delegated | waiting_human). All share fact_agent_task and key on
    # task_id. Migration 007 made completion fields NULLable so earlier
    # phases can INSERT a partial row.
    #
    # Currently the agent domain emits these as internal events (see
    # domains/agent/src/application/ports/event-publisher.port.ts) but
    # doesn't yet dual-publish to the DW via emitDwEvent. These dispatch
    # entries are READY for when producer-side wiring lands.

    "axira.agent.task.submitted.v1": FactDispatch(
        table="fact_agent_task",
        columns=(
            *_ENVELOPE_COLS,
            "task_id", "task_event_type", "agent_name", "skill_id",
            "correlation_id", "priority", "product_id", "submitted_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['taskId']",
            _ENV_TYPE,
            "$['data']['agentName']",
            "$['data']['skillId']",
            "$['data']['correlationId']",
            "$['data']['priority']",
            "$['data']['productId']",
            _ENV_EVENT_TIME,  # envelope time = submission time
        ),
        # First event for a task — INSERT, no merge_key.
    ),

    "axira.agent.task.started.v1": FactDispatch(
        table="fact_agent_task",
        columns=(
            *_ENVELOPE_COLS,
            "task_id", "task_event_type", "agent_name", "model_used",
            "started_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['taskId']",
            _ENV_TYPE,
            "$['data']['agentName']",
            "$['data']['modelUsed']",
            _ENV_EVENT_TIME,
        ),
        merge_key="task_id",
    ),

    "axira.agent.task.completed.v1": FactDispatch(
        table="fact_agent_task",
        columns=(
            *_ENVELOPE_COLS,
            "task_id", "task_event_type", "agent_name", "agent_version",
            "skill_id", "fact_capability_id", "outcome", "duration_ms",
            "tokens_input", "tokens_output", "estimated_cost_usd",
            "fact_confidence", "proposal_count", "tool_call_count",
            "model_used", "deal_id", "fact_user_id", "fact_actor_role",
            "completed_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['taskId']",
            _ENV_TYPE,
            "$['data']['agentName']",
            "$['data']['agentVersion']",
            "$['data']['skillId']",
            "$['data']['capabilityId']",
            "$['data']['outcome']",
            "$['data']['durationMs']",
            "$['data']['tokensUsed']['input']",
            "$['data']['tokensUsed']['output']",
            "$['data']['estimatedCostUsd']",
            "$['data']['confidence']",
            "$['data']['proposalCount']",
            "$['data']['toolCallCount']",
            "$['data']['modelUsed']",
            "$['data']['dealId']",
            "$['data']['userId']",
            "$['data']['actorRole']",
            "$['data']['completedAt']",
        ),
        merge_key="task_id",  # finalizes the row submitted/started created
    ),

    "axira.agent.task.failed.v1": FactDispatch(
        table="fact_agent_task",
        columns=(
            *_ENVELOPE_COLS,
            "task_id", "task_event_type", "agent_name",
            "error_code", "error_message", "error_retryable",
            "retry_count", "failed_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['taskId']",
            _ENV_TYPE,
            "$['data']['agentName']",
            "$['data']['errorCode']",
            "$['data']['errorMessage']",
            "$['data']['retryable']",
            "$['data']['retryCount']",
            _ENV_EVENT_TIME,
        ),
        merge_key="task_id",
    ),

    "axira.agent.task.cancelled.v1": FactDispatch(
        table="fact_agent_task",
        columns=(
            *_ENVELOPE_COLS,
            "task_id", "task_event_type", "agent_name",
            "cancelled_by", "cancelled_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['taskId']",
            _ENV_TYPE,
            "$['data']['agentName']",
            "$['data']['cancelledBy']",
            _ENV_EVENT_TIME,
        ),
        merge_key="task_id",
    ),

    "axira.agent.task.waiting_human.v1": FactDispatch(
        table="fact_agent_task",
        columns=(
            *_ENVELOPE_COLS,
            "task_id", "task_event_type", "agent_name",
            "waiting_question",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['taskId']",
            _ENV_TYPE,
            "$['data']['agentName']",
            "$['data']['question']",
        ),
        merge_key="task_id",
    ),

    "axira.agent.task.delegated.v1": FactDispatch(
        table="fact_agent_task",
        columns=(
            *_ENVELOPE_COLS,
            "task_id", "task_event_type", "agent_name",
            "delegated_to_agent", "delegated_task_id",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['taskId']",
            _ENV_TYPE,
            "$['data']['agentName']",
            "$['data']['delegatedTo']",
            "$['data']['delegatedTaskId']",
        ),
        merge_key="task_id",
    ),

    "axira.agent.action.proposed.v1": FactDispatch(
        table="fact_agent_action",
        columns=(
            *_ENVELOPE_COLS,
            "proposal_id", "task_id", "agent_name", "action_type",
            "fact_path", "proposed_value", "fact_confidence", "proposed_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['proposalId']",
            "$['data']['taskId']",
            "$['data']['agentName']",
            "$['data']['actionType']",
            "$['data']['factPath']",
            "$['data']['proposedValue']",
            "$['data']['confidence']",
            "$['data']['proposedAt']",
        ),
    ),

    "axira.agent.tool.called.v1": FactDispatch(
        table="fact_agent_tool_call",
        columns=(
            *_ENVELOPE_COLS,
            "task_id", "tool_name", "mcp_server", "duration_ms",
            "success", "error_class", "cost_usd", "called_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['taskId']",
            "$['data']['toolName']",
            "$['data']['mcpServer']",
            "$['data']['durationMs']",
            "$['data']['success']",
            "$['data']['errorClass']",
            "$['data']['costUsd']",
            "$['data']['calledAt']",
        ),
    ),

    # ─── Safety (unified-with-discriminator: fact_safety_event) ────────────
    "axira.safety.pii.detected.v1": FactDispatch(
        table="fact_safety_event",
        columns=(
            *_ENVELOPE_COLS,
            "task_id", "safety_event_type", "agent_name", "detection_count",
            "entity_types", "action", "phase", "severity", "detected_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['taskId']",
            _ENV_TYPE,  # full wire type → discriminator
            "$['data']['agentName']",
            "$['data']['detectionCount']",
            "$['data']['entityTypes']",
            "$['data']['action']",
            "$['data']['phase']",
            "$['data']['severity']",
            "$['data']['detectedAt']",
        ),
    ),

    # ─── Human-loop (unified-with-discriminator: fact_human_loop_event) ────
    "axira.human_loop.approval.requested.v1": FactDispatch(
        table="fact_human_loop_event",
        columns=(
            *_ENVELOPE_COLS,
            "event_type", "deal_id",
            "approval_id", "approval_type", "required_roles",
            "authority_tier", "sla_hours", "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            _ENV_TYPE,
            "$['data']['dealId']",
            "$['data']['approvalId']",
            "$['data']['approvalType']",
            "$['data']['requiredRoles']",
            "$['data']['authorityTier']",
            "$['data']['slaHours']",
            "$['data']['requestedAt']",
        ),
    ),

    "axira.human_loop.approval.decided.v1": FactDispatch(
        table="fact_human_loop_event",
        columns=(
            *_ENVELOPE_COLS,
            "event_type", "deal_id", "user_id",
            "approval_id", "approval_type", "authority_tier", "band",
            "decision", "duration_from_request_ms", "reason", "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            _ENV_TYPE,
            "$['data']['dealId']",
            "$['data']['userId']",
            "$['data']['approvalId']",
            "$['data']['approvalType']",
            "$['data']['authorityTier']",
            "$['data']['band']",
            "$['data']['decision']",
            "$['data']['durationFromRequestMs']",
            "$['data']['reason']",
            "$['data']['decidedAt']",
        ),
    ),

    "axira.human_loop.work_card.completed.v1": FactDispatch(
        table="fact_human_loop_event",
        columns=(
            *_ENVELOPE_COLS,
            "event_type",
            "card_id", "card_type", "completed_by_user_id", "action",
            "reason", "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            _ENV_TYPE,
            "$['data']['cardId']",
            "$['data']['cardType']",
            "$['data']['completedBy']",
            "$['data']['action']",
            "$['data']['reason']",
            "$['data']['completedAt']",
        ),
    ),

    "axira.human_loop.fact.overridden.v1": FactDispatch(
        table="fact_human_loop_event",
        columns=(
            *_ENVELOPE_COLS,
            "event_type", "user_id",
            "fact_id", "fact_path", "old_value", "new_value", "reason",
            "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            _ENV_TYPE,
            "$['data']['overriddenBy']",
            "$['data']['factId']",
            "$['data']['factPath']",
            "$['data']['oldValue']",
            "$['data']['newValue']",
            "$['data']['reason']",
            "$['data']['overriddenAt']",
        ),
    ),

    # ─── Decision ──────────────────────────────────────────────────────────
    "axira.decision.evaluated.v1": FactDispatch(
        table="fact_decision",
        columns=(
            *_ENVELOPE_COLS,
            "decision_id", "definition_name", "definition_version",
            "outcome", "fact_confidence", "entity_type", "entity_id",
            "input_snapshot_ref", "contributing_rules", "next_actions",
            "required_approvals", "evaluated_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['decisionId']",
            "$['data']['definitionName']",
            "$['data']['definitionVersion']",
            "$['data']['outcome']",
            "$['data']['confidence']",
            "$['data']['entityType']",
            "$['data']['entityId']",
            "$['data']['inputSnapshotRef']",
            "$['data']['contributingRules']",
            "$['data']['nextActions']",
            "$['data']['requiredApprovals']",
            "$['data']['evaluatedAt']",
        ),
    ),

    # ─── Evidence ──────────────────────────────────────────────────────────
    "axira.evidence.pack.sealed.v1": FactDispatch(
        table="fact_evidence_pack",
        columns=(
            *_ENVELOPE_COLS,
            "pack_id", "seal_hash", "node_count", "edge_count",
            "sealed_by_user_id", "sealed_at", "label",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['packId']",
            "$['data']['sealHash']",
            "$['data']['nodeCount']",
            "$['data']['edgeCount']",
            "$['data']['sealedBy']",
            "$['data']['sealedAt']",
            "$['data']['label']",
        ),
    ),

    # ─── Document ──────────────────────────────────────────────────────────
    "axira.document.extracted.v1": FactDispatch(
        table="fact_document",
        columns=(
            *_ENVELOPE_COLS,
            "document_id", "document_event_type", "extraction_path",
            "template_id", "fields_extracted", "avg_confidence",
            "high_confidence_count", "low_confidence_count",
            "validation_errors", "duration_ms", "document_classification",
            "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['documentId']",
            _ENV_TYPE,
            "$['data']['extractionPath']",
            "$['data']['templateId']",
            "$['data']['fieldsExtracted']",
            "$['data']['avgConfidence']",
            "$['data']['highConfidenceCount']",
            "$['data']['lowConfidenceCount']",
            "$['data']['validationErrors']",
            "$['data']['durationMs']",
            "$['data']['classification']",
            "$['data']['extractedAt']",
        ),
    ),

    # ─── Platform stage (unified: fact_stage_transitions) ──────────────────
    "axira.platform.stage.transitioned.v1": FactDispatch(
        table="fact_stage_transitions",
        columns=(
            *_ENVELOPE_COLS,
            "stage_event_type", "stage_ownership_id",
            "outgoing_stage_ownership_id", "entity_type", "entity_id",
            "from_stage", "to_stage", "incoming_owner_user_id",
            "incoming_owner_role", "contributor_user_ids", "reviewer_user_ids",
            "backup_owner_user_id", "outgoing_stage_held_by",
            "from_stage_duration_ms", "transitioned_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            _ENV_TYPE,
            "$['data']['stageOwnershipId']",
            "$['data']['outgoingStageOwnershipId']",
            "$['data']['entityType']",
            "$['data']['entityId']",
            "$['data']['fromStage']",
            "$['data']['toStage']",
            "$['data']['incomingOwnerUserId']",
            "$['data']['incomingOwnerRole']",
            "$['data']['contributorUserIds']",
            "$['data']['reviewerUserIds']",
            "$['data']['backupOwnerUserId']",
            "$['data']['heldBy']",
            "$['data']['fromStageDurationMs']",
            "$['data']['transitionedAt']",
        ),
    ),

    # ─── Lending Deal (unified: fact_lending_deal_event) ───────────────────
    "axira.lending.deal.intake_completed.v1": FactDispatch(
        table="fact_lending_deal_event",
        columns=(
            *_ENVELOPE_COLS,
            "event_type", "deal_id", "event_at",
            "borrower_id", "fact_program_id", "partner_id",
            "property_address", "property_type", "deal_amount_usd",
            "deal_amount_currency", "purpose", "estimated_close_date",
            "initiated_by_user_id", "intake_channel",
            "classification_channel", "loan_type", "product_type",
            "classification_property_type", "asset_class", "deal_segment",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            _ENV_TYPE,
            "$['data']['dealId']",
            "$['data']['completedAt']",
            "$['data']['borrowerId']",
            "$['data']['programId']",
            "$['data']['partnerId']",
            "$['data']['intakeSummary']['propertyAddress']",
            "$['data']['intakeSummary']['propertyType']",
            "$['data']['intakeSummary']['dealAmount']",
            "$['data']['intakeSummary']['dealAmountCurrency']",
            "$['data']['intakeSummary']['purpose']",
            "$['data']['intakeSummary']['estimatedCloseDate']",
            "$['data']['initiatedBy']",
            "$['data']['intakeChannel']",
            "$['data']['classifications']['channel']",
            "$['data']['classifications']['loanType']",
            "$['data']['classifications']['productType']",
            "$['data']['classifications']['propertyType']",
            "$['data']['classifications']['assetClass']",
            "$['data']['dealSegment']",
        ),
    ),

    "axira.lending.deal.classified.v1": FactDispatch(
        table="fact_lending_deal_event",
        columns=(
            *_ENVELOPE_COLS,
            "event_type", "deal_id", "event_at",
            "express_eligible", "express_rules_failed", "uw_path",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            _ENV_TYPE,
            "$['data']['dealId']",
            "$['data']['classifiedAt']",
            "$['data']['expressEligible']",
            "$['data']['expressRulesFailed']",
            "$['data']['uwPath']",
        ),
    ),

    "axira.lending.deal.soft_quote_issued.v1": FactDispatch(
        table="fact_lending_deal_event",
        columns=(
            *_ENVELOPE_COLS,
            "event_type", "deal_id", "event_at",
            "intake_channel", "soft_quote_amount", "soft_quote_revision",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            _ENV_TYPE,
            "$['data']['dealId']",
            "$['data']['eventAt']",
            "$['data']['intakeChannel']",
            "$['data']['softQuoteAmount']",
            "$['data']['softQuoteRevision']",
        ),
    ),

    "axira.lending.deal.loi_issued.v1": FactDispatch(
        table="fact_lending_deal_event",
        columns=(
            *_ENVELOPE_COLS,
            "event_type", "deal_id", "event_at", "loi_amount",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            _ENV_TYPE,
            "$['data']['dealId']",
            "$['data']['eventAt']",
            "$['data']['loiAmount']",
        ),
    ),

    # ─── Lending Sponsor ───────────────────────────────────────────────────
    "axira.lending.sponsor.assessed.v1": FactDispatch(
        table="fact_lending_sponsor",
        columns=(
            *_ENVELOPE_COLS,
            "sponsor_id", "sponsor_event_type", "sponsor_name", "tier",
            "fico", "completed_transactions", "total_exposure_usd",
            "research_findings", "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['sponsorId']",
            _ENV_TYPE,
            "$['data']['sponsorName']",
            "$['data']['tier']",
            "$['data']['fico']",
            "$['data']['completedTransactions']",
            "$['data']['totalExposureUsd']",
            "$['data']['researchFindings']",
            "$['data']['assessedAt']",
        ),
    ),

    "axira.lending.sponsor.dashboard_snapshot.v1": FactDispatch(
        table="fact_lending_sponsor_snapshot",
        columns=(
            *_ENVELOPE_COLS,
            "sponsor_id", "sponsor_name", "sponsor_tier",
            "open_deals_count", "total_exposure_usd", "deal_spread",
            "on_track_count", "off_track_count", "snapshot_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['sponsorId']",
            "$['data']['sponsorName']",
            "$['data']['sponsorTier']",
            "$['data']['openDealsCount']",
            "$['data']['totalExposureUsd']",
            "$['data']['dealSpread']",
            "$['data']['onTrackDealsCount']",
            "$['data']['offTrackDealsCount']",
            "$['data']['snapshotAt']",
        ),
    ),

    "axira.lending.sponsor.risk_signal.v1": FactDispatch(
        table="fact_lending_sponsor_risk_signal",
        columns=(
            *_ENVELOPE_COLS,
            "sponsor_id", "sponsor_name", "signal_type", "severity",
            "trigger_deal_id", "details", "detected_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['sponsorId']",
            "$['data']['sponsorName']",
            "$['data']['signalType']",
            "$['data']['severity']",
            "$['data']['triggerDealId']",
            "$['data']['details']",
            "$['data']['detectedAt']",
        ),
    ),

    # ─── Lending Loan Approval (per-event-type, but two events) ────────────
    "axira.lending.loan.structured.v1": FactDispatch(
        table="fact_lending_loan_approval",
        columns=(
            *_ENVELOPE_COLS,
            "deal_id", "loan_event_type", "loan_amount_usd",
            "interest_rate", "term_months", "ltv", "ltc", "ltarv",
            "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['dealId']",
            _ENV_TYPE,
            "$['data']['loanAmount']",
            "$['data']['interestRate']",
            "$['data']['term']",
            "$['data']['ltv']",
            "$['data']['ltc']",
            "$['data']['ltarv']",
            "$['data']['structuredAt']",
        ),
    ),

    "axira.lending.loan.approved.v1": FactDispatch(
        table="fact_lending_loan_approval",
        columns=(
            *_ENVELOPE_COLS,
            "deal_id", "loan_event_type", "loan_amount_usd",
            "loan_amount_currency", "authority_tier", "band",
            "approved_by_user_id", "fact_actor_role", "deviation_category",
            "conditions", "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['dealId']",
            _ENV_TYPE,
            "$['data']['loanAmount']",
            "$['data']['loanAmountCurrency']",
            "$['data']['authorityTier']",
            "$['data']['band']",
            "$['data']['approvedBy']",
            "$['data']['actorRole']",
            "$['data']['deviationCategory']",
            "$['data']['conditions']",
            "$['data']['approvedAt']",
        ),
    ),

    # ─── Lending DSCR (nested scenarios → flat columns) ────────────────────
    "axira.lending.dscr.computed.v1": FactDispatch(
        table="fact_lending_dscr",
        columns=(
            *_ENVELOPE_COLS,
            "deal_id",
            "base_noi", "base_debt_service", "base_dscr", "base_passes",
            "rate_plus_2_noi", "rate_plus_2_debt_service", "rate_plus_2_dscr",
            "rate_plus_2_passes",
            "vacancy_20_noi", "vacancy_20_debt_service", "vacancy_20_dscr",
            "vacancy_20_passes",
            "rent_decline_10_noi", "rent_decline_10_debt_service",
            "rent_decline_10_dscr", "rent_decline_10_passes",
            "all_scenarios_pass", "computed_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['dealId']",
            "$['data']['scenarios']['base']['noi']",
            "$['data']['scenarios']['base']['debtService']",
            "$['data']['scenarios']['base']['dscr']",
            "$['data']['scenarios']['base']['passes']",
            "$['data']['scenarios']['rate_plus_2pct']['noi']",
            "$['data']['scenarios']['rate_plus_2pct']['debtService']",
            "$['data']['scenarios']['rate_plus_2pct']['dscr']",
            "$['data']['scenarios']['rate_plus_2pct']['passes']",
            "$['data']['scenarios']['vacancy_20pct']['noi']",
            "$['data']['scenarios']['vacancy_20pct']['debtService']",
            "$['data']['scenarios']['vacancy_20pct']['dscr']",
            "$['data']['scenarios']['vacancy_20pct']['passes']",
            "$['data']['scenarios']['rent_decline_10pct']['noi']",
            "$['data']['scenarios']['rent_decline_10pct']['debtService']",
            "$['data']['scenarios']['rent_decline_10pct']['dscr']",
            "$['data']['scenarios']['rent_decline_10pct']['passes']",
            "$['data']['allScenariosPass']",
            "$['data']['computedAt']",
        ),
    ),

    # ─── Lending Gross Yield ───────────────────────────────────────────────
    "axira.lending.gross_yield.computed.v1": FactDispatch(
        table="fact_lending_gross_yield",
        columns=(
            *_ENVELOPE_COLS,
            "deal_id", "gross_yield_bps", "sub_threshold_flag",
            "threshold_bps", "spread_bps", "origination_fee_bps",
            "exit_fee_bps", "other_fees_bps", "computed_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['dealId']",
            "$['data']['grossYieldBps']",
            "$['data']['subThresholdFlag']",
            "$['data']['thresholdBps']",
            "$['data']['components']['spreadBps']",
            "$['data']['components']['originationFeeBps']",
            "$['data']['components']['exitFeeBps']",
            "$['data']['components']['otherFeesBps']",
            "$['data']['computedAt']",
        ),
    ),

    # ─── Lending Doc Perfection ────────────────────────────────────────────
    "axira.lending.document.perfection_evaluated.v1": FactDispatch(
        table="fact_lending_doc_perfection",
        columns=(
            *_ENVELOPE_COLS,
            "deal_id", "matrix", "total_criteria", "criteria_passed",
            "criteria_failed", "all_documents_perfected", "evaluated_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['dealId']",
            "$['data']['matrix']",
            "$['data']['totalCriteria']",
            "$['data']['criteriaPassed']",
            "$['data']['criteriaFailed']",
            "$['data']['allDocumentsPerfected']",
            "$['data']['evaluatedAt']",
        ),
    ),

    # ─── Studio ────────────────────────────────────────────────────────────
    "axira.studio.session.ended.v1": FactDispatch(
        table="fact_studio_session",
        columns=(
            *_ENVELOPE_COLS,
            "session_id", "session_event_type", "deal_id", "fact_user_id",
            "duration_ms", "branch_count", "branch_depth_max",
            "chosen_branch_id", "saved_as_quote", "abandoned_branches",
            "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['sessionId']",
            _ENV_TYPE,
            "$['data']['dealId']",
            "$['data']['userId']",
            "$['data']['durationMs']",
            "$['data']['branchCount']",
            "$['data']['branchDepthMax']",
            "$['data']['chosenBranchId']",
            "$['data']['savedAsQuote']",
            "$['data']['abandonedBranches']",
            "$['data']['endedAt']",
        ),
    ),

    # ─── Lending Fast Quote ────────────────────────────────────────────────
    "axira.lending.fast_quote.preliminary_issued.v1": FactDispatch(
        table="fact_lending_fast_quote",
        columns=(
            *_ENVELOPE_COLS,
            "deal_id", "fast_quote_event_type", "preliminary_quote_usd",
            "fact_confidence", "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['dealId']",
            _ENV_TYPE,
            "$['data']['preliminaryQuoteAmount']",
            "$['data']['confidence']",
            "$['data']['issuedAt']",
        ),
    ),

    # ─── Lending Market ────────────────────────────────────────────────────
    "axira.lending.market.unrealistic_flagged.v1": FactDispatch(
        table="fact_lending_market",
        columns=(
            *_ENVELOPE_COLS,
            "deal_id", "market_event_type", "flagged_field",
            "borrower_value", "market_value", "gap_absolute", "gap_pct",
            "sources", "property_type", "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['dealId']",
            _ENV_TYPE,
            "$['data']['flaggedField']",
            "$['data']['borrowerValue']",
            "$['data']['marketValue']",
            "$['data']['gap']['absolute']",
            "$['data']['gap']['pct']",
            "$['data']['sources']",
            "$['data']['propertyType']",
            "$['data']['flaggedAt']",
        ),
    ),

    # ─── Lending Multiphase ────────────────────────────────────────────────
    "axira.lending.multiphase.detected.v1": FactDispatch(
        table="fact_lending_multiphase",
        columns=(
            *_ENVELOPE_COLS,
            "deal_id", "multiphase_event_type", "sub_type",
            "phase_count", "total_units", "event_at",
        ),
        jsonpaths=(
            *_ENVELOPE_PATHS,
            "$['data']['dealId']",
            _ENV_TYPE,
            "$['data']['subType']",
            "$['data']['phaseCount']",
            "$['data']['totalUnits']",
            "$['data']['detectedAt']",
        ),
    ),
}


def lookup(event_type: str) -> FactDispatch | None:
    """Return the dispatch entry for an event_type, or None if not mapped.

    Callers should log + skip when None — fail-soft so a new event_type
    landing in S3 doesn't crash the orchestrator before its fact-table
    mapping is added here.
    """
    return EVENT_TYPE_TO_FACT.get(event_type)


def all_mapped_event_types() -> tuple[str, ...]:
    """Used by the orchestrator to know which S3 partitions are worth scanning."""
    return tuple(EVENT_TYPE_TO_FACT.keys())
