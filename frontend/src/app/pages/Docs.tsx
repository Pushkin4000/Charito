import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { API_BASE_URL } from "@/app/lib/api-client";

/* ─────────────────────────────────────────────────────────────────────────────
   Reference. A sticky contents rail, numbered sections, prose held to a 68ch
   measure, and tabular indexes for anything enumerable.

   The only motion here is the copy button's confirmation, which is the one
   place motion has something to report.
   ───────────────────────────────────────────────────────────────────────── */

const SECTIONS = [
  { id: "overview", n: "1", label: "Overview" },
  { id: "local", n: "2", label: "Running locally" },
  { id: "key", n: "3", label: "The Groq key" },
  { id: "architecture", n: "4", label: "Source map" },
  { id: "api", n: "5", label: "API" },
  { id: "prompts", n: "6", label: "Prompt layers" },
  { id: "workspace", n: "7", label: "Workspace" },
  { id: "stitching", n: "8", label: "Stitching" },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const copy = () => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      className="btn btn--sm btn--bare"
      onClick={copy}
      aria-label="Copy to clipboard"
      style={{ color: copied ? "var(--ok)" : undefined }}
    >
      {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.75} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Specimen({ code, caption }: { code: string; caption: string }) {
  return (
    <div className="specimen" style={{ marginTop: 18 }}>
      <div className="specimen__head">
        <span className="label label--quiet">{caption}</span>
        <CopyButton text={code} />
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function Section({
  id,
  n,
  title,
  children,
}: {
  id: string;
  n: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} style={{ scrollMarginTop: 20, marginBottom: 72 }}>
      <hr className="rule-h" style={{ marginBottom: 20 }} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 18 }}>
        <span className="num" style={{ fontSize: "var(--t-small)", color: "var(--ink-4)" }}>
          {n}
        </span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Endpoint({ verb, path, desc }: { verb: string; path: string; desc: string }) {
  return (
    <div
      className="index-row"
      style={{ gridTemplateColumns: "52px minmax(170px, max-content) minmax(0, 1fr)" }}
    >
      <span className="verb">{verb}</span>
      <span className="num" style={{ fontSize: "var(--t-small)", color: "var(--ink)" }}>
        {path}
      </span>
      <span className="meta">{desc}</span>
    </div>
  );
}

function Pair({ left, right }: { left: string; right: string }) {
  return (
    <div
      className="index-row"
      style={{ gridTemplateColumns: "minmax(170px, max-content) minmax(0, 1fr)" }}
    >
      <span className="num" style={{ fontSize: "var(--t-small)", color: "var(--ink)" }}>
        {left}
      </span>
      <span className="meta">{right}</span>
    </div>
  );
}

const SOURCE_MAP: Array<[string, string]> = [
  ["agent/graph.py", "Builds the nodes and edges and executes planner → architect → coder."],
  ["agent/state.py", "Typed state: plan, task steps, coder cursor."],
  ["agent/prompts.py", "Prompt composition — locked rules and prefix plus the mutable layer."],
  ["config/prompts.py", "Node prompt config and the max-mutable-chars policy constant."],
  ["agent/api.py", "FastAPI routes for run, stream, schema and workspace."],
  ["agent/workspace.py", "Session workspace: safe path resolution, TTL, ZIP export."],
  ["agent/tools.py", "Coder tools — read_file, write_file, list_files."],
  ["agent/llm_factory.py", "ChatGroq construction from provider and model config."],
  ["frontend/src/app/lib/api-client.ts", "Typed client for every backend route."],
  ["frontend/src/app/store/useAgentStore.ts", "Run lifecycle, node status, overrides, log filtering."],
];

const LAYERS: Array<[string, string]> = [
  ["Immutable rules", "Global guardrails from config/prompts.py. Highest priority, never editable."],
  ["Immutable prefix", "The node's role and hard constraints. Shown in the editor, locked."],
  ["Mutable layer", "The default body, or your prompt_overrides text. This is the part you write."],
  ["Runtime context", "The user prompt and prior node output, injected per call."],
];

export function Docs() {
  const [active, setActive] = useState(SECTIONS[0].id);
  // A click scrolls smoothly, which drags the observer across every section on
  // the way. Hold its updates until the scroll settles, so the rail does not
  // flicker down the whole list before landing.
  const suppressUntilRef = useRef(0);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < suppressUntilRef.current) return;
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target.id) {
          setActive(visible.target.id);
        }
      },
      { rootMargin: "-64px 0px -60% 0px", threshold: 0 }
    );

    for (const section of SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  const jumpTo = useCallback((event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    suppressUntilRef.current = Date.now() + 700;
    setActive(id);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    window.history.replaceState(null, "", `#${id}`);
  }, []);

  const base = API_BASE_URL || "http://localhost:8000";

  return (
    <div className="sheet" style={{ paddingTop: 56 }}>
      <div className="docs-grid">
        {/* ── Contents ──────────────────────────────────────────────────── */}
        <aside
          className="hidden lg:block"
          style={{
            position: "sticky",
            top: 20,
            alignSelf: "start",
            maxHeight: "calc(100vh - 40px)",
            overflowY: "auto",
          }}
        >
          <p className="label label--quiet" style={{ marginBottom: 12 }}>
            Contents
          </p>
          <nav>
            {SECTIONS.map((section) => (
              <a
                key={section.id}
                className="toc-link"
                href={`#${section.id}`}
                data-active={active === section.id}
                onClick={(event) => jumpTo(event, section.id)}
              >
                <span className="num" style={{ color: "var(--ink-4)" }}>
                  {section.n}
                </span>
                <span>{section.label}</span>
              </a>
            ))}
          </nav>
        </aside>

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div style={{ minWidth: 0, maxWidth: 780 }}>
          <p className="label" style={{ marginBottom: 18 }}>
            Reference
          </p>
          <h1 className="display" style={{ fontSize: "clamp(34px, 4.6vw, 54px)", maxWidth: "14ch" }}>
            How it is put together
          </h1>
          <p className="lead" style={{ marginTop: 20, marginBottom: 60, maxWidth: "58ch" }}>
            A FastAPI backend running a three-node LangGraph workflow, and a React studio that
            consumes its event stream. Everything below is inspectable in the repository.
          </p>

          <Section id="overview" n="1" title="Overview">
            <p className="prose">
              A run starts when the studio posts a prompt to <code>/stream</code>. The backend
              resolves a workspace session, builds the chat model from the key you supplied, and
              executes the graph. Lifecycle events come back over Server-Sent Events and are
              normalised into node status, log lines and file updates in a single Zustand store.
            </p>
            <p className="prose">
              The <code>planner</code> writes a plan. The <code>architect</code> turns that plan
              into ordered per-file steps. The <code>coder</code> executes one step, writes the
              file, and re-enters itself. It exits when the step cursor runs out and the run
              reports <code>DONE</code>.
            </p>
          </Section>

          <Section id="local" n="2" title="Running locally">
            <p className="prose">
              The hosted backend is a Render instance and may be suspended. Nothing about the
              frontend depends on it being up — point the app at a local backend and it behaves
              identically.
            </p>
            <Specimen
              caption="backend"
              code={`python -m venv venv
venv\\Scripts\\activate        # source venv/bin/activate on macOS/Linux
pip install -r requirements.txt
uvicorn agent.api:app --host 0.0.0.0 --port 8000 --reload`}
            />
            <Specimen
              caption="frontend"
              code={`cd frontend
npm install
VITE_API_BASE_URL=http://localhost:8000 npm run dev
# then open http://localhost:5173/studio`}
            />
            <p className="prose" style={{ marginTop: 18 }}>
              In a local dev build the client falls back to <code>http://localhost:8000</code> when{" "}
              <code>VITE_API_BASE_URL</code> is unset. In a production build a missing value is
              treated as a misconfiguration, and every request fails fast with that message rather
              than silently calling the wrong origin.
            </p>
          </Section>

          <Section id="key" n="3" title="The Groq key">
            <p className="prose">
              The provider is Groq, through <code>langchain-groq</code>. Supply a key with every
              run, either as an <code>X-API-KEY</code> header or as <code>api_key</code> in the
              request body.
            </p>

            <div style={{ display: "grid", gap: 10, marginTop: 22 }}>
              <div className="notice notice--ok">
                <div className="notice__body">
                  <div className="notice__title">Where the key lives</div>
                  <p className="notice__text">
                    The studio keeps it in <code className="tick">sessionStorage</code>, cleared
                    when the browser session ends, unless you tick remember — which moves it to{" "}
                    <code className="tick">localStorage</code>. It is sent to the backend per run
                    to construct the chat model. The workspace and session services never persist
                    it.
                  </p>
                </div>
              </div>

              <div className="notice notice--warn">
                <div className="notice__body">
                  <div className="notice__title">Free-tier limits are the usual failure</div>
                  <p className="notice__text">
                    A run makes several model calls and can stream large outputs. Free-tier
                    token-per-minute limits are the most common reason a run dies half way. Retry
                    after the cooldown with a smaller prompt.
                  </p>
                </div>
              </div>
            </div>

            <p className="label" style={{ marginTop: 30, marginBottom: 8 }}>
              Prompt sizing
            </p>
            <div style={{ borderTop: "1px solid var(--hair)" }}>
              {[
                { ok: true, text: "Build a minimal FastAPI health endpoint." },
                { ok: true, text: "Create a static to-do list app with local storage." },
                { ok: true, text: "Generate a password strength checker CLI." },
                {
                  ok: false,
                  text: "Build a complete SaaS platform with billing, auth and admin dashboards.",
                },
                {
                  ok: false,
                  text: "Generate a full-stack enterprise app with analytics, CI/CD and tests.",
                },
              ].map((tip) => (
                <div
                  key={tip.text}
                  className="index-row"
                  style={{ gridTemplateColumns: "58px minmax(0, 1fr)" }}
                >
                  <span className="label" style={{ color: tip.ok ? "var(--ok)" : "var(--bad)" }}>
                    {tip.ok ? "Fits" : "Won't"}
                  </span>
                  <span className="meta" style={{ color: "var(--ink-2)" }}>
                    {tip.text}
                  </span>
                </div>
              ))}
            </div>

            <Specimen
              caption="one run, from the shell"
              code={`# key: https://console.groq.com/keys
curl -X POST ${base}/generate \\
  -H "X-API-KEY: gsk_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"user_prompt": "A minimal FastAPI health endpoint"}'`}
            />
          </Section>

          <Section id="architecture" n="4" title="Source map">
            <p className="prose" style={{ marginBottom: 20 }}>
              Ten files carry the whole system. Read them in this order.
            </p>
            <div style={{ borderTop: "1px solid var(--hair)" }}>
              {SOURCE_MAP.map(([file, desc]) => (
                <Pair key={file} left={file} right={desc} />
              ))}
            </div>
          </Section>

          <Section id="api" n="5" title="API">
            <p className="prose" style={{ marginBottom: 24 }}>
              Routes are defined in <code>agent/api.py</code>. Versioned aliases exist for the
              workflow routes; they are the same handlers.
            </p>

            <p className="label" style={{ marginBottom: 6 }}>
              Health and schema
            </p>
            <div style={{ borderTop: "1px solid var(--hair)", marginBottom: 26 }}>
              <Endpoint verb="GET" path="/health" desc="Provider and model defaults, plus prompt and file limits" />
              <Endpoint verb="GET" path="/v1/prompt-policy" desc="Immutable prompt rules and max mutable chars" />
              <Endpoint verb="GET" path="/api/prompts" desc="Node prompt schema for planner, architect and coder" />
              <Endpoint verb="GET" path="/prompts/schema" desc="Alias" />
              <Endpoint verb="GET" path="/v1/prompts/schema" desc="Versioned alias" />
              <Endpoint verb="GET" path="/graph/schema" desc="Nodes, edges, and the UI state and activity model" />
            </div>

            <p className="label" style={{ marginBottom: 6 }}>
              Workflow
            </p>
            <div style={{ borderTop: "1px solid var(--hair)" }}>
              <Endpoint verb="POST" path="/generate" desc="Synchronous run; returns status, provider, workspace_id, plan, task_plan" />
              <Endpoint verb="POST" path="/v1/workflows/run" desc="Versioned alias for /generate" />
              <Endpoint verb="POST" path="/stream" desc="SSE run — lifecycle, debug, model-token and update events, then a terminal signal" />
              <Endpoint verb="POST" path="/v1/workflows/stream" desc="Versioned alias for /stream" />
            </div>

            <Specimen
              caption="a per-node override"
              code={`curl -X POST ${base}/generate \\
  -H "X-API-KEY: gsk_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "user_prompt": "A minimal FastAPI health endpoint",
    "prompt_overrides": {
      "coder": "Write terse, minimal code. No comments."
    }
  }'`}
            />
          </Section>

          <Section id="prompts" n="6" title="Prompt layers">
            <p className="prose" style={{ marginBottom: 22 }}>
              Every node prompt is four layers deep. Two are locked, one is yours, one is injected
              at runtime. The studio shows all four and lets you edit exactly one.
            </p>
            <div style={{ borderTop: "1px solid var(--hair)" }}>
              {LAYERS.map(([label, desc]) => (
                <Pair key={label} left={label} right={desc} />
              ))}
            </div>
            <Specimen
              caption="GET /v1/prompts/schema"
              code={`{
  "nodes": {
    "planner": {
      "immutable_prefix": "Role: PLANNER...",
      "default_mutable": "Generate a lean, tool-compliant plan."
    },
    "architect": { "..." },
    "coder": { "..." }
  },
  "policy": {
    "max_mutable_prompt_chars": 4000
  }
}`}
            />
          </Section>

          <Section id="workspace" n="7" title="Workspace">
            <p className="prose" style={{ marginBottom: 24 }}>
              Workspace data is session-scoped and lives under a temp base directory. The session
              id can arrive as a query param, in the request body, or as an{" "}
              <code>X-Workspace-ID</code> header. Absolute paths, drive-qualified paths and
              traversal escapes are rejected before they reach the filesystem.
            </p>
            <div style={{ borderTop: "1px solid var(--hair)" }}>
              <Endpoint verb="GET" path="/workspace/tree" desc="Hierarchical nodes for the active session" />
              <Endpoint verb="GET" path="/workspace/files" desc="Flat UTF-8 file map plus a skipped_binary list" />
              <Endpoint verb="GET" path="/workspace/file" desc="Read one text file. Requires ?path=" />
              <Endpoint verb="PUT" path="/workspace/file" desc="Write one text file. Body: path, content, workspace_id?" />
              <Endpoint verb="POST" path="/workspace/folder" desc="Create a folder" />
              <Endpoint verb="POST" path="/workspace/rename" desc="Rename. Body: from_path, to_path, overwrite?" />
              <Endpoint verb="DELETE" path="/workspace/path" desc="Delete a file or folder. Query: path, recursive" />
              <Endpoint verb="GET" path="/workspace/download" desc="The session, as generated_project.zip" />
            </div>
          </Section>

          <Section id="stitching" n="8" title="Stitching contract">
            <p className="prose" style={{ marginBottom: 24 }}>
              The contract in <code>README_STITCHING.md</code> pins a set of mount ids and data
              attributes, so a rendered element can be wired to a store action without knowing
              anything about the component tree. These ids are load-bearing — renaming one breaks
              the bridge.
            </p>

            <p className="label" style={{ marginBottom: 6 }}>
              Mount ids
            </p>
            <div style={{ borderTop: "1px solid var(--hair)", marginBottom: 26 }}>
              {[
                ["#agent-file-tree", "Workspace file tree panel"],
                ["#agent-editor", "Workspace editor mount"],
                ["#agent-graph", "Live graph and status mount"],
                ["#agent-logs", "Streaming log panel"],
                ["#agent-run-button", "Trigger element for runs"],
                ["#agent-download-button", "Trigger for the ZIP download"],
                ["#agent-user-prompt", "Input for the run prompt"],
              ].map(([id, desc]) => (
                <Pair key={id} left={id} right={desc} />
              ))}
            </div>

            <p className="label" style={{ marginBottom: 6 }}>
              data-agent-action
            </p>
            <div style={{ borderTop: "1px solid var(--hair)" }}>
              {[
                ["run-agent", "Reads #agent-user-prompt and calls startAgentRun()"],
                ["refresh-files", "Calls fetchFiles() and fetchTree()"],
                ["download-zip", "Calls downloadWorkspaceZip()"],
                ["open-file", "Requires data-agent-file-path; calls readFile(path)"],
                ["save-file", "Requires data-agent-file-path and data-agent-source-id"],
              ].map(([action, desc]) => (
                <Pair key={action} left={action} right={desc} />
              ))}
            </div>

            <Specimen
              caption="markup that satisfies the contract"
              code={`<button id="agent-run-button" data-agent-action="run-agent">
  Run
</button>

<div data-agent-action="open-file" data-agent-file-path="src/main.py">
  main.py
</div>

<button id="agent-download-button" data-agent-action="download-zip">
  Download ZIP
</button>`}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}
