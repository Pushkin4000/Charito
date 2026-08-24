import { create } from "zustand";
import { API_BASE_URL } from "@/app/lib/api-client";
import { subscribeReachability } from "@/app/lib/reachability";

/**
 * Reachability reporting for the FastAPI backend.
 *
 * There are two sources of evidence, and they are not equal:
 *
 *   1. REAL API TRAFFIC, reported through `reachability`. If any request came
 *      back — 200, 401, 500, it does not matter — the backend is up. This is
 *      the strongest signal available and it always wins.
 *   2. A synthetic GET /health probe, for the pages that make no API calls of
 *      their own (overview, reference, about). It is the weaker signal, and it
 *      is not allowed to contradict recent real traffic.
 *
 * States:
 *   unconfigured -> VITE_API_BASE_URL was never set in this build
 *   checking     -> a probe is in flight and has been fast so far
 *   waking       -> the probe has been in flight past COLD_START_HINT_MS
 *   online       -> the backend answered
 *   offline      -> nothing reached it, and no real request has either
 */

export type BackendStatus = "unconfigured" | "checking" | "waking" | "online" | "offline";

const PROBE_TIMEOUT_MS = 20_000;
const COLD_START_HINT_MS = 6_000;
const RETRY_WHEN_DOWN_MS = 15_000;
const RETRY_WHEN_UP_MS = 120_000;
/** How long a confirmed round trip keeps outranking a failed probe. */
const TRAFFIC_GRACE_MS = 60_000;

interface BackendStatusState {
  status: BackendStatus;
  detail: string | null;
  latencyMs: number | null;
  lastCheckedAt: number | null;
  lastReachableAt: number | null;
  consecutiveFailures: number;
  check: () => Promise<void>;
  startPolling: () => () => void;
}

function describeFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `No response from ${API_BASE_URL} within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s.`;
  }
  if (error instanceof TypeError) {
    // fetch() rejects with TypeError for DNS failure, connection refused, TLS
    // failure and CORS rejection alike. The browser deliberately does not tell
    // us which, so do not pretend to know.
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
  lastReachableAt: null,
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
        // NOTE: no `cache: "no-store"` here, and there must not be.
        //
        // Per the Fetch spec, a cache mode of "no-store" or "reload" makes the
        // browser append `Cache-Control: no-cache` and `Pragma: no-cache`
        // REQUEST headers. Neither is CORS-safelisted, so what should be a
        // simple cross-origin GET instead requires a preflight — a round trip
        // that no other call in this app takes, and one this probe was failing
        // on while ordinary traffic to the same origin succeeded. A query
        // parameter defeats caching without touching the headers.
        const response = await fetch(`${API_BASE_URL}/health?_=${startedAt}`, {
          method: "GET",
          signal: controller.signal,
        });

        if (!response.ok) {
          // The backend answered, so it is reachable. A bad status is a
          // backend problem, not a connectivity one, and the store's own error
          // reporting is the right place for it.
          set({
            status: "online",
            detail: `${API_BASE_URL}/health answered HTTP ${response.status}.`,
            latencyMs: Date.now() - startedAt,
            lastCheckedAt: Date.now(),
            lastReachableAt: Date.now(),
            consecutiveFailures: 0,
          });
          return;
        }

        set({
          status: "online",
          detail: null,
          latencyMs: Date.now() - startedAt,
          lastCheckedAt: Date.now(),
          lastReachableAt: Date.now(),
          consecutiveFailures: 0,
        });
      } catch (error) {
        const reachedAt = get().lastReachableAt;
        const trafficIsRecent = reachedAt !== null && Date.now() - reachedAt < TRAFFIC_GRACE_MS;

        // A failed probe never overrules a request that actually came back.
        if (trafficIsRecent) {
          set({ lastCheckedAt: Date.now() });
          return;
        }

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
      // Recovery should be quick, so a down backend is retried on a short fixed
      // interval rather than backing off into a multi-minute silence.
      const delay = get().status === "online" ? RETRY_WHEN_UP_MS : RETRY_WHEN_DOWN_MS;
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

// Real traffic outranks the probe, in both directions and immediately.
subscribeReachability((event) => {
  if (event.reachable) {
    useBackendStatus.setState({
      status: "online",
      detail: null,
      lastReachableAt: event.at,
      consecutiveFailures: 0,
    });
    return;
  }

  useBackendStatus.setState({
    status: "offline",
    detail: event.detail ?? null,
    lastCheckedAt: event.at,
  });
});

/** True when a request to the backend has no chance of succeeding right now. */
export function isBackendUnreachable(status: BackendStatus): boolean {
  return status === "offline" || status === "unconfigured";
}
