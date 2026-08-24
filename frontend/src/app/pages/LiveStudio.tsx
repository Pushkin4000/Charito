import { useState, useRef, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Play,
  Download,
  RefreshCw,
  FileCode2,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  X,
  Key,
  Eye,
  EyeOff,
  RotateCcw,
} from "lucide-react";
import type { NodeId, PromptNodeSchema, WorkspaceTreeNode } from "@/app/lib/api-client";
import {
  buildLockedPromptHeader,
  composePromptEditorValue,
  extractEditablePromptSuffix,
} from "@/app/store/prompt-editor";
import {
  getRememberApiKeyPreference,
  getStoredApiKey,
  saveApiKey,
} from "@/app/lib/api-key-storage";
import { useAgentStore } from "@/app/store/useAgentStore";
import { BackendPanel } from "@/app/components/BackendNotice";

/* ─────────────────────────────────────────────────────────────────────────────
   The studio runs on the dark surface — same two materials as the rest of the
   site, swapped. It is a three-pane instrument above 768px and a scrolling
   document below it, so nothing gets crushed to nothing on a phone.

   Almost everything here is still: only run state, arriving log lines and
   dialogs move. The tree, the editor, the toolbar and the tabs do not.

   Mount ids and data-agent-* attributes below are load-bearing — they are the
   stitching contract documented in README_STITCHING.md. Do not rename them.
   ───────────────────────────────────────────────────────────────────────── */

type NodeStatus = "idle" | "running" | "done" | "error";
type RightPanelTab = "graph" | "prompts";

interface FileNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: FileNode[];
}

const NODE_UI_CONFIG: Record<NodeId, { label: string; index: string; placeholder: string }> = {
  planner: {
    label: "planner",
    index: "01",
    placeholder: "Override the planner's mutable prompt body...",
  },
  architect: {
    label: "architect",
    index: "02",
    placeholder: "Override the architect's mutable prompt body...",
  },
  coder: {
    label: "coder",
    index: "03",
    placeholder: "Override the coder's mutable prompt body...",
  },
};

const SEVERITY_COLOR: Record<string, string> = {
  info: "var(--ink-2)",
  success: "var(--ok)",
  warn: "var(--warn)",
  error: "var(--bad)",
};

function toFileNodes(nodes: WorkspaceTreeNode[]): FileNode[] {
  return nodes.map((node) => ({
    name: node.name,
    path: node.path,
    type: node.type === "directory" ? "folder" : "file",
    children: node.children ? toFileNodes(node.children) : undefined,
  }));
}

function countTreeFiles(nodes: WorkspaceTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.type === "file") {
      total += 1;
      continue;
    }
    if (node.children && node.children.length > 0) {
      total += countTreeFiles(node.children);
    }
  }
  return total;
}

function toNodeStatus(value: string | undefined): NodeStatus {
  if (value === "active") return "running";
  if (value === "completed") return "done";
  if (value === "error") return "error";
  return "idle";
}

function toSeverity(value: string | undefined): "info" | "success" | "warn" | "error" {
  if (value === "error") return "error";
  if (value === "warn") return "warn";
  if (value === "success") return "success";
  return "info";
}

function toFiniteInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return null;
}

function formatLogTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString([], { hour12: false });
}

function formatLogDetails(details: Record<string, unknown> | null | undefined): string | null {
  if (!details) {
    return null;
  }
  const entries = Object.entries(details).filter(([, value]) => value !== null && value !== undefined);
  if (entries.length === 0) {
    return null;
  }
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join("  ");
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FileTreeNode({
  node,
  depth,
  activeFile,
  onOpen,
}: {
  node: FileNode;
  depth: number;
  activeFile: string | null;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);

  if (node.type === "folder") {
    return (
      <div>
        <button
          type="button"
          className="tree-row"
          onClick={() => setOpen(!open)}
          style={{ paddingLeft: 10 + depth * 13 }}
        >
          {open ? <ChevronDown size={11} strokeWidth={1.75} /> : <ChevronRight size={11} strokeWidth={1.75} />}
          {open ? <FolderOpen size={12} strokeWidth={1.75} /> : <Folder size={12} strokeWidth={1.75} />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
        </button>
        {open &&
          node.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFile={activeFile}
              onOpen={onOpen}
            />
          ))}
      </div>
    );
  }

  const isActive = activeFile === node.path;
  return (
    <button
      type="button"
      className="tree-row"
      data-active={isActive}
      data-agent-action="open-file"
      data-agent-file-path={node.path}
      onClick={() => onOpen(node.path)}
      style={{ paddingLeft: 22 + depth * 13 }}
      title={node.path}
    >
      <FileCode2 size={12} strokeWidth={1.75} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
    </button>
  );
}

/**
 * The graph, as a stacked register rather than three boxes squeezed into a
 * narrow column. The node is identified by name; colour says only what state
 * it is in, so the panel still reads correctly in greyscale.
 */
function NodeRow({
  index,
  label,
  status,
  note,
}: {
  index: string;
  label: string;
  status: NodeStatus;
  note?: string | null;
}) {
  const statusWord: Record<NodeStatus, string> = {
    idle: "Idle",
    running: "Running",
    done: "Done",
    error: "Error",
  };
  const statusColor: Record<NodeStatus, string> = {
    idle: "var(--ink-4)",
    running: "var(--accent)",
    done: "var(--ok)",
    error: "var(--bad)",
  };

  return (
    <div className="node-row" data-state={status}>
      <span className="num" style={{ fontSize: "var(--t-micro)", color: "var(--ink-4)" }}>
        {index}
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          className="num"
          style={{
            fontSize: "var(--t-small)",
            color: status === "idle" ? "var(--ink-3)" : "var(--ink)",
          }}
        >
          {label}
        </span>
        {note && (
          <span
            className="num"
            style={{ display: "block", fontSize: "var(--t-micro)", color: "var(--ink-4)", marginTop: 3 }}
          >
            {note}
          </span>
        )}
      </span>
      <span
        className={status === "running" ? "label breathe" : "label"}
        style={{ color: statusColor[status] }}
      >
        {statusWord[status]}
      </span>
    </div>
  );
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

const overlayMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.11 },
};

const dialogMotion = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 5, transition: { duration: 0.11, ease: [0.55, 0, 1, 0.45] as const } },
  transition: { duration: 0.19, ease: [0.16, 1, 0.3, 1] as const },
};

function ApiKeyModal({
  onClose,
  apiKey,
  rememberKey,
  onSave,
}: {
  onClose: () => void;
  apiKey: string;
  rememberKey: boolean;
  onSave: (key: string, remember: boolean) => void;
}) {
  const [value, setValue] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);
  const [remember, setRemember] = useState(rememberKey);

  const handleSave = () => {
    onSave(value.trim(), remember);
    onClose();
  };

  return (
    <motion.div className="overlay" {...overlayMotion} onClick={onClose}>
      <motion.div
        className="dialog"
        {...dialogMotion}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 520 }}
        role="dialog"
        aria-label="Groq API key"
      >
        <div className="dialog__head">
          <div>
            <p className="label label--quiet" style={{ marginBottom: 5 }}>
              Credentials
            </p>
            <h3>Groq API key</h3>
          </div>
          <button type="button" className="btn btn--sm btn--bare" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="dialog__body">
          <div className="notice notice--ok" style={{ marginBottom: 10 }}>
            <div className="notice__body">
              <div className="notice__title">The key stays in your browser</div>
              <p className="notice__text">
                By default it is held in <code className="tick">sessionStorage</code> and cleared
                when the browser session ends. Tick remember below to move it to{" "}
                <code className="tick">localStorage</code> instead. It is sent to the backend per
                run to build the chat model, and never persisted there.
              </p>
            </div>
          </div>

          <div className="notice notice--warn" style={{ marginBottom: 22 }}>
            <div className="notice__body">
              <div className="notice__title">Free tier has token-per-minute limits</div>
              <p className="notice__text">
                A run makes several model calls. Ask for something small and focused — a
                single-file FastAPI health check rather than a multi-module app — or the limit will
                stop the run half way.
              </p>
            </div>
          </div>

          <label className="label" htmlFor="groq-key-input" style={{ display: "block", marginBottom: 7 }}>
            Key
          </label>
          <div style={{ position: "relative", marginBottom: 14 }}>
            <input
              id="groq-key-input"
              className="field"
              type={showKey ? "text" : "password"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="gsk_..."
              style={{ paddingRight: 40 }}
              onKeyDown={(event) => event.key === "Enter" && handleSave()}
            />
            <button
              type="button"
              className="btn btn--sm btn--bare"
              onClick={() => setShowKey(!showKey)}
              aria-label={showKey ? "Hide key" : "Show key"}
              style={{ position: "absolute", right: 3, top: "50%", transform: "translateY(-50%)" }}
            >
              {showKey ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
            </button>
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              marginBottom: 16,
              fontSize: "var(--t-small)",
              color: "var(--ink-3)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            Remember this key on this device (localStorage)
          </label>

          <p className="meta">
            No key yet?{" "}
            <a className="link" href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">
              console.groq.com/keys
            </a>
          </p>
        </div>

        <div className="dialog__foot">
          <button type="button" className="btn" onClick={onClose} style={{ flex: 1 }}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={handleSave} style={{ flex: 2 }}>
            Save key
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function WorkspaceRolloverModal({
  workspaceId,
  fileCount,
  canContinueWorkspace,
  onClose,
  onContinue,
  onStartFresh,
}: {
  workspaceId: string | null;
  fileCount: number;
  canContinueWorkspace: boolean;
  onClose: () => void;
  onContinue: () => void;
  onStartFresh: () => void;
}) {
  return (
    <motion.div className="overlay" {...overlayMotion} onClick={onClose}>
      <motion.div
        className="dialog"
        {...dialogMotion}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 460 }}
        role="dialog"
        aria-label="Start a new run"
      >
        <div className="dialog__head">
          <div>
            <p className="label label--quiet" style={{ marginBottom: 5 }}>
              New run
            </p>
            <h3>Where should it write?</h3>
          </div>
          <button type="button" className="btn btn--sm btn--bare" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="dialog__body">
          <p style={{ fontSize: "var(--t-small)", lineHeight: 1.65, color: "var(--ink-2)", marginBottom: 18 }}>
            This workspace already holds files. Continuing lets the agent read and extend them; a
            fresh workspace starts from nothing.
          </p>
          <dl className="spec">
            <dt>Workspace</dt>
            <dd className="num" style={{ wordBreak: "break-all" }}>
              {workspaceId ?? "not initialized yet"}
            </dd>
            <dt>Files</dt>
            <dd className="num">{fileCount}</dd>
          </dl>
          {!canContinueWorkspace && (
            <p className="meta" style={{ marginTop: 12, color: "var(--warn)" }}>
              Continue is unavailable until a workspace session exists.
            </p>
          )}
        </div>

        <div className="dialog__foot">
          <button
            type="button"
            className="btn"
            onClick={onContinue}
            disabled={!canContinueWorkspace}
            style={{ flex: 1 }}
          >
            Continue current
          </button>
          <button type="button" className="btn btn--primary" onClick={onStartFresh} style={{ flex: 1 }}>
            Start fresh
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Prompt override panel ────────────────────────────────────────────────────

function PromptOverridePanel({
  promptSchema,
  immutableRules,
  maxMutableChars,
  overrides,
  onChange,
}: {
  promptSchema: Record<NodeId, PromptNodeSchema> | null;
  immutableRules: string[];
  maxMutableChars: number;
  overrides: Record<NodeId, string>;
  onChange: (node: NodeId, value: string) => void;
}) {
  const nodeKeys: NodeId[] = ["planner", "architect", "coder"];
  const [selectedNode, setSelectedNode] = useState<NodeId>("planner");
  const cfg = NODE_UI_CONFIG[selectedNode];
  const schemaNode = promptSchema?.[selectedNode];
  const currentOverride = overrides[selectedNode] ?? "";
  const defaultMutable = schemaNode?.default_mutable ?? "";
  const editableValue = currentOverride || defaultMutable;
  const isModified = currentOverride.trim().length > 0;
  const lockedHeader = buildLockedPromptHeader(immutableRules, schemaNode?.immutable_prefix ?? "");
  const editorValue = composePromptEditorValue(lockedHeader, editableValue);
  const overLimit = editableValue.length > maxMutableChars;

  const handleEditorChange = (nextEditorValue: string) => {
    const editableSuffix = extractEditablePromptSuffix(nextEditorValue, lockedHeader);
    if (editableSuffix === null) {
      return;
    }
    onChange(selectedNode, editableSuffix);
  };

  return (
    <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex" }}>
          {nodeKeys.map((nodeKey) => {
            const nodeCfg = NODE_UI_CONFIG[nodeKey];
            const selected = selectedNode === nodeKey;
            return (
              <button
                key={nodeKey}
                type="button"
                onClick={() => setSelectedNode(nodeKey)}
                className="num"
                style={{
                  flex: 1,
                  padding: "7px 4px",
                  border: "1px solid var(--rule)",
                  borderRightWidth: nodeKey === "coder" ? 1 : 0,
                  borderBottomWidth: 2,
                  borderBottomColor: selected ? "var(--accent)" : "var(--rule)",
                  background: selected ? "var(--surface-2)" : "transparent",
                  color: selected ? "var(--ink)" : "var(--ink-4)",
                  fontSize: "var(--t-micro)",
                  cursor: "pointer",
                  transition: "color var(--dur-fast) linear, border-color var(--dur-fast) linear",
                }}
              >
                {nodeCfg.label}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span className="label">
            {cfg.index} · {cfg.label}
            {isModified ? " · overridden" : ""}
          </span>
          {isModified && (
            <button
              type="button"
              className="btn btn--sm btn--bare"
              onClick={() => onChange(selectedNode, "")}
              title="Reset to the backend default mutable text"
            >
              <RotateCcw size={11} strokeWidth={1.75} />
              Reset
            </button>
          )}
        </div>

        <textarea
          className="field"
          value={editorValue}
          onChange={(event) => handleEditorChange(event.target.value)}
          placeholder={cfg.placeholder}
          rows={18}
          spellCheck={false}
          style={{ lineHeight: 1.7, resize: "vertical" }}
        />

        <div
          className="num"
          style={{
            fontSize: "var(--t-micro)",
            textAlign: "right",
            color: overLimit ? "var(--bad)" : "var(--ink-4)",
          }}
        >
          {editableValue.length} / {maxMutableChars}
        </div>

        <p className="meta" style={{ fontSize: "var(--t-micro)", lineHeight: 1.7, color: "var(--ink-4)" }}>
          Everything above the divider is locked. Only the text below it is sent, as{" "}
          <span style={{ color: "var(--ink-2)" }}>prompt_overrides</span> for {cfg.label}.
        </p>
      </div>
    </div>
  );
}

// ─── Studio ───────────────────────────────────────────────────────────────────

export function LiveStudio() {
  const [prompt, setPrompt] = useState("Build a minimal FastAPI health check endpoint with one GET route.");
  const [rightTab, setRightTab] = useState<RightPanelTab>("graph");
  const [showApiModal, setShowApiModal] = useState(false);
  const [showWorkspaceRolloverModal, setShowWorkspaceRolloverModal] = useState(false);
  const [apiKey, setApiKey] = useState(() => getStoredApiKey());
  const [rememberApiKey, setRememberApiKey] = useState(() => getRememberApiKeyPreference());
  const [editorContent, setEditorContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const logsContainerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const workspaceId = useAgentStore((state) => state.workspaceId);
  const workspaceExpiresAt = useAgentStore((state) => state.workspaceExpiresAt);
  const files = useAgentStore((state) => state.files);
  const skippedBinary = useAgentStore((state) => state.skippedBinary);
  const treeNodes = useAgentStore((state) => state.treeNodes);
  const activeFile = useAgentStore((state) => state.activeFilePath);
  const activeNodeId = useAgentStore((state) => state.activeNodeId);
  const logs = useAgentStore((state) => state.logs);
  const isRunning = useAgentStore((state) => state.isGenerating);
  const promptOverrides = useAgentStore((state) => state.promptOverrides);
  const nodeStatusById = useAgentStore((state) => state.nodeStatusById);
  const promptSchema = useAgentStore((state) => state.promptSchema);
  const maxMutablePromptChars = useAgentStore((state) => state.maxMutablePromptChars);
  const immutableRules = useAgentStore((state) => state.immutableRules);
  const errorMessage = useAgentStore((state) => state.errorMessage);

  const initWorkspaceSession = useAgentStore((state) => state.initWorkspaceSession);
  const resetWorkspaceSession = useAgentStore((state) => state.resetWorkspaceSession);
  const fetchFiles = useAgentStore((state) => state.fetchFiles);
  const fetchTree = useAgentStore((state) => state.fetchTree);
  const fetchGraphSchema = useAgentStore((state) => state.fetchGraphSchema);
  const fetchPromptSchema = useAgentStore((state) => state.fetchPromptSchema);
  const readFile = useAgentStore((state) => state.readFile);
  const updateFileContent = useAgentStore((state) => state.updateFileContent);
  const startAgentRun = useAgentStore((state) => state.startAgentRun);
  const resetRunVisualization = useAgentStore((state) => state.resetRunVisualization);
  const downloadWorkspaceZip = useAgentStore((state) => state.downloadWorkspaceZip);
  const setActiveFilePath = useAgentStore((state) => state.setActiveFilePath);
  const setPromptOverride = useAgentStore((state) => state.setPromptOverride);
  const lastSubmittedPromptRef = useRef(prompt.trim());
  const hasResetForPromptDraftRef = useRef(false);

  useEffect(() => {
    void (async () => {
      await initWorkspaceSession();
      await Promise.all([fetchFiles(), fetchTree(), fetchGraphSchema(), fetchPromptSchema()]);
    })();
  }, [fetchFiles, fetchGraphSchema, fetchPromptSchema, fetchTree, initWorkspaceSession]);

  useEffect(() => {
    const container = logsContainerRef.current;
    if (!container || !shouldStickToBottomRef.current) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (errorMessage?.toLowerCase().includes("workspace access requires an api key")) {
      setShowApiModal(true);
    }
  }, [errorMessage]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    void fetchTree();
    const intervalId = window.setInterval(() => {
      void fetchTree();
    }, 1200);

    return () => window.clearInterval(intervalId);
  }, [fetchTree, isRunning]);

  useEffect(() => {
    if (!activeFile) {
      setEditorContent("");
      return;
    }
    setEditorContent(files[activeFile] ?? "");
  }, [activeFile, files]);

  const handleSaveKey = (key: string, remember: boolean) => {
    const trimmed = key.trim();
    setApiKey(trimmed);
    setRememberApiKey(remember);
    saveApiKey(trimmed, remember);
  };

  const handleOverrideChange = (node: NodeId, value: string) => {
    setPromptOverride(node, value.slice(0, maxMutablePromptChars));
  };

  const handlePromptChange = (nextPrompt: string) => {
    setPrompt(nextPrompt);
    if (isRunning) {
      return;
    }

    const normalizedPrompt = nextPrompt.trim();
    const lastSubmittedPrompt = lastSubmittedPromptRef.current;
    if (normalizedPrompt === lastSubmittedPrompt) {
      hasResetForPromptDraftRef.current = false;
      return;
    }

    if (!hasResetForPromptDraftRef.current) {
      resetRunVisualization(true);
      hasResetForPromptDraftRef.current = true;
    }
  };

  const runWithWorkspaceMode = (workspaceMode: "fresh" | "continue") => {
    if (!prompt.trim() || isRunning) return;
    lastSubmittedPromptRef.current = prompt.trim();
    hasResetForPromptDraftRef.current = false;
    setShowWorkspaceRolloverModal(false);
    void startAgentRun({ userPrompt: prompt, workspaceMode });
  };

  const handleRun = () => {
    if (!prompt.trim() || isRunning) return;
    if (!getStoredApiKey()) {
      setShowApiModal(true);
      return;
    }
    if (!hasWorkspaceArtifacts) {
      runWithWorkspaceMode("continue");
      return;
    }
    setShowWorkspaceRolloverModal(true);
  };

  const handleRefresh = () => {
    void Promise.all([fetchFiles(), fetchTree()]);
  };

  const handleOpenFile = (path: string) => {
    void readFile(path);
  };

  const handleSaveFile = () => {
    if (!activeFile) return;
    setIsSaving(true);
    void updateFileContent(activeFile, editorContent).finally(() => setIsSaving(false));
  };

  const handleDownload = () => {
    void downloadWorkspaceZip();
  };

  const handleResetWorkspace = () => {
    void resetWorkspaceSession().then(() => Promise.all([fetchFiles(), fetchTree()]));
  };

  const handleLogsScroll = () => {
    const container = logsContainerRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= 48;
  };

  const fileNodes = useMemo(() => toFileNodes(treeNodes), [treeNodes]);
  const hasRun = logs.some((log) => log.event === "run_complete");
  const fileCount = useMemo(() => countTreeFiles(treeNodes), [treeNodes]);
  const hasWorkspaceArtifacts =
    Boolean(workspaceId) && (fileCount > 0 || Object.keys(files).length > 0);
  const canContinueWorkspace = Boolean(workspaceId);
  const isDirty = activeFile ? editorContent !== (files[activeFile] ?? "") : false;
  const nodeStatuses = {
    planner: toNodeStatus(nodeStatusById.planner),
    architect: toNodeStatus(nodeStatusById.architect),
    coder: toNodeStatus(nodeStatusById.coder),
  };
  const keyIsSet = apiKey.length > 0;
  const activeIteration = useMemo(() => {
    if (!activeNodeId) {
      return null;
    }
    for (let index = logs.length - 1; index >= 0; index -= 1) {
      const log = logs[index];
      if (log.node === activeNodeId && typeof log.iteration === "number") {
        return log.iteration;
      }
    }
    return null;
  }, [activeNodeId, logs]);

  const coderFileProgress = useMemo(() => {
    let totalFiles: number | null = null;
    let completedFiles = 0;

    for (let index = 0; index < logs.length; index += 1) {
      const log = logs[index];
      if (!log.details) {
        continue;
      }

      const totalSteps = toFiniteInteger(log.details.total_steps);
      if (typeof totalSteps === "number" && totalSteps > 0) {
        totalFiles = totalFiles === null ? totalSteps : Math.max(totalFiles, totalSteps);
      }

      if (log.node === "coder" && log.event === "on_node_end") {
        const currentStepIdx = toFiniteInteger(log.details.current_step_idx);
        if (typeof currentStepIdx === "number") {
          completedFiles = Math.max(completedFiles, currentStepIdx);
        }
      }
    }

    if (totalFiles === null || totalFiles <= 0) {
      return null;
    }

    const normalizedCompleted = Math.min(Math.max(completedFiles, 0), totalFiles);
    const isCoderRunning = activeNodeId === "coder" && nodeStatuses.coder === "running";
    const activeFile = isCoderRunning
      ? Math.min(normalizedCompleted + 1, totalFiles)
      : null;

    return {
      totalFiles,
      completedFiles: normalizedCompleted,
      activeFile,
    };
  }, [activeNodeId, logs, nodeStatuses.coder]);

  const activeNodeSummary = useMemo(() => {
    if (!activeNodeId) {
      return null;
    }
    if (activeNodeId === "coder" && coderFileProgress) {
      const { activeFile, completedFiles, totalFiles } = coderFileProgress;
      if (activeFile !== null) {
        return `working on file ${activeFile}/${totalFiles} (${completedFiles}/${totalFiles} completed)`;
      }
      return `${completedFiles}/${totalFiles} files completed`;
    }
    if (typeof activeIteration === "number") {
      return `iteration ${activeIteration}`;
    }
    return null;
  }, [activeIteration, activeNodeId, coderFileProgress]);

  const coderNote =
    coderFileProgress && (activeNodeId === "coder" || nodeStatuses.coder !== "idle")
      ? `${coderFileProgress.completedFiles}/${coderFileProgress.totalFiles} files${
          coderFileProgress.activeFile !== null ? ` · on ${coderFileProgress.activeFile}` : ""
        }`
      : null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "9px 12px",
          borderBottom: "1px solid var(--hair)",
          background: "var(--surface)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <textarea
          id="agent-user-prompt"
          className="field"
          value={prompt}
          onChange={(event) => handlePromptChange(event.target.value)}
          rows={1}
          spellCheck={false}
          placeholder="Describe what to build — keep it small enough for the free Groq tier"
          style={{ flex: "1 1 420px", minWidth: 240, resize: "none" }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleRun();
            }
          }}
        />

        <button
          id="agent-run-button"
          type="button"
          data-agent-action="run-agent"
          className="btn btn--primary"
          onClick={handleRun}
          disabled={isRunning || !prompt.trim()}
        >
          {isRunning ? (
            <>
              <Loader2 size={13} strokeWidth={2} className="rotate" />
              Running
            </>
          ) : (
            <>
              <Play size={12} strokeWidth={2} fill="currentColor" />
              Run
            </>
          )}
        </button>

        <button
          id="agent-download-button"
          type="button"
          data-agent-action="download-zip"
          className="btn"
          onClick={handleDownload}
          disabled={fileCount === 0}
          title="Download the workspace as a ZIP"
        >
          <Download size={13} strokeWidth={1.75} />
          <span className="hidden sm:inline">ZIP</span>
        </button>

        <button
          type="button"
          className={keyIsSet ? "btn btn--ok" : "btn btn--warn"}
          onClick={() => setShowApiModal(true)}
          title="Set the Groq API key"
        >
          <Key size={13} strokeWidth={1.75} />
          <span className="hidden sm:inline">{keyIsSet ? "Key set" : "Add key"}</span>
        </button>

        <button
          type="button"
          className="btn btn--bad"
          onClick={handleResetWorkspace}
          title="Reset the ephemeral workspace session"
        >
          <RotateCcw size={13} strokeWidth={1.75} />
          <span className="hidden sm:inline">Reset</span>
        </button>

        <div className="hidden lg:block" style={{ marginLeft: "auto", textAlign: "right" }}>
          <div className="num" style={{ fontSize: "var(--t-micro)", color: "var(--ink-4)" }}>
            ws {workspaceId ?? "initializing..."}
          </div>
          {workspaceExpiresAt && (
            <div className="num" style={{ fontSize: "var(--t-micro)", color: "var(--ink-4)" }}>
              expires {new Date(workspaceExpiresAt).toLocaleTimeString([], { hour12: false })}
            </div>
          )}
        </div>
      </div>

      {/* ── Panels ───────────────────────────────────────────────────────── */}
      <div className="studio-body">
        {/* File tree */}
        <div id="agent-file-tree" className="studio-tree">
          <div className="pane-head" style={{ justifyContent: "space-between" }}>
            <span className="label">
              Files {fileCount > 0 && <span style={{ color: "var(--ink-4)" }}>· {fileCount}</span>}
            </span>
            <button
              type="button"
              className="btn btn--sm btn--bare"
              data-agent-action="refresh-files"
              onClick={handleRefresh}
              aria-label="Refresh files"
              style={{ padding: 4 }}
            >
              <RefreshCw size={11} strokeWidth={1.75} />
            </button>
          </div>

          {fileNodes.length === 0 && (
            <p className="meta" style={{ padding: "14px 12px", color: "var(--ink-4)", lineHeight: 1.7 }}>
              Empty. Run the agent and files appear here as they are written.
            </p>
          )}

          <div style={{ paddingTop: 4 }}>
            {fileNodes.map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                depth={0}
                activeFile={activeFile}
                onOpen={handleOpenFile}
              />
            ))}
          </div>

          {skippedBinary.length > 0 && (
            <p className="meta" style={{ marginTop: 10, padding: "0 12px", fontSize: "var(--t-micro)", color: "var(--warn)" }}>
              {skippedBinary.length} binary file(s) skipped
            </p>
          )}
        </div>

        {/* Editor */}
        <div id="agent-editor" className="studio-editor">
          <div
            className="pane-head"
            style={{ background: "var(--surface)", padding: activeFile ? "0 10px 0 0" : undefined }}
          >
            {activeFile ? (
              <>
                <div
                  className="num"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    alignSelf: "stretch",
                    padding: "0 14px",
                    fontSize: "var(--t-small)",
                    color: "var(--ink)",
                    background: "var(--bg)",
                    borderRight: "1px solid var(--hair)",
                  }}
                >
                  <FileCode2 size={11} strokeWidth={1.75} />
                  <span>{activeFile.split("/").pop()}</span>
                  {isDirty && <span style={{ color: "var(--warn)" }}>•</span>}
                  <button
                    type="button"
                    onClick={() => setActiveFilePath(null)}
                    aria-label="Close file"
                    style={{
                      background: "none",
                      border: 0,
                      padding: 2,
                      cursor: "pointer",
                      color: "var(--ink-4)",
                      display: "flex",
                    }}
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                </div>
                <span
                  className="num hidden xl:inline"
                  style={{ fontSize: "var(--t-micro)", color: "var(--ink-4)", marginLeft: 12 }}
                >
                  {activeFile}
                </span>
                <button
                  type="button"
                  data-agent-action="save-file"
                  data-agent-file-path={activeFile}
                  data-agent-source-id="agent-editor-input"
                  className={isDirty ? "btn btn--sm btn--ok" : "btn btn--sm"}
                  onClick={handleSaveFile}
                  disabled={!isDirty || isSaving}
                  style={{ marginLeft: "auto" }}
                >
                  {isSaving ? "Saving" : isDirty ? "Save" : "Saved"}
                </button>
              </>
            ) : (
              <span className="label label--quiet">Editor</span>
            )}
          </div>

          <div style={{ flex: 1, overflowY: "auto", background: "var(--bg)", minHeight: 0 }}>
            {activeFile ? (
              <textarea
                id="agent-editor-input"
                value={editorContent}
                onChange={(event) => setEditorContent(event.target.value)}
                spellCheck={false}
                style={{
                  width: "100%",
                  minHeight: "100%",
                  margin: 0,
                  padding: "18px 22px",
                  fontSize: "var(--t-small)",
                  lineHeight: 1.85,
                  color: "var(--ink)",
                  fontFamily: "var(--face-mono)",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  resize: "none",
                  boxSizing: "border-box",
                  tabSize: 2,
                }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    handleSaveFile();
                  }
                }}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 32,
                }}
              >
                <p
                  className="meta"
                  style={{ color: "var(--ink-4)", textAlign: "center", maxWidth: "44ch", lineHeight: 1.75 }}
                >
                  No file open. Pick one from the tree — you can edit it while the run is still
                  going and save it straight back to the workspace.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div className="studio-aside">
          <div style={{ display: "flex", borderBottom: "1px solid var(--hair)", flexShrink: 0, background: "var(--surface)" }}>
            <button
              type="button"
              className="tab"
              data-active={rightTab === "graph"}
              onClick={() => setRightTab("graph")}
            >
              Graph &amp; logs
            </button>
            <button
              type="button"
              className="tab"
              data-active={rightTab === "prompts"}
              onClick={() => setRightTab("prompts")}
            >
              Prompts
            </button>
          </div>

          {rightTab === "graph" && (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", minHeight: 0 }}>
              {/* Graph */}
              <div id="agent-graph" style={{ borderBottom: "1px solid var(--hair)", flexShrink: 0 }}>
                <div className="pane-head">
                  <span className="label">Graph</span>
                  {isRunning && (
                    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="dot breathe" style={{ background: "var(--accent)" }} />
                      <span className="label" style={{ color: "var(--accent)" }}>
                        Live
                      </span>
                    </span>
                  )}
                </div>

                <NodeRow
                  index="01"
                  label="planner"
                  status={nodeStatuses.planner}
                  note={activeNodeId === "planner" ? activeNodeSummary : null}
                />
                <NodeRow
                  index="02"
                  label="architect"
                  status={nodeStatuses.architect}
                  note={activeNodeId === "architect" ? activeNodeSummary : null}
                />
                <NodeRow index="03" label="coder" status={nodeStatuses.coder} note={coderNote} />

                {hasRun && (
                  <div className="notice notice--ok" style={{ margin: 10 }}>
                    <div className="notice__body">
                      <div className="notice__title">Run complete</div>
                      <p className="notice__text">
                        {fileCount} file(s) in the workspace. Take them with the ZIP button.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Logs */}
              <div id="agent-logs" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
                <div className="pane-head">
                  <span className="label">Stream</span>
                  {logs.length > 0 && (
                    <span className="num" style={{ marginLeft: "auto", fontSize: "var(--t-micro)", color: "var(--ink-4)" }}>
                      {logs.length}
                    </span>
                  )}
                </div>

                <div
                  ref={logsContainerRef}
                  onScroll={handleLogsScroll}
                  style={{ flex: 1, overflowY: "auto", padding: "4px 0 12px", minHeight: 0 }}
                >
                  <BackendPanel />

                  {logs.length === 0 && (
                    <p className="meta" style={{ padding: "16px 12px", color: "var(--ink-4)", lineHeight: 1.7 }}>
                      Nothing yet. Node transitions, iteration counts, durations and errors land
                      here as the run streams.
                    </p>
                  )}

                  {logs.map((log) => {
                    const severity = toSeverity(log.severity);
                    const detailText = formatLogDetails(log.details);
                    const metaParts = [
                      typeof log.iteration === "number" ? `iter ${log.iteration}` : null,
                      typeof log.duration_ms === "number" ? `${log.duration_ms}ms` : null,
                      log.error_type ? log.error_type : null,
                    ].filter(Boolean) as string[];

                    return (
                      <motion.div
                        key={log.id}
                        className="logrow"
                        data-sev={severity}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                      >
                        <span className="num" style={{ fontSize: "var(--t-micro)", color: "var(--ink-4)" }}>
                          {formatLogTime(log.timestamp)}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <span
                            className="num"
                            style={{ fontSize: "var(--t-micro)", color: "var(--ink-4)", marginRight: 7 }}
                          >
                            {log.node ?? "system"}
                          </span>
                          <span
                            style={{
                              fontSize: "var(--t-small)",
                              lineHeight: 1.55,
                              color: SEVERITY_COLOR[severity],
                              wordBreak: "break-word",
                            }}
                          >
                            {log.message}
                          </span>
                          {metaParts.length > 0 && (
                            <div className="num" style={{ fontSize: "var(--t-micro)", color: "var(--ink-4)", marginTop: 2 }}>
                              {metaParts.join("  ")}
                            </div>
                          )}
                          {detailText && (
                            <div
                              className="num"
                              style={{
                                fontSize: "var(--t-micro)",
                                color: "var(--ink-4)",
                                marginTop: 2,
                                wordBreak: "break-word",
                              }}
                            >
                              {detailText}
                            </div>
                          )}
                          {log.hint && (
                            <div className="num" style={{ fontSize: "var(--t-micro)", color: "var(--warn)", marginTop: 2 }}>
                              {log.hint}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}

                  {errorMessage && (
                    <div className="notice notice--bad" style={{ margin: "8px 10px" }}>
                      <div className="notice__body">
                        <div className="notice__title">Error</div>
                        <p className="notice__text">{errorMessage}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {rightTab === "prompts" && (
            <PromptOverridePanel
              promptSchema={promptSchema?.nodes ?? null}
              immutableRules={immutableRules}
              maxMutableChars={maxMutablePromptChars}
              overrides={promptOverrides}
              onChange={handleOverrideChange}
            />
          )}
        </div>
      </div>

      <AnimatePresence>
        {showWorkspaceRolloverModal && (
          <WorkspaceRolloverModal
            workspaceId={workspaceId}
            fileCount={fileCount}
            canContinueWorkspace={canContinueWorkspace}
            onClose={() => setShowWorkspaceRolloverModal(false)}
            onContinue={() => runWithWorkspaceMode("continue")}
            onStartFresh={() => runWithWorkspaceMode("fresh")}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showApiModal && (
          <ApiKeyModal
            onClose={() => setShowApiModal(false)}
            apiKey={apiKey}
            rememberKey={rememberApiKey}
            onSave={handleSaveKey}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
