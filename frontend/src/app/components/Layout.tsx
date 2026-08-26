import { useState, useEffect } from "react";
import { Outlet, NavLink, useLocation } from "react-router";
import { motion, AnimatePresence } from "motion/react";
import { Menu, X } from "lucide-react";
import { BackendBar, useBackendProbe } from "@/app/components/BackendNotice";
import { useBackendStatus, type BackendStatus } from "@/app/lib/backend-status";

const NAV = [
  { to: "/", label: "Overview" },
  { to: "/docs", label: "Reference" },
  { to: "/studio", label: "Studio" },
  { to: "/about", label: "About" },
];

const REPO_URL = "https://github.com/Pushkin4000/Intern-Mini/tree/Deploy-branch";

/**
 * Reachability tell in the header.
 *
 * It reports only what has actually been observed. `checking` and `waking` both
 * mean the app has no evidence yet, and neither earns a place in the header: a
 * cautious-looking dot on every cold load is a worse lie than silence, because
 * it reads as a fault to anyone who did not write it. The tell appears when
 * there is something real to say -- the backend answered, or it demonstrably
 * did not.
 */
const TELL: Partial<Record<BackendStatus, { color: string; text: string }>> = {
  online: { color: "var(--ok)", text: "API online" },
  offline: { color: "var(--bad)", text: "API offline" },
  blocked: { color: "var(--bad)", text: "CORS blocked" },
  unconfigured: { color: "var(--bad)", text: "No API URL" },
};

function StatusTell() {
  const status = useBackendStatus((state) => state.status);

  const current = TELL[status];
  if (!current) {
    return null;
  }

  return (
    <span
      title={`Backend status: ${status}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
    >
      <span className="dot" style={{ background: current.color }} />
      <span style={{ fontSize: "var(--t-small)", color: "var(--ink-3)" }}>{current.text}</span>
    </span>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useBackendProbe();

  useEffect(() => {
    setMobileOpen(false);
    window.scrollTo(0, 0);
  }, [location.pathname]);

  const isStudio = location.pathname === "/studio";

  return (
    <div
      className={[
        "app-shell",
        // The studio is a fixed-height instrument on wide screens and a
        // scrolling document on narrow ones; the class carries that rule.
        isStudio ? "app-shell--fixed surface-dark" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* ── Header. Static, not fixed and not blurred: it is the top of the
          document and it scrolls away like one. ─────────────────────────── */}
      <header style={{ borderBottom: "1px solid var(--hair)", flexShrink: 0 }}>
        <div className="sheet" style={{ height: 56, display: "flex", alignItems: "center", gap: 24 }}>
          <NavLink
            to="/"
            style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none", flexShrink: 0 }}
          >
            <Mark />
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                letterSpacing: "-0.018em",
                color: "var(--ink)",
              }}
            >
              Charito
            </span>
          </NavLink>

          <nav className="hidden md:flex" style={{ alignItems: "center", gap: 20 }}>
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => (isActive ? "nav-link is-active" : "nav-link")}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
            <span className="hidden sm:inline-flex">
              <StatusTell />
            </span>
            <a className="nav-link hidden md:inline" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            {!isStudio && (
              <span className="hidden md:inline-flex">
                <NavLink to="/studio" className="btn btn--primary btn--sm">
                  Open studio
                </NavLink>
              </span>
            )}
            <span className="md:hidden">
              <button
                type="button"
                className="btn btn--sm btn--bare"
                onClick={() => setMobileOpen((value) => !value)}
                aria-label={mobileOpen ? "Close menu" : "Open menu"}
                aria-expanded={mobileOpen}
              >
                {mobileOpen ? <X size={18} strokeWidth={1.75} /> : <Menu size={18} strokeWidth={1.75} />}
              </button>
            </span>
          </div>
        </div>

        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.19, ease: [0.16, 1, 0.3, 1] }}
              className="md:hidden"
              style={{ overflow: "hidden", borderTop: "1px solid var(--hair)" }}
            >
              <div className="sheet" style={{ paddingBlock: 6 }}>
                {NAV.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === "/"}
                    className={({ isActive }) => (isActive ? "nav-link is-active" : "nav-link")}
                    style={{
                      display: "block",
                      padding: "12px 0",
                      fontSize: "var(--t-base)",
                      borderBottom: "1px solid var(--hair)",
                    }}
                  >
                    {item.label}
                  </NavLink>
                ))}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingBlock: 14 }}>
                  <StatusTell />
                  <a className="nav-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
                    GitHub
                  </a>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <BackendBar />

      <main style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Outlet />
      </main>

      {!isStudio && (
        <footer style={{ borderTop: "1px solid var(--hair)", marginTop: 104 }}>
          <div
            className="sheet"
            style={{
              paddingBlock: 26,
              display: "flex",
              flexWrap: "wrap",
              gap: "12px 32px",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: "var(--t-small)", color: "var(--ink-3)" }}>
              Charito — the agentic coding platform for tinkerers.
            </span>
            <span className="meta" style={{ color: "var(--ink-4)" }}>
              LangGraph · FastAPI · Groq · React
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 20, alignItems: "center" }}>
              <NavLink className="nav-link" to="/docs">
                Reference
              </NavLink>
              <a className="nav-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
                Source
              </a>
            </span>
          </div>
        </footer>
      )}
    </div>
  );
}

/** Three rules, shortest last: plan, steps, files. The favicon uses the same mark. */
function Mark() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
      <rect x="1" y="3" width="14" height="1.6" fill="currentColor" opacity="0.85" />
      <rect x="1" y="7.2" width="9.5" height="1.6" fill="currentColor" opacity="0.55" />
      <rect x="1" y="11.4" width="5" height="1.6" fill="currentColor" opacity="0.3" />
    </svg>
  );
}
