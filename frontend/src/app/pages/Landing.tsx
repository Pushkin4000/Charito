import { Fragment } from "react";
import { NavLink } from "react-router";

/* ─────────────────────────────────────────────────────────────────────────────
   Five sections, each carrying one idea, separated by hairlines and space
   rather than boxes. Nothing on this page animates: there is no scroll-
   triggered motion anywhere, because the content is meant to be read on
   arrival rather than held back for an effect.
   ───────────────────────────────────────────────────────────────────────── */

const NODES: Array<[string, string, string]> = [
  [
    "planner",
    "Plan",
    "Reads the prompt and writes a plan: a one-line summary of the app, the feature list, and the files it expects to need.",
  ],
  [
    "architect",
    "TaskPlan",
    "Breaks the plan into ordered implementation steps — one task per file path, sequenced so each file can be written given the ones before it.",
  ],
  [
    "coder",
    "Files",
    "Executes one step with read_file, list_files and write_file, then re-enters itself. It is the only node with an edge back to itself.",
  ],
];

const SPEC: Array<[string, string]> = [
  ["Runtime", "LangGraph StateGraph, three nodes"],
  ["Provider", "Groq via langchain-groq — you supply the key"],
  ["Transport", "REST for state, SSE for the run"],
  ["Workspace", "Session-scoped temp filesystem, path-validated"],
  ["Prompts", "Locked rules + node prefix + 4000 editable chars"],
  ["Licence", "MIT"],
];

const SURFACE: Array<[string, string]> = [
  [
    "Node state comes from real events",
    'Status is driven by SSE lifecycle events rather than a timer, and the coder reports its file cursor — so a long run reads as "file 4 of 9", not as a spinner.',
  ],
  [
    "Prompt layers are visible, not hidden",
    "Each node's system prompt is composed from locked global rules, a locked node prefix, and a layer you can rewrite. The locked text stays on screen, so it is obvious what you are actually changing.",
  ],
  [
    "The log stream keeps what matters",
    "Node start and end, iteration counts, durations, error types and hints. Warnings and errors are never filtered out of the view.",
  ],
  [
    "Files are editable while they are written",
    "The workspace tree refreshes during a run. Open a file, edit it in place, save it back over the API, and take the project away as a ZIP.",
  ],
];

function Specimen() {
  return (
    <div className="specimen">
      <div className="specimen__head">
        <span className="label label--quiet">agent/graph.py</span>
        <span className="label label--quiet">excerpt</span>
      </div>
      <pre>
        <span className="tok-kw">from</span> langgraph.graph <span className="tok-kw">import</span>{" "}
        StateGraph
        {"\n\n"}
        graph = StateGraph(AgentState)
        {"\n"}
        graph.add_node(<span className="tok-str">"planner"</span>, planner_node)
        {"\n"}
        graph.add_node(<span className="tok-str">"architect"</span>, architect_node)
        {"\n"}
        graph.add_node(<span className="tok-str">"coder"</span>, coder_node)
        {"\n\n"}
        graph.add_edge(<span className="tok-str">"planner"</span>,{" "}
        <span className="tok-str">"architect"</span>)
        {"\n"}
        graph.add_edge(<span className="tok-str">"architect"</span>,{" "}
        <span className="tok-str">"coder"</span>)
        {"\n\n"}
        <span className="tok-com"># coder is the only node with an edge back to itself.</span>
        {"\n"}
        <span className="tok-com"># It leaves when the step cursor runs out.</span>
        {"\n"}
        graph.add_conditional_edges(<span className="tok-str">"coder"</span>, should_continue)
      </pre>
    </div>
  );
}

export function Landing() {
  return (
    <div className="sheet" style={{ paddingTop: 88 }}>
      {/* ── Opening ───────────────────────────────────────────────────────── */}
      <section>
        <p className="label" style={{ marginBottom: 20 }}>
          Agentic coding runtime
        </p>

        <h1 className="display" style={{ maxWidth: "17ch" }}>
          A coding agent that shows its working
        </h1>

        <p className="lead" style={{ marginTop: 24, maxWidth: "62ch" }}>
          Charito turns a prompt into a working project through a planner, an architect, and a
          coder that loops until it reports <span className="tick">DONE</span>. The graph, the
          prompt layers, the log stream and the generated files stay on screen while it happens.
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 32 }}>
          <NavLink to="/studio" className="btn btn--primary btn--lg">
            Open the studio
          </NavLink>
          <NavLink to="/docs" className="btn btn--lg">
            Read the reference
          </NavLink>
        </div>
      </section>

      {/* ── The pipeline. Three ruled rows, no boxes. ──────────────────────── */}
      <section style={{ marginTop: 104 }}>
        <hr className="rule-h" style={{ marginBottom: 28 }} />
        <p className="label" style={{ marginBottom: 22 }}>
          How a run goes
        </p>

        <div>
          {NODES.map(([name, emits, body], i) => (
            <div
              key={name}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(26px, max-content) minmax(0, 1fr)",
                gap: "0 22px",
                paddingBlock: 22,
                borderTop: i === 0 ? "none" : "1px solid var(--hair)",
              }}
            >
              <span
                className="num"
                style={{ fontSize: "var(--t-small)", color: "var(--ink-4)", paddingTop: 3 }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 12,
                    flexWrap: "wrap",
                    marginBottom: 6,
                  }}
                >
                  <span
                    className="num"
                    style={{ fontSize: "var(--t-body)", fontWeight: 500, color: "var(--ink)" }}
                  >
                    {name}
                  </span>
                  <span className="label label--quiet">emits {emits}</span>
                </div>
                <p className="prose" style={{ fontSize: "var(--t-base)" }}>
                  {body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Specification against the source. ──────────────────────────────── */}
      <section className="split split--5-7" style={{ marginTop: 96 }}>
        <div>
          <p className="label" style={{ marginBottom: 16 }}>
            Specification
          </p>
          <dl className="spec">
            {SPEC.map(([term, value]) => (
              <Fragment key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
        <div style={{ minWidth: 0 }}>
          <Specimen />
        </div>
      </section>

      {/* ── What is on screen. A list, not a grid of cards. ────────────────── */}
      <section style={{ marginTop: 96 }}>
        <hr className="rule-h" style={{ marginBottom: 28 }} />
        <h2 style={{ maxWidth: "20ch", marginBottom: 12 }}>Observability is the product</h2>
        <p className="prose" style={{ marginBottom: 30 }}>
          Most coding agents give you a spinner and a diff. This one gives you the intermediate
          state, because the intermediate state is where runs actually go wrong.
        </p>

        <div style={{ borderTop: "1px solid var(--hair)" }}>
          {SURFACE.map(([title, body]) => (
            <div key={title} style={{ paddingBlock: 20, borderBottom: "1px solid var(--hair)" }}>
              <h3 style={{ marginBottom: 7 }}>{title}</h3>
              <p className="prose" style={{ fontSize: "var(--t-base)" }}>
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Close. One line, one action. ───────────────────────────────────── */}
      <section style={{ marginTop: 96 }}>
        <hr className="rule-h" style={{ marginBottom: 32 }} />
        <div
          style={{
            display: "flex",
            gap: 32,
            flexWrap: "wrap",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <div>
            <h2 style={{ maxWidth: "18ch", marginBottom: 10 }}>
              Bring a Groq key and a small prompt
            </h2>
            <p className="prose" style={{ fontSize: "var(--t-base)", maxWidth: "56ch" }}>
              The key stays in your browser. Start with something the free tier can finish in one
              pass — a single-file API, a CLI, one page of static site.
            </p>
          </div>
          <NavLink to="/studio" className="btn btn--primary btn--lg">
            Open the studio
          </NavLink>
        </div>
      </section>
    </div>
  );
}
