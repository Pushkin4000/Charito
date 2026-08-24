import { create } from "zustand";
import { API_BASE_URL } from "@/app/lib/api-client";

/**
 * Reachability probe for the FastAPI backend.
 *
 * The hosted backend runs on a Render instance that can be suspended or
 * cold-starting, so "not answering" is not the same failure as "answered with
 * an error". This module separates the two so the UI can say which one it is:
 *
 *   unconfigured -> VITE_API_BASE_URL was never set in this build
 *   checking     -> a probe is in flight and has been fast so far
 *   waking       -> the probe has been in flight past COLD_START_HINT_MS,
 *                   which is what a Render cold start looks like
 *   online       -> /health answered 2xx
 *   offline      -> the request failed, timed out, or the host answered with
 *                   a gateway/suspended status
 */

export type BackendStatus = "unconfigured" | "checking" | "waking" | "online" | "offline";

const PROBE_TIMEOUT_MS = 45_000;
const COLD_START_HINT_MS = 3_500;
const RETRY_MIN_MS = 15_000;
const RETRY_MAX_MS = 120_000;

interface BackendStatusState {
  status: BackendStatus;
  detail: string | null;
  latencyMs: number | null;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  check: () => Promise<void>;
  startPolling: () => () => void;
}

function describeFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `No response from ${API_BASE_URL} within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s.`;
  }
  if (error instanceof TypeError) {
    // fetch() rejects with TypeError for DNS failure, connection refused,
    // TLS failure and CORS rejection alike. The browser deliberately does not
    // tell us which, so do not pretend to know.
    return `The browser could not reach ${API_BASE_URL}.`;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return `The browser could not reach ${API_BASE_URL}.`;
}

let inFlight: Promise<void> | null = null;

export const useBackendStatus = create<BackendStatusState>((set, get) => ({
  status: API_BASE_URL ? "checking" : "unconfigured",
  detail: API_BASE_URL
    ? null
    : "VITE_API_BASE_URL was not set when this build was produced, so the app has no backend address to call.",
  latencyMs: null,
  lastCheckedAt: null,
  consecutiveFailures: 0,

  check: async () => {
    if (!API_BASE_URL) {
      set({ status: "unconfigured" });
      return;
    }
    if (inFlight) {
      return inFlight;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const coldStartId = window.setTimeout(() => {
      if (get().status === "checking") {
        set({ status: "waking" });
      }
    }, COLD_START_HINT_MS);

    set({ status: get().status === "online" ? "online" : "checking" });

    inFlight = (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/health`, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) {
          set({
            status: "offline",
            detail: `${API_BASE_URL}/health answered HTTP ${response.status}.`,
            latencyMs: Date.now() - startedAt,
            lastCheckedAt: Date.now(),
            consecutiveFailures: get().consecutiveFailures + 1,
          });
          return;
        }

        set({
          status: "online",
          detail: null,
          latencyMs: Date.now() - startedAt,
          lastCheckedAt: Date.now(),
          consecutiveFailures: 0,
        });
      } catch (error) {
        set({
          status: "offline",
          detail: describeFailure(error),
          latencyMs: null,
          lastCheckedAt: Date.now(),
          consecutiveFailures: get().consecutiveFailures + 1,
        });
      } finally {
        window.clearTimeout(timeoutId);
        window.clearTimeout(coldStartId);
        inFlight = null;
      }
    })();

    return inFlight;
  },

  startPolling: () => {
    let timerId: number | null = null;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      const failures = get().consecutiveFailures;
      const delay =
        get().status === "online"
          ? RETRY_MAX_MS
          : Math.min(RETRY_MIN_MS * Math.max(1, failures), RETRY_MAX_MS);
      timerId = window.setTimeout(run, delay);
    };

    const run = async () => {
      if (stopped) return;
      await get().check();
      schedule();
    };

    void run();

    return () => {
      stopped = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  },
}));

/** True when a request to the backend has no chance of succeeding right now. */
export function isBackendUnreachable(status: BackendStatus): boolean {
  return status === "offline" || status === "unconfigured";
}
