import { NavLink } from "react-router";

/* ─────────────────────────────────────────────────────────────────────────────
   A record of what the thing is, what it runs on, and what was decided while
   building it — including the visual system, which belongs here and nowhere
   else in the app.
   ───────────────────────────────────────────────────────────────────────── */

const STACK: Array<{ area: string; items: Array<[string, string]> }> = [
  {
    area: "Backend",
    items: [
      ["LangGraph", "The workflow graph and the coder's self-loop."],
      ["FastAPI", "REST for state, SSE for the run."],
      ["Pydantic", "Plan, task plan and request/response models."],
      ["langchain-groq", "Chat model construction, per request, from your key."],
    ],
  },
  {
    area: "Frontend",
    items: [
      ["Vite + React Router", "Four routes: overview, reference, studio, about."],
      ["Zustand", "One store for graph state, logs, files and prompt overrides."],
      ["Motion", "Run state and dialogs. Nothing else moves."],
      ["Lucide", "Icons at 1.75 stroke, only where a control needs one."],
    ],
  },
  {
    area: "Runtime",
    items: [
      ["Server-Sent Events", "Normalised lifecycle, debug and incremental update events."],
      ["Session workspaces", "Per-session temp directory, path-validated, TTL cleanup."],
      ["Pytest", "Prompt schema, graph execution, streaming and workspace routes."],
      ["ZIP export", "The whole session, as generated_project.zip."],
    ],
  },
];

const DESIGN_NOTES: Array<[string, string]> = [
  [
    "Two materials",
    "The reading pages are warm uncoated paper with graphite ink. The studio is the same two materials swapped. Neither endpoint is pure — there is no #FFFFFF and no #000000 anywhere, and every grey carries a trace of warmth.",
  ],
  [
    "Colour has two jobs",
    "A Prussian blue drawn from cyanotype blueprint stock marks what is active, live, selected or focused. Three earth pigments — terre verte, raw sienna, red ochre — carry run state. Nothing else in the interface is coloured.",
  ],
  [
    "The primary action has no hue",
    "It is solid ink: graphite on paper, paper on graphite. That is the most emphatic thing this system can do, and it spends no colour to do it, which keeps chromatic pixels far under five percent.",
  ],
  [
    "Nodes are not colour-coded",
    "Planner, architect and coder are told apart by position and name. Colour says only what state they are in, so a screenshot still reads correctly in greyscale.",
  ],
  [
    "Type",
    "Instrument Sans carries the voice at two weights, 400 and 600. IBM Plex Mono carries every label, log line, file path and code block. Tracking is set per size; line-height moves inversely to it.",
  ],
  [
    "Radius is hierarchical",
    "Three pixels on things you press, zero on structure. Two values, and deliberately no third.",
  ],
  [
    "Motion",
    "Reserved for run state, arriving log lines, dialogs and pointer feedback. No section fades in on scroll anywhere in this app. That omission is the point.",
  ],
];

const DEVELOPER = {
  name: "Pushkin Ranjan",
  role: "AI/ML engineer · agentic systems",
  bio: "I build autonomous engineering systems and care mostly about whether they can be inspected when they misbehave. Charito is that idea taken as far as a single-developer project reasonably goes.",
  email: "pushkinranjan4000@gmail.com",
  linkedin: "https://linkedin.com/in/pushkin-ranjan",
  github: "https://github.com/Pushkin4000",
};

const REPO_URL = "https://github.com/Pushkin4000/Intern-Mini/tree/Deploy-branch";

function Rows({ items }: { items: Array<[string, string]> }) {
  return (
    <div style={{ borderTop: "1px solid var(--hair)" }}>
      {items.map(([left, right]) => (
        <div
          key={left}
          className="index-row"
          style={{ gridTemplateColumns: "minmax(150px, max-content) minmax(0, 1fr)" }}
        >
          <span style={{ fontSize: "var(--t-small)", fontWeight: 600, color: "var(--ink)" }}>
            {left}
          </span>
          <span className="meta" style={{ color: "var(--ink-2)", lineHeight: 1.7 }}>
            {right}
          </span>
        </div>
      ))}
    </div>
  );
}

export function About() {
  return (
    <div className="sheet" style={{ paddingTop: 56, maxWidth: 940 }}>
      <p className="label" style={{ marginBottom: 18 }}>
        About
      </p>
      <h1 className="display" style={{ fontSize: "clamp(34px, 4.6vw, 54px)", maxWidth: "15ch" }}>
        What this is, and what it runs on
      </h1>
      <p className="lead" style={{ marginTop: 20, maxWidth: "58ch" }}>
        Charito is a three-node LangGraph workflow with a studio wrapped around it. The interesting
        part is not that it generates code — plenty of things do. It is that you can watch the run
        while it happens and change the prompts that drive it.
      </p>

      {/* ── Why ─────────────────────────────────────────────────────────── */}
      <section style={{ marginTop: 76 }}>
        <hr className="rule-h" style={{ marginBottom: 26 }} />
        <h2 style={{ marginBottom: 16 }}>Why it is built this way</h2>
        <p className="prose">
          Coding agents fail in the middle. The plan was wrong, or the file order was wrong, or the
          provider rate-limited on the fourth call and everything after it is garbage. If all you
          get is a spinner and a final diff, you find out at the end and cannot say which.
        </p>
        <p className="prose">
          So the intermediate state is the interface. Node status comes from real lifecycle events,
          not a timer. The log stream keeps every warning and error even when the rest is filtered.
          The file tree refreshes during the run. The prompt editor shows the locked layers next to
          the one you can rewrite, so it is obvious what you are actually changing.
        </p>
        <p className="prose">
          The workspace is deliberately small and deliberately fenced: a temp directory per
          session, path validation at the boundary, a TTL, and a reset that aborts a live run
          cleanly. Nothing the agent writes escapes it.
        </p>
      </section>

      {/* ── Stack ───────────────────────────────────────────────────────── */}
      <section style={{ marginTop: 76 }}>
        <hr className="rule-h" style={{ marginBottom: 26 }} />
        <h2 style={{ marginBottom: 26 }}>Stack</h2>
        <div style={{ display: "grid", gap: 30 }}>
          {STACK.map((group) => (
            <div key={group.area}>
              <p className="label" style={{ marginBottom: 8 }}>
                {group.area}
              </p>
              <Rows items={group.items} />
            </div>
          ))}
        </div>
      </section>

      {/* ── Design notes ────────────────────────────────────────────────── */}
      <section style={{ marginTop: 76 }}>
        <hr className="rule-h" style={{ marginBottom: 26 }} />
        <h2 style={{ marginBottom: 12 }}>Design notes</h2>
        <p className="prose" style={{ marginBottom: 26 }}>
          Every value in the interface traces to something. That is the only test that reliably
          separates a decision from a default.
        </p>
        <Rows items={DESIGN_NOTES} />
      </section>

      {/* ── Who ─────────────────────────────────────────────────────────── */}
      <section style={{ marginTop: 76 }}>
        <hr className="rule-h" style={{ marginBottom: 26 }} />
        <h2 style={{ marginBottom: 22 }}>Who made it</h2>
        <div
          className="split split--5-7"
          style={{ gap: "28px clamp(28px, 4vw, 48px)" }}
        >
          <div>
            <div style={{ fontSize: "var(--t-lead)", fontWeight: 600, color: "var(--ink)", marginBottom: 4 }}>
              {DEVELOPER.name}
            </div>
            <p className="label" style={{ marginBottom: 16 }}>
              {DEVELOPER.role}
            </p>
            <p className="prose" style={{ fontSize: "var(--t-base)" }}>
              {DEVELOPER.bio}
            </p>
          </div>
          <div>
            <p className="label label--quiet" style={{ marginBottom: 10 }}>
              Contact
            </p>
            <div style={{ borderTop: "1px solid var(--hair)" }}>
              {[
                ["Email", DEVELOPER.email, `mailto:${DEVELOPER.email}`],
                ["LinkedIn", "pushkin-ranjan", DEVELOPER.linkedin],
                ["GitHub", "Pushkin4000", DEVELOPER.github],
              ].map(([label, value, href]) => (
                <a
                  key={label}
                  href={href}
                  target={href.startsWith("mailto:") ? undefined : "_blank"}
                  rel="noopener noreferrer"
                  className="index-row"
                  style={{
                    gridTemplateColumns: "84px minmax(0, 1fr)",
                    textDecoration: "none",
                    color: "inherit",
                  }}
                >
                  <span className="label label--quiet">{label}</span>
                  <span className="meta" style={{ color: "var(--ink)", wordBreak: "break-all" }}>
                    {value}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      <section style={{ marginTop: 64 }}>
        <hr className="rule-h" style={{ marginBottom: 28 }} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <NavLink to="/studio" className="btn btn--primary btn--lg">
            Open the studio
          </NavLink>
          <NavLink to="/docs" className="btn btn--lg">
            Read the reference
          </NavLink>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="btn btn--lg">
            Source on GitHub
          </a>
        </div>
      </section>
    </div>
  );
}
