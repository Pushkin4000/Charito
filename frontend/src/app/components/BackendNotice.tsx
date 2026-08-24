import { useEffect, useState } from "react";
import { RefreshCw, ChevronDown } from "lucide-react";
import { API_BASE_URL } from "@/app/lib/api-client";
import { useBackendStatus } from "@/app/lib/backend-status";

const LOCAL_RECIPE = `uvicorn agent.api:app --port 8000
VITE_API_BASE_URL=http://localhost:8000 npm run dev`;

/** Starts the reachability poll once, for the lifetime of the app shell. */
export function useBackendProbe() {
  const startPolling = useBackendStatus((state) => state.startPolling);
  useEffect(() => startPolling(), [startPolling]);
}

interface Copy {
  tone: "bad" | "warn";
  tag: string;
  title: string;
  body: string;
}

const COPY: Record<string, Copy> = {
  offline: {
    tone: "bad",
    tag: "Offline",
    title: "The backend is not answering",
    body:
      "Nothing reached it on the last few attempts, so runs, workspace sessions and file operations will fail. It may be restarting. Every page on this site is static and still works meanwhile.",
  },
  blocked: {
    tone: "bad",
    tag: "CORS",
    title: "The backend is up, but rejecting this origin",
    body:
      "It answered the request and then withheld an Access-Control-Allow-Origin header, so the browser discarded the response. This is a backend configuration problem, not a connectivity one — add this site's origin to CORS_ALLOWED_ORIGINS on the backend.",
  },
  unconfigured: {
    tone: "bad",
    tag: "Not configured",
    title: "No backend address in this build",
    body:
      "VITE_API_BASE_URL was not set when this build was produced, so the app has nowhere to send API calls. Set it to the deployed backend URL and rebuild.",
  },
  waking: {
    tone: "warn",
    tag: "Waking",
    title: "The backend is slow to answer",
    body:
      "The first request is taking longer than usual — holding the connection open. If the instance is starting up this can take up to a minute.",
  },
};

/**
 * Site-wide reachability bar. Renders nothing while the backend answers, so it
 * costs no attention on the happy path.
 */
export function BackendBar() {
  const status = useBackendStatus((state) => state.status);
  const detail = useBackendStatus((state) => state.detail);
  const check = useBackendStatus((state) => state.check);
  const [expanded, setExpanded] = useState(false);

  const copy = COPY[status];
  if (!copy) {
    return null;
  }

  const accent = copy.tone === "bad" ? "var(--bad)" : "var(--warn)";
  const wash = copy.tone === "bad" ? "var(--bad-soft)" : "var(--warn-soft)";

  return (
    <div
      role="status"
      style={{ borderBottom: "1px solid var(--hair)", background: wash, flexShrink: 0 }}
    >
      <div
        className="sheet"
        style={{ display: "flex", alignItems: "center", gap: 12, paddingBlock: 9, flexWrap: "wrap" }}
      >
        <span className="label" style={{ color: accent, flexShrink: 0 }}>
          {copy.tag}
        </span>
        <span style={{ fontSize: "var(--t-small)", color: "var(--ink-2)", flex: "1 1 300px", minWidth: 0 }}>
          <strong style={{ fontWeight: 600, color: "var(--ink)" }}>{copy.title}.</strong> {copy.body}
        </span>
        <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className="btn btn--sm btn--bare"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <ChevronDown
              size={12}
              strokeWidth={1.75}
              style={{
                transform: expanded ? "rotate(180deg)" : "none",
                transition: "transform var(--dur-fast) linear",
              }}
            />
            Details
          </button>
          {status !== "unconfigured" && (
            <button type="button" className="btn btn--sm" onClick={() => void check()}>
              <RefreshCw size={12} strokeWidth={1.75} />
              Retry
            </button>
          )}
        </span>
      </div>

      {expanded && (
        <div className="sheet" style={{ paddingBottom: 16 }}>
          <hr className="rule-h" style={{ marginBottom: 14 }} />
          <BackendDetail detail={detail} blocked={status === "blocked"} />
        </div>
      )}
    </div>
  );
}

/** The technical half of the message: what was tried, and what to do instead. */
export function BackendDetail({ detail, blocked = false }: { detail: string | null; blocked?: boolean }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-app.vercel.app";
  const recipe = blocked
    ? `CORS_ALLOWED_ORIGINS=${origin}
# or, to cover preview deploys too:
CORS_ALLOWED_ORIGIN_REGEX=^https://.*\.vercel\.app$`
    : LOCAL_RECIPE;
  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" }}>
      <div>
        <div className="label label--quiet" style={{ marginBottom: 6 }}>
          Probe
        </div>
        <div className="meta" style={{ color: "var(--ink-2)", wordBreak: "break-all" }}>
          GET {API_BASE_URL || "(unset)"}/health
        </div>
        {detail && (
          <div className="meta" style={{ marginTop: 4, color: "var(--ink-4)" }}>
            {detail}
          </div>
        )}
      </div>
      <div>
        <div className="label label--quiet" style={{ marginBottom: 6 }}>
          {blocked ? "Set this on the backend" : "Run it locally instead"}
        </div>
        <pre
          className="meta"
          style={{
            margin: 0,
            padding: "9px 11px",
            border: "1px solid var(--hair)",
            borderRadius: "var(--r-control)",
            background: "var(--bg)",
            color: "var(--ink-2)",
            overflowX: "auto",
          }}
        >
{recipe}
        </pre>
      </div>
    </div>
  );
}

/**
 * Block form for the studio, where an unreachable backend is not an aside —
 * it is the reason nothing on the screen is going to move.
 */
export function BackendPanel() {
  const status = useBackendStatus((state) => state.status);
  const detail = useBackendStatus((state) => state.detail);
  const check = useBackendStatus((state) => state.check);

  const copy = COPY[status];
  if (!copy) {
    return null;
  }

  return (
    <div className={`notice notice--${copy.tone}`} style={{ margin: 10 }}>
      <div className="notice__body">
        <div className="notice__title">{copy.title}</div>
        <p className="notice__text" style={{ marginBottom: 12 }}>
          {copy.body}
        </p>
        <BackendDetail detail={detail} blocked={status === "blocked"} />
        {status !== "unconfigured" && (
          <button type="button" className="btn btn--sm" style={{ marginTop: 12 }} onClick={() => void check()}>
            <RefreshCw size={12} strokeWidth={1.75} />
            Retry probe
          </button>
        )}
      </div>
    </div>
  );
}
