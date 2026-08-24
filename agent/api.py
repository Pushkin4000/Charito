"""FastAPI application exposing prompt schema and workflow execution endpoints."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from time import perf_counter
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

try:  # pragma: no cover - supports script execution
    from .graph import astream_workflow, get_graph_schema, run_workflow
    from .llm_factory import DEFAULT_GROQ_MODEL, PROVIDER_NAME, build_chat_model
    from .prompts import (
        MAX_MUTABLE_PROMPT_CHARS,
        NODE_PROMPT_CONFIGS,
        guarded_prompt_policy,
        prompt_schema,
    )
    from .state import Plan, TaskPlan
    from .security_config import SecurityConfig, load_security_config
    from . import workspace as workspace_service
except ImportError:  # pragma: no cover
    from graph import astream_workflow, get_graph_schema, run_workflow
    from llm_factory import DEFAULT_GROQ_MODEL, PROVIDER_NAME, build_chat_model
    from prompts import (
        MAX_MUTABLE_PROMPT_CHARS,
        NODE_PROMPT_CONFIGS,
        guarded_prompt_policy,
        prompt_schema,
    )
    from state import Plan, TaskPlan
    from security_config import SecurityConfig, load_security_config
    import workspace as workspace_service

logger = logging.getLogger(__name__)
SECURITY_CONFIG: SecurityConfig = load_security_config()


class WorkspaceAuthRequiredError(PermissionError):
    """Raised when workspace APIs require an API key and one is not provided."""


class ApiErrorBody(BaseModel):
    code: str
    message: str
    details: object | None = None


class ApiErrorEnvelope(BaseModel):
    error: ApiErrorBody


class RunWorkflowRequest(BaseModel):
    user_prompt: str = Field(..., min_length=1)
    api_key: str | None = Field(default=None, min_length=1)
    mutable_prompt: str | None = None
    prompt_overrides: dict[str, str] | None = None
    workspace_id: str | None = None
    model: str | None = None
    recursion_limit: int = Field(default=100, ge=1, le=1000)


class RunWorkflowResponse(BaseModel):
    status: str = "DONE"
    provider: str = PROVIDER_NAME
    workspace_id: str | None = None
    plan: Plan | None = None
    task_plan: TaskPlan | None = None


class WorkspaceTreeResponse(BaseModel):
    root: str
    workspace_id: str
    expires_at: str
    nodes: list[dict[str, object]]


class WorkspaceFilesResponse(BaseModel):
    workspace_id: str
    expires_at: str
    files: dict[str, str]
    skipped_binary: list[str]


class WorkspaceFileResponse(BaseModel):
    workspace_id: str
    expires_at: str
    path: str
    content: str


class WorkspaceFileWriteRequest(BaseModel):
    path: str = Field(..., min_length=1)
    content: str
    workspace_id: str | None = None


class WorkspaceFolderCreateRequest(BaseModel):
    path: str = Field(..., min_length=1)
    workspace_id: str | None = None


class WorkspaceRenameRequest(BaseModel):
    from_path: str = Field(..., min_length=1)
    to_path: str = Field(..., min_length=1)
    overwrite: bool = False
    workspace_id: str | None = None


class WorkspaceSessionResponse(BaseModel):
    workspace_id: str
    expires_at: str


NODE_IDS = ("planner", "architect", "coder")
NODE_PHASES: dict[str, str] = {
    "planner": "planning",
    "architect": "architecture",
    "coder": "coding",
}


def _error_response(
    status_code: int,
    code: str,
    message: str,
    details: object | None = None,
) -> JSONResponse:
    payload = ApiErrorEnvelope(error=ApiErrorBody(code=code, message=message, details=details))
    return JSONResponse(status_code=status_code, content=payload.model_dump())


def _format_sse(event_name: str, payload: dict[str, object]) -> str:
    return f"event: {event_name}\ndata: {json.dumps(payload, default=str)}\n\n"


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _extract_token_text(chunk: object) -> str:
    if chunk is None:
        return ""
    if isinstance(chunk, str):
        return chunk

    content = getattr(chunk, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if text is not None:
                    parts.append(str(text))
                elif item.get("content") is not None:
                    parts.append(str(item.get("content")))
            else:
                parts.append(str(item))
        return "".join(parts)
    if content is not None:
        return str(content)

    text_attr = getattr(chunk, "text", None)
    if text_attr is not None:
        return str(text_attr)
    return str(chunk)


def _parse_langgraph_stream_item(
    item: object,
) -> tuple[tuple[str, ...] | None, str | None, object]:
    if isinstance(item, tuple):
        if len(item) == 3 and isinstance(item[1], str):
            raw_namespace = item[0]
            if raw_namespace is None:
                namespace = None
            elif isinstance(raw_namespace, tuple):
                namespace = tuple(str(part) for part in raw_namespace)
            elif isinstance(raw_namespace, list):
                namespace = tuple(str(part) for part in raw_namespace)
            else:
                namespace = (str(raw_namespace),)
            return namespace, item[1], item[2]

        if len(item) == 2 and isinstance(item[0], str):
            return None, item[0], item[1]

    return None, None, item


def _extract_node_name(payload: object, depth: int = 0) -> str | None:
    if depth > 4:
        return None

    if isinstance(payload, dict):
        for key in ("node", "name", "task_name"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value

        for key in ("data", "payload", "metadata", "state", "input", "output"):
            if key in payload:
                found = _extract_node_name(payload[key], depth + 1)
                if found:
                    return found

        for value in payload.values():
            found = _extract_node_name(value, depth + 1)
            if found:
                return found

    if isinstance(payload, (list, tuple)):
        for value in payload:
            found = _extract_node_name(value, depth + 1)
            if found:
                return found

    return None


class StreamRuntimeState:
    def __init__(self) -> None:
        self.node_iterations: dict[str, int] = {node_id: 0 for node_id in NODE_IDS}
        self.node_task_started: dict[str, float] = {}
        self.node_task_id: dict[str, str] = {}
        self.token_count = 0
        self.current_active_node: str | None = None

    def ensure_node(self, node_id: str) -> None:
        if node_id not in self.node_iterations:
            self.node_iterations[node_id] = 0


def _extract_debug_metadata(data: object) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {
            "debug_type": None,
            "step": None,
            "timestamp": None,
            "node": _extract_node_name(data),
            "task_id": None,
            "triggers": None,
            "error": None,
            "result": None,
            "interrupts": None,
            "payload": None,
        }

    payload = data.get("payload")
    payload_obj = payload if isinstance(payload, dict) else {}
    return {
        "debug_type": data.get("type"),
        "step": data.get("step"),
        "timestamp": data.get("timestamp"),
        "node": payload_obj.get("name")
        or payload_obj.get("node")
        or _extract_node_name(data),
        "task_id": payload_obj.get("id"),
        "triggers": payload_obj.get("triggers"),
        "error": payload_obj.get("error"),
        "result": payload_obj.get("result"),
        "interrupts": payload_obj.get("interrupts"),
        "payload": payload,
    }


def _summarize_update(node: str, update: object) -> dict[str, Any]:
    if not isinstance(update, dict):
        return {
            "node": node,
            "kind": type(update).__name__,
            "text": f"received {type(update).__name__} update payload",
        }

    summary: dict[str, Any] = {
        "node": node,
        "kind": "dict",
        "keys": sorted(str(key) for key in update.keys()),
    }

    current_step_idx = update.get("current_step_idx")
    if isinstance(current_step_idx, int):
        summary["current_step_idx"] = current_step_idx

    status = update.get("status")
    if isinstance(status, str):
        summary["status"] = status

    if isinstance(update.get("coder_state"), dict):
        coder_state = update["coder_state"]
        step_index = coder_state.get("current_step_idx")
        task_plan = coder_state.get("task_plan") if isinstance(coder_state.get("task_plan"), dict) else {}
        total_steps = task_plan.get("implementation_steps")
        if isinstance(step_index, int):
            summary["current_step_idx"] = step_index
        if isinstance(total_steps, list):
            summary["total_steps"] = len(total_steps)

    if isinstance(update.get("detailed_ins"), dict):
        detailed_ins = update["detailed_ins"]
        implementation_steps = (
            detailed_ins.get("implementation_steps")
            if isinstance(detailed_ins, dict)
            else None
        )
        if isinstance(implementation_steps, list):
            summary["total_steps"] = len(implementation_steps)

    if isinstance(update.get("implementation_steps"), list):
        summary["total_steps"] = len(update["implementation_steps"])

    if isinstance(update.get("plan"), dict):
        plan_files = update["plan"].get("files")
        if isinstance(plan_files, list):
            summary["planned_files"] = len(plan_files)

    if isinstance(update.get("file_path"), str):
        summary["file_path"] = update["file_path"]

    if "status" in summary:
        text = f"status={summary['status']}"
    elif "current_step_idx" in summary and "total_steps" in summary:
        completed_steps = max(0, min(int(summary["current_step_idx"]), int(summary["total_steps"])))
        active_step = min(completed_steps + 1, int(summary["total_steps"]))
        summary["completed_steps"] = completed_steps
        summary["active_step"] = active_step
        text = f"file {active_step}/{summary['total_steps']} ({completed_steps} completed)"
    elif "total_steps" in summary:
        text = f"total files={summary['total_steps']}"
    elif "planned_files" in summary:
        text = f"planned files={summary['planned_files']}"
    elif "current_step_idx" in summary:
        text = f"step index now {summary['current_step_idx']}"
    elif "keys" in summary:
        text = f"keys: {', '.join(summary['keys'][:4])}"
    else:
        text = "update payload processed"

    summary["text"] = text
    return summary


def _exception_chain(exc: BaseException, max_depth: int = 5) -> list[str]:
    chain: list[str] = []
    current: BaseException | None = exc
    depth = 0
    while current is not None and depth < max_depth:
        message = str(current).strip() or current.__class__.__name__
        chain.append(message)
        current = current.__cause__ or current.__context__
        depth += 1
    return chain


def _classify_exception(exc: BaseException) -> dict[str, str]:
    chain = _exception_chain(exc)
    merged = " ".join(chain).lower()

    if "rate limit" in merged or "429" in merged:
        return {
            "error_type": "rate_limit",
            "severity": "error",
            "hint": "Provider rate limit hit. Retry later or reduce prompt/output size.",
        }
    if any(term in merged for term in ("api key", "authentication", "unauthorized", "403", "401")):
        return {
            "error_type": "auth_error",
            "severity": "error",
            "hint": "Authentication failed. Check your X-API-KEY / api_key value.",
        }
    if any(term in merged for term in ("connection refused", "connection error", "connecterror", "timeout")):
        return {
            "error_type": "connection_error",
            "severity": "error",
            "hint": "Network connection to provider failed. Verify proxy/network settings and try again.",
        }
    if any(term in merged for term in ("context length", "max tokens", "too many tokens")):
        return {
            "error_type": "context_limit",
            "severity": "error",
            "hint": "Prompt or context is too large. Reduce prompt size or mutable overrides.",
        }
    if any(term in merged for term in ("validation", "invalid", "schema")):
        return {
            "error_type": "invalid_request",
            "severity": "error",
            "hint": "Request or model output validation failed. Check prompt constraints and retry.",
        }
    return {
        "error_type": "unknown_error",
        "severity": "error",
        "hint": "Unexpected workflow error. Inspect raw payload details for diagnosis.",
    }


def _normalize_langgraph_stream_item(
    item: object,
    runtime: StreamRuntimeState,
) -> list[tuple[str, dict[str, Any]]]:
    namespace, mode, data = _parse_langgraph_stream_item(item)
    raw = {"namespace": namespace, "mode": mode, "data": data}

    if mode is None:
        return [
            (
                "on_debug_event",
                {
                    "node": None,
                    "state": None,
                    "activity_score": 0.0,
                    "phase": "runtime",
                    "severity": "warn",
                    "kind": "parse_error",
                    "message": "Unknown stream item shape.",
                    "details": {"item_type": type(item).__name__},
                    "namespace": None,
                    "raw": item,
                },
            )
        ]

    if mode == "messages":
        chunk = data
        metadata = None
        if isinstance(data, tuple) and len(data) == 2:
            chunk, metadata = data
        runtime.token_count += 1
        active_node = runtime.current_active_node
        return [
            (
                "on_chat_model_stream",
                {
                    "node": active_node,
                    "state": None,
                    "activity_score": 0.9 if active_node else 0.0,
                    "phase": NODE_PHASES.get(active_node, "llm") if active_node else "llm",
                    "severity": "debug",
                    "message": (
                        f"Streaming model output token for '{active_node}'."
                        if active_node
                        else "Streaming model output token."
                    ),
                    "token": _extract_token_text(chunk),
                    "metadata": metadata,
                    "details": {
                        "token_index": runtime.token_count,
                        "token_length": len(_extract_token_text(chunk)),
                    },
                    "namespace": namespace,
                    "raw": raw,
                },
            )
        ]

    if mode == "updates":
        if not isinstance(data, dict):
            return [
                (
                    "on_debug_event",
                    {
                        "node": None,
                        "state": None,
                        "activity_score": 0.0,
                        "phase": "runtime",
                        "severity": "warn",
                        "kind": "parse_error",
                        "message": "`updates` mode payload was not a dict.",
                        "details": {"received_type": type(data).__name__},
                        "namespace": namespace,
                        "raw": raw,
                    },
                )
            ]
        update_events: list[tuple[str, dict[str, Any]]] = []
        for node_name, update in data.items():
            node = str(node_name)
            runtime.ensure_node(node)
            summary = _summarize_update(node, update)
            iteration = runtime.node_iterations.get(node) or None
            started_at = runtime.node_task_started.pop(node, None)
            duration_ms = int((perf_counter() - started_at) * 1000) if started_at else None
            runtime.node_task_id.pop(node, None)
            if runtime.current_active_node == node:
                runtime.current_active_node = None

            iteration_label = f" iteration {iteration}" if isinstance(iteration, int) else ""
            update_events.append(
                (
                    "on_node_end",
                    {
                        "node": node,
                        "state": "completed",
                        "activity_score": 0.2,
                        "phase": NODE_PHASES.get(node, "runtime"),
                        "severity": "info",
                        "message": (
                            f"Node '{node}'{iteration_label} completed with update payload: {summary['text']}."
                        ),
                        "details": summary,
                        "update": update,
                        "iteration": iteration,
                        "duration_ms": duration_ms,
                        "namespace": namespace,
                        "raw": raw,
                    },
                )
            )
        return update_events

    if mode == "debug":
        metadata = _extract_debug_metadata(data)
        node = metadata.get("node")
        debug_type = metadata.get("debug_type")
        step = metadata.get("step")
        task_id = metadata.get("task_id")
        events: list[tuple[str, dict[str, Any]]] = []

        if isinstance(node, str) and node.strip():
            runtime.ensure_node(node)

        should_emit_start = False
        start_message = None

        if debug_type == "task" and isinstance(node, str):
            should_emit_start = True
            start_message = "Node '{node}' is now active and thinking (iteration {iteration})."
        elif debug_type in (None, "") and isinstance(node, str) and node != runtime.current_active_node:
            # Backward-compatible fallback for generic debug payloads that carry a
            # node name but no explicit task marker.
            should_emit_start = True
            start_message = "Node '{node}' is now active and thinking."

        if should_emit_start and isinstance(node, str):
            runtime.node_iterations[node] = runtime.node_iterations.get(node, 0) + 1
            iteration = runtime.node_iterations[node]
            runtime.current_active_node = node
            runtime.node_task_started[node] = perf_counter()
            if isinstance(task_id, str):
                runtime.node_task_id[node] = task_id

            events.append(
                (
                    "on_node_start",
                    {
                        "node": node,
                        "state": "active",
                        "activity_score": 1.0,
                        "phase": NODE_PHASES.get(node, "runtime"),
                        "severity": "info",
                        "message": (start_message or "Node '{node}' is now active and thinking.").format(
                            node=node,
                            iteration=iteration,
                        ),
                        "details": {
                            "debug_type": debug_type,
                            "step": step,
                            "task_id": task_id,
                            "triggers": metadata.get("triggers"),
                            "iteration": iteration,
                        },
                        "iteration": iteration,
                        "namespace": namespace,
                        "raw": raw,
                    },
                )
            )

        duration_ms = None
        if debug_type == "task_result" and isinstance(node, str):
            started_at = runtime.node_task_started.get(node)
            if started_at is not None:
                duration_ms = int((perf_counter() - started_at) * 1000)

        debug_message = "Debug event observed from LangGraph runtime."
        if debug_type == "task" and isinstance(node, str):
            iteration = runtime.node_iterations.get(node)
            debug_message = f"LangGraph dispatched task for node '{node}' (iteration {iteration})."
        elif debug_type == "task_result" and isinstance(node, str):
            iteration = runtime.node_iterations.get(node)
            if metadata.get("error"):
                debug_message = (
                    f"LangGraph task_result for node '{node}' (iteration {iteration}) reported an error."
                )
            else:
                debug_message = (
                    f"LangGraph task_result for node '{node}' (iteration {iteration}) completed."
                )

        events.append(
            (
                "on_debug_event",
                {
                    "node": node,
                    "state": None,
                    "activity_score": 0.6 if node else 0.0,
                    "phase": NODE_PHASES.get(node, "runtime") if node else "runtime",
                    "severity": "debug",
                    "message": debug_message,
                    "details": {
                        "debug_type": debug_type,
                        "step": step,
                        "task_id": task_id,
                        "triggers": metadata.get("triggers"),
                        "error": metadata.get("error"),
                        "interrupts": metadata.get("interrupts"),
                    },
                    "iteration": runtime.node_iterations.get(node) if isinstance(node, str) else None,
                    "duration_ms": duration_ms,
                    "namespace": namespace,
                    "raw": raw,
                },
            )
        )
        return events

    return [
        (
            "on_debug_event",
            {
                "node": None,
                "state": None,
                "activity_score": 0.0,
                "phase": "runtime",
                "severity": "warn",
                "kind": "unhandled_mode",
                "mode": mode,
                "message": f"Unhandled stream mode '{mode}'.",
                "details": {"mode": mode},
                "namespace": namespace,
                "raw": raw,
            },
        )
    ]


def _validate_prompt_payload(payload: RunWorkflowRequest) -> None:
    if not payload.user_prompt.strip():
        raise ValueError("user_prompt must not be empty.")

    overrides = payload.prompt_overrides or {}
    unknown_nodes = sorted(set(overrides.keys()) - set(NODE_PROMPT_CONFIGS.keys()))
    if unknown_nodes:
        raise ValueError(
            "Invalid prompt_overrides keys. "
            f"Allowed keys: {sorted(NODE_PROMPT_CONFIGS.keys())}. "
            f"Received unknown keys: {unknown_nodes}."
        )

    if payload.mutable_prompt is not None and len(payload.mutable_prompt) > MAX_MUTABLE_PROMPT_CHARS:
        raise ValueError(
            f"mutable_prompt exceeds {MAX_MUTABLE_PROMPT_CHARS} characters. "
            f"Current length: {len(payload.mutable_prompt)}"
        )

    for node_id, value in overrides.items():
        if len(value) > MAX_MUTABLE_PROMPT_CHARS:
            raise ValueError(
                f"prompt_overrides.{node_id} exceeds {MAX_MUTABLE_PROMPT_CHARS} characters. "
                f"Current length: {len(value)}"
            )


def _resolve_api_key(payload: RunWorkflowRequest, header_api_key: str | None) -> str:
    body_token = (payload.api_key or "").strip()
    header_token = (header_api_key or "").strip()
    token = body_token or header_token
    if token:
        return token
    raise ValueError("api_key is required in body or X-API-KEY header.")


def _resolve_workspace_session(
    header_workspace_id: str | None = None,
    request_workspace_id: str | None = None,
    query_workspace_id: str | None = None,
):
    workspace_service.cleanup_expired_sessions()
    candidate = (
        (request_workspace_id or "").strip()
        or (query_workspace_id or "").strip()
        or (header_workspace_id or "").strip()
        or None
    )
    return workspace_service.resolve_workspace_session(candidate)


def _workspace_error_response(exc: Exception) -> JSONResponse:
    if isinstance(exc, workspace_service.WorkspaceValidationError):
        return _error_response(422, "workspace_validation_error", str(exc))
    if isinstance(exc, workspace_service.WorkspaceBinaryFileError):
        return _error_response(422, "workspace_binary_file", str(exc))
    if isinstance(exc, FileNotFoundError):
        return _error_response(404, "workspace_not_found", str(exc))
    if isinstance(exc, workspace_service.WorkspaceConflictError):
        return _error_response(409, "workspace_conflict", str(exc))
    message = str(exc) if SECURITY_CONFIG.expose_verbose_errors else "Workspace operation failed."
    return _error_response(500, "workspace_error", message)


def _require_workspace_auth(
    x_api_key: str | None = Header(default=None, alias="X-API-KEY"),
) -> None:
    if not SECURITY_CONFIG.require_workspace_auth:
        return
    if (x_api_key or "").strip():
        return
    raise WorkspaceAuthRequiredError(
        "Workspace API authentication required. Provide a non-empty X-API-KEY header."
    )


app = FastAPI(
    title="Intern Mini Agent API",
    description=(
        "Backend API for workflow execution and guarded prompt schema retrieval. "
        "Frontend is served separately."
    ),
)

if not SECURITY_CONFIG.cors_is_configured:
    # With an empty allowlist Starlette rejects every preflight with a bare 400
    # and no Access-Control-Allow-Origin, so the browser reports a generic
    # network failure and the API looks down rather than misconfigured. Say so
    # at boot, where it is actually diagnosable.
    logger.warning(
        "CORS is not configured: no browser origin can call this API. "
        "Set CORS_ALLOWED_ORIGINS to your frontend origin "
        "(e.g. https://your-app.vercel.app), or CORS_ALLOWED_ORIGIN_REGEX to "
        "cover preview deployments as well."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=SECURITY_CONFIG.cors_allowed_origins,
    allow_origin_regex=SECURITY_CONFIG.cors_allowed_origin_regex,
    allow_credentials=SECURITY_CONFIG.cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def handle_validation_error(_, exc: RequestValidationError):  # pragma: no cover
    return _error_response(
        status_code=422,
        code="validation_error",
        message="Request validation failed.",
        details=exc.errors(),
    )


@app.exception_handler(WorkspaceAuthRequiredError)
async def handle_workspace_auth_error(_, exc: WorkspaceAuthRequiredError):  # pragma: no cover
    return _error_response(
        status_code=401,
        code="workspace_unauthorized",
        message=str(exc),
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(_, exc: Exception):  # pragma: no cover
    logger.exception("Unhandled API error: %s", exc)
    return _error_response(
        status_code=500,
        code="internal_error",
        message="Unexpected server error.",
    )


@app.get("/health")
def health() -> dict[str, str | int | bool]:
    return {
        "status": "ok",
        "provider": PROVIDER_NAME,
        "default_model": DEFAULT_GROQ_MODEL,
        "max_mutable_prompt_chars": MAX_MUTABLE_PROMPT_CHARS,
        "max_editable_file_chars": workspace_service.MAX_EDITABLE_FILE_CHARS,
        "workspace_auth_required": SECURITY_CONFIG.require_workspace_auth,
        "app_env": SECURITY_CONFIG.app_env,
        # Lets an operator curl /health and immediately see whether a browser
        # could have reached this endpoint at all.
        "cors_configured": SECURITY_CONFIG.cors_is_configured,
    }


@app.get("/v1/prompt-policy")
def prompt_policy() -> dict[str, object]:
    return guarded_prompt_policy()


@app.get("/api/prompts")
@app.get("/prompts/schema")
@app.get("/v1/prompts/schema")
def prompts_schema() -> dict[str, object]:
    return prompt_schema()


@app.get("/graph/schema")
def graph_schema() -> dict[str, object]:
    return get_graph_schema()


@app.post("/workspace/session", response_model=WorkspaceSessionResponse)
def workspace_session_create(_auth: None = Depends(_require_workspace_auth)):
    try:
        workspace_service.cleanup_expired_sessions()
        session = workspace_service.create_session()
        return WorkspaceSessionResponse(**session.to_public())
    except Exception as exc:  # pragma: no cover
        return _workspace_error_response(exc)


@app.post("/workspace/session/{workspace_id}/touch", response_model=WorkspaceSessionResponse)
def workspace_session_touch(
    workspace_id: str,
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        workspace_service.cleanup_expired_sessions()
        session = workspace_service.touch_session(workspace_id)
        return WorkspaceSessionResponse(**session.to_public())
    except Exception as exc:
        return _workspace_error_response(exc)


@app.delete("/workspace/session/{workspace_id}")
def workspace_session_delete(
    workspace_id: str,
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        workspace_service.cleanup_expired_sessions()
        workspace_service.delete_session(workspace_id)
        return {"workspace_id": workspace_id, "deleted": True}
    except Exception as exc:
        return _workspace_error_response(exc)


@app.get("/workspace/tree", response_model=WorkspaceTreeResponse)
def workspace_tree(
    workspace_id: str | None = Query(default=None),
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            query_workspace_id=workspace_id,
        )
        return WorkspaceTreeResponse(
            root="generated_project",
            workspace_id=session.workspace_id,
            expires_at=session.expires_at.isoformat(),
            nodes=workspace_service.list_tree(workspace_id=session.workspace_id),
        )
    except Exception as exc:  # pragma: no cover
        return _workspace_error_response(exc)


@app.get("/workspace/files", response_model=WorkspaceFilesResponse)
def workspace_files(
    workspace_id: str | None = Query(default=None),
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            query_workspace_id=workspace_id,
        )
        files, skipped_binary = workspace_service.list_flat_text_files(
            workspace_id=session.workspace_id
        )
        return WorkspaceFilesResponse(
            workspace_id=session.workspace_id,
            expires_at=session.expires_at.isoformat(),
            files=files,
            skipped_binary=skipped_binary,
        )
    except Exception as exc:  # pragma: no cover
        return _workspace_error_response(exc)


@app.get("/workspace/file", response_model=WorkspaceFileResponse)
def workspace_file(
    path: str = Query(..., min_length=1),
    workspace_id: str | None = Query(default=None),
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            query_workspace_id=workspace_id,
        )
        return WorkspaceFileResponse(
            workspace_id=session.workspace_id,
            expires_at=session.expires_at.isoformat(),
            path=path,
            content=workspace_service.read_text_file(path, workspace_id=session.workspace_id),
        )
    except Exception as exc:
        return _workspace_error_response(exc)


@app.put("/workspace/file", response_model=WorkspaceFileResponse)
def workspace_file_write(
    payload: WorkspaceFileWriteRequest,
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            request_workspace_id=payload.workspace_id,
        )
        relative = workspace_service.write_text_file(
            payload.path,
            payload.content,
            workspace_id=session.workspace_id,
        )
        return WorkspaceFileResponse(
            workspace_id=session.workspace_id,
            expires_at=session.expires_at.isoformat(),
            path=relative,
            content=payload.content,
        )
    except Exception as exc:
        return _workspace_error_response(exc)


@app.post("/workspace/folder")
def workspace_folder_create(
    payload: WorkspaceFolderCreateRequest,
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            request_workspace_id=payload.workspace_id,
        )
        created = workspace_service.create_folder(payload.path, workspace_id=session.workspace_id)
        return {
            "path": created,
            "workspace_id": session.workspace_id,
            "expires_at": session.expires_at.isoformat(),
        }
    except Exception as exc:
        return _workspace_error_response(exc)


@app.post("/workspace/rename")
def workspace_path_rename(
    payload: WorkspaceRenameRequest,
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            request_workspace_id=payload.workspace_id,
        )
        renamed = workspace_service.rename_path(
            payload.from_path,
            payload.to_path,
            overwrite=payload.overwrite,
            workspace_id=session.workspace_id,
        )
        return {
            "path": renamed,
            "workspace_id": session.workspace_id,
            "expires_at": session.expires_at.isoformat(),
        }
    except Exception as exc:
        return _workspace_error_response(exc)


@app.delete("/workspace/path")
def workspace_path_delete(
    path: str = Query(..., min_length=1),
    recursive: bool = False,
    workspace_id: str | None = Query(default=None),
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            query_workspace_id=workspace_id,
        )
        deleted = workspace_service.delete_path(
            path,
            recursive=recursive,
            workspace_id=session.workspace_id,
        )
        return {
            "path": deleted,
            "workspace_id": session.workspace_id,
            "expires_at": session.expires_at.isoformat(),
        }
    except Exception as exc:
        return _workspace_error_response(exc)


@app.get("/workspace/download")
def workspace_download(
    workspace_id: str | None = Query(default=None),
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
    _auth: None = Depends(_require_workspace_auth),
):
    try:
        session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            query_workspace_id=workspace_id,
        )
        payload = workspace_service.build_workspace_zip(workspace_id=session.workspace_id)
    except Exception as exc:  # pragma: no cover
        return _workspace_error_response(exc)
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="generated_project.zip"'},
    )


@app.post("/generate", response_model=RunWorkflowResponse)
@app.post("/v1/workflows/run", response_model=RunWorkflowResponse)
async def run_agent_workflow(
    payload: RunWorkflowRequest,
    x_api_key: str | None = Header(default=None, alias="X-API-KEY"),
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
):
    run_id = str(uuid4())
    workspace_session = None

    try:
        _validate_prompt_payload(payload)
        api_key = _resolve_api_key(payload, x_api_key)
        workspace_session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            request_workspace_id=payload.workspace_id,
        )
        llm = build_chat_model(api_key=api_key, model=payload.model)
        with workspace_service.workspace_context(workspace_session.workspace_id):
            result = await run_in_threadpool(
                run_workflow,
                payload.user_prompt,
                llm,
                payload.recursion_limit,
                payload.mutable_prompt,
                payload.prompt_overrides,
                None,
            )
    except ValueError as exc:
        return _error_response(422, "invalid_request", str(exc))
    except Exception as exc:  # pragma: no cover
        logger.exception("Workflow failed run_id=%s", run_id)
        classification = _classify_exception(exc)
        message = (
            str(exc)
            if SECURITY_CONFIG.expose_verbose_errors
            else "Workflow execution failed. Check server logs with the run_id for details."
        )
        details = {
            "run_id": run_id,
            "error_type": classification["error_type"],
            "hint": classification["hint"],
        }
        if SECURITY_CONFIG.expose_verbose_errors:
            details["exception_chain"] = _exception_chain(exc)
        return _error_response(500, "workflow_error", message, details)

    return RunWorkflowResponse(
        status=result.get("status", "DONE"),
        provider=PROVIDER_NAME,
        workspace_id=workspace_session.workspace_id if workspace_session else None,
        plan=result.get("plan"),
        task_plan=result.get("detailed_ins"),
    )


@app.post("/stream")
@app.post("/v1/workflows/stream")
async def stream_agent_workflow(
    payload: RunWorkflowRequest,
    x_api_key: str | None = Header(default=None, alias="X-API-KEY"),
    x_workspace_id: str | None = Header(default=None, alias="X-Workspace-ID"),
):
    run_id = str(uuid4())
    workspace_session = None

    try:
        _validate_prompt_payload(payload)
        api_key = _resolve_api_key(payload, x_api_key)
        workspace_session = _resolve_workspace_session(
            header_workspace_id=x_workspace_id,
            request_workspace_id=payload.workspace_id,
        )
        llm = build_chat_model(api_key=api_key, model=payload.model)
    except ValueError as exc:
        return _error_response(422, "invalid_request", str(exc))

    event_id = 0
    node_states: dict[str, str] = {node_id: "idle" for node_id in NODE_IDS}
    activity_scores: dict[str, float] = {node_id: 0.0 for node_id in NODE_IDS}
    active_node_id: str | None = None

    def emit(
        event_name: str,
        payload_in: dict[str, Any],
    ) -> str:
        nonlocal event_id, active_node_id
        event_id += 1

        node = payload_in.get("node")
        state = payload_in.get("state")
        activity_score = payload_in.get("activity_score")

        if node in node_states and isinstance(state, str):
            node_states[node] = state
        if node in activity_scores and isinstance(activity_score, (float, int)):
            activity_scores[node] = float(activity_score)

        if event_name == "on_node_start" and isinstance(node, str):
            active_node_id = node
        elif event_name == "on_node_end" and isinstance(node, str) and active_node_id == node:
            active_node_id = None

        payload_out = {
            "run_id": run_id,
            "workspace_id": workspace_session.workspace_id if workspace_session else None,
            "event_id": event_id,
            "timestamp": _iso_utc_now(),
            "node": node,
            "state": state,
            "activity_score": activity_score,
            "phase": payload_in.get("phase"),
            "severity": payload_in.get("severity"),
            "message": payload_in.get("message"),
            "details": payload_in.get("details"),
            "hint": payload_in.get("hint"),
            "error_type": payload_in.get("error_type"),
            "iteration": payload_in.get("iteration"),
            "duration_ms": payload_in.get("duration_ms"),
            "namespace": payload_in.get("namespace"),
            "raw": payload_in.get("raw"),
            "active_node_id": active_node_id,
            "node_states": dict(node_states),
            "activity_by_node_id": dict(activity_scores),
            **{
                key: value
                for key, value in payload_in.items()
                if key
                not in {
                    "node",
                    "state",
                    "activity_score",
                    "phase",
                    "severity",
                    "message",
                    "details",
                    "hint",
                    "error_type",
                    "iteration",
                    "duration_ms",
                    "namespace",
                    "raw",
                }
            },
        }
        return _format_sse(event_name, payload_out)

    async def stream():
        runtime = StreamRuntimeState()
        run_started_at = perf_counter()
        yield emit(
            "run_started",
            {
                "node": None,
                "state": None,
                "activity_score": 0.0,
                "phase": "system",
                "severity": "info",
                "message": "Workflow run started with verbose stream modes: debug/messages/updates.",
                "details": {
                    "stream_mode": ["debug", "messages", "updates"],
                    "recursion_limit": payload.recursion_limit,
                },
                "namespace": None,
                "raw": None,
                "provider": PROVIDER_NAME,
            },
        )
        try:
            with workspace_service.workspace_context(
                workspace_session.workspace_id if workspace_session else None
            ):
                async for stream_item in astream_workflow(
                    payload.user_prompt,
                    llm,
                    payload.recursion_limit,
                    payload.mutable_prompt,
                    payload.prompt_overrides,
                ):
                    normalized_events = _normalize_langgraph_stream_item(stream_item, runtime)
                    for event_name, event_payload in normalized_events:
                        yield emit(event_name, event_payload)

            for node_id, state in list(node_states.items()):
                if state == "active":
                    yield emit(
                        "on_node_end",
                        {
                            "node": node_id,
                            "state": "completed",
                            "activity_score": 0.2,
                            "phase": NODE_PHASES.get(node_id, "runtime"),
                            "severity": "info",
                            "message": f"Node '{node_id}' completed with update payload.",
                            "details": {"status": "completed_on_finalize"},
                            "namespace": None,
                            "raw": {"source": "stream_finalize"},
                            "update": {"status": "completed_on_finalize"},
                        },
                    )

            yield emit(
                "run_complete",
                {
                    "node": None,
                    "state": None,
                    "activity_score": 0.0,
                    "phase": "system",
                    "severity": "info",
                    "message": "Workflow finished successfully.",
                    "details": {"run_duration_ms": int((perf_counter() - run_started_at) * 1000)},
                    "namespace": None,
                    "raw": None,
                    "status": "DONE",
                },
            )
        except Exception as exc:  # pragma: no cover
            logger.exception("Workflow stream failed run_id=%s", run_id)
            classification = _classify_exception(exc)
            exc_chain = _exception_chain(exc)
            run_duration_ms = int((perf_counter() - run_started_at) * 1000)
            error_details: dict[str, Any] = {
                "run_duration_ms": run_duration_ms,
                "run_id": run_id,
            }
            raw_error: dict[str, Any] = {
                "type": exc.__class__.__name__,
            }
            if SECURITY_CONFIG.expose_verbose_errors:
                error_details["primary_error"] = exc_chain[0] if exc_chain else None
                error_details["exception_chain"] = exc_chain
                raw_error["exception"] = str(exc)
            if active_node_id and active_node_id in node_states:
                node_states[active_node_id] = "error"
                activity_scores[active_node_id] = 0.0
            yield emit(
                "error",
                {
                    "node": active_node_id,
                    "state": "error",
                    "activity_score": 0.0,
                    "phase": "system",
                    "severity": classification["severity"],
                    "error_type": classification["error_type"],
                    "hint": classification["hint"],
                    "message": "Workflow failed during streaming.",
                    "details": error_details,
                    "namespace": None,
                    "raw": raw_error,
                },
            )

    return StreamingResponse(stream(), media_type="text/event-stream")
