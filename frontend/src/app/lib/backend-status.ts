import { create } from "zustand";
import { API_BASE_URL, apiClient } from "@/app/lib/api-client";
import { subscribeReachability } from "@/app/lib/reachability";

/**
 * Reachability reporting for the FastAPI backend.
 *
 * There are two sources of evidence, and they are not equal:
 *
 *   1. REAL API TRAFFIC, reported through `reachability`. If any request came
 *      back — 200, 401, 500, it does not matter — the backend is up. This is
 *      the strongest signal available and it always wins.
 *   2. A GET /health probe, for the pages that make no API calls of their own
 *      (overview, reference, about). It is the weaker signal, and it is not
 *      allowed to contradict recent real traffic.
 *
 * THE PROBE GOES THROUGH `apiClient`, AND MUST. It used to be a bare `fetch`,
 * and twice that earned a bug where the probe failed against a backend that
 * ordinary traffic was reaching perfectly — first a `cache: "no-store"` that
 * forced a preflight (fixed in 234ef09), then a divergence that left the
 * overview page pinned to "waking" while the studio, one navigation away, went
 * online instantly off its very first request.
 *
 * The pattern is the defect, not either instance of it: a probe shaped
 * differently from real traffic tests a path that no real traffic takes, so it
 * can fail in ways nothing else does and report an outage that is not there.
 * Sharing the axios instance makes the probe *be* real traffic — same headers,
 * same interceptors, same CORS shape — so it cannot disagree with the requests
 * it is meant to be predicting.
 *
 * COLD STARTS. The backend is a free-tier Render service: it is suspended after
 * fifteen idle minutes and takes appreciably longer to boot than a single probe
 * is willing to wait. A probe that fails before the backend has *ever* answered
 * in this session is therefore not evidence of an outage — it is the expected
 * shape of a first visit. Until the cold-start budget is spent, such a failure
 * reports `waking`, not `offline`. A CORS rejection is exempt: the server
 * answered, so it is awake, and the verdict is immediate.
 *
 * States:
 *   unconfigured -> VITE_API_BASE_URL was never set in this build
 *   checking     -> a probe is in flight and has been fast so far
 *   waking       -> the probe is slow, or is failing inside the cold-start budget
 *   online       -> the backend answered
 *   offline      -> nothing reached it, no real request has either, and the
 *                   cold-start budget is spent
 */

export type BackendStatus =
  | "unconfigured"
  | "checking"
  | "waking"
  | "online"
  | "blocked"
  | "offline";

const PROBE_TIMEOUT_MS = 20_000;
const COLD_START_HINT_MS = 6_000;
const CORS_CHECK_TIMEOUT_MS = 8_000;
const RETRY_WHEN_DOWN_MS = 15_000;
const RETRY_WHEN_UP_MS = 120_000;
/** Probe often while waking: a cold instance can come up at any moment. */
const RETRY_WHEN_WAKING_MS = 5_000;
/** How long a confirmed round trip keeps outranking a failed probe. */
const TRAFFIC_GRACE_MS = 60_000;
/**
 * How long after boot a still-unreachable backend is called "waking" instead of
 * "offline". Render's free plan routinely needs 30-60s to resume a suspended
 * service, so anything under a minute produces a red banner on every first
 * visit that then clears itself — which is exactly the noise this budget
 * exists to prevent. Past it, the backend really is not answering, and saying
 * so is the honest report.
 */
const COLD_START_BUDGET_MS = 90_000;

interface BackendStatusState {
  status: BackendStatus;
  detail: string | null;
  latencyMs: number | null;
  lastCheckedAt: number | null;
  lastReachableAt: number | null;
  /** When this tab started caring about the backend; origin of the budget. */
  bootedAt: number;
  consecutiveFailures: number;
  check: () => Promise<void>;
  startPolling: () => () => void;
}

function describeFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return `No response from ${API_BASE_URL} within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s.`;
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
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

/**
 * A browser deliberately refuses to say whether a failed cross-origin fetch was
 * a dead host or a CORS rejection — both surface as the same bare TypeError.
 *
 * A `no-cors` request tells them apart: the response is opaque and unreadable,
 * but it only resolves if the server actually answered. Resolving therefore
 * means the host is up and the earlier failure was the CORS policy; rejecting
 * means nothing is there at all.
 */
async function serverAnsweredDespiteCors(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), CORS_CHECK_TIMEOUT_MS);
  try {
    await fetch(`${API_BASE_URL}/health?_=${Date.now()}`, {
      method: "GET",
      mode: "no-cors",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/**
 * True while a failure is still better explained by a booting backend than by a
 * dead one: nothing has reached it yet in this session, and the budget is live.
 * Once anything has come back, the backend has proved it exists and later
 * failures are reported at face value.
 */
function mayStillBeWaking(): boolean {
  const { lastReachableAt, bootedAt } = useBackendStatus.getState();
  return lastReachableAt === null && Date.now() - bootedAt < COLD_START_BUDGET_MS;
}

/**
 * The probe currently running, so overlapping callers share one round trip.
 *
 * It is cleared in the probe's own `finally`, which is why the body below is
 * started on a microtask rather than invoked inline. Called inline, a body that
 * runs to completion synchronously -- a `fetch` that THROWS rather than
 * returning a rejected promise, which is what a blocked or intercepted request
 * does -- reaches its `finally` and nulls this before the assignment that sets
 * it has even finished. The assignment then lands on top, leaving a settled
 * promise here for good, and from that moment every `check()` short-circuits on
 * it and no probe ever runs again: the status freezes at whatever that first
 * attempt produced, with the poller still faithfully calling a function that
 * can no longer do anything.
 */
let inFlight: Promise<void> | null = null;

export const useBackendStatus = create<BackendStatusState>((set, get) => ({
  status: API_BASE_URL ? "checking" : "unconfigured",
  detail: API_BASE_URL
    ? null
    : "VITE_API_BASE_URL was not set when this build was produced, so the app has no backend address to call.",
  latencyMs: null,
  lastCheckedAt: null,
  lastReachableAt: null,
  bootedAt: Date.now(),
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
    const coldStartId = window.setTimeout(() => {
      if (get().status === "checking") {
        set({ status: "waking" });
      }
    }, COLD_START_HINT_MS);

    // The status is deliberately left alone while the new probe runs: dropping
    // back to "checking" on every retry made the banner blink out and back in.
    // The initial state is already "checking", so the first probe reads right.

    // Deferred to a microtask so the assignment below always wins the race
    // against this body's `finally`. See the note on `inFlight`.
    inFlight = Promise.resolve().then(async () => {
      try {
        // The cache-busting parameter stays in the query string rather than in
        // a Cache-Control header: request headers that are not CORS-safelisted
        // force a preflight, which is what broke this probe in 234ef09.
        await apiClient.get("/health", {
          params: { _: startedAt },
          timeout: PROBE_TIMEOUT_MS,
        });

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

        // A non-2xx still reaches the response interceptor, which reports the
        // round trip and flips the store online before this catch runs. The
        // backend answered; a bad status is its problem to report, not
        // connectivity's. The timestamp must be compared against this probe's
        // own start -- "the store is online" alone would also match a stale
        // success from minutes ago and could never report a real outage.
        if (reachedAt !== null && reachedAt >= startedAt) {
          set({ lastCheckedAt: Date.now(), latencyMs: Date.now() - startedAt });
          return;
        }

        const trafficIsRecent = reachedAt !== null && Date.now() - reachedAt < TRAFFIC_GRACE_MS;

        // A failed probe never overrules a request that actually came back.
        if (trafficIsRecent) {
          set({ lastCheckedAt: Date.now() });
          return;
        }

        // A timeout is a timeout; anything else may be a CORS rejection, so
        // ask. Axios reports both as plain Errors, so the old `instanceof
        // TypeError` test no longer distinguishes them and must not be used.
        const timedOut = error instanceof Error && /timeout/i.test(error.message);
        if (!timedOut && (await serverAnsweredDespiteCors())) {
          const origin = typeof window !== "undefined" ? window.location.origin : "this origin";
          set({
            status: "blocked",
            detail: `${API_BASE_URL} answered, but did not return an Access-Control-Allow-Origin header for ${origin}.`,
            latencyMs: null,
            lastCheckedAt: Date.now(),
            consecutiveFailures: get().consecutiveFailures + 1,
          });
          return;
        }

        set({
          // A first visit to a suspended instance fails exactly like an outage
          // does; only the clock tells them apart.
          status: mayStillBeWaking() ? "waking" : "offline",
          detail: describeFailure(error),
          latencyMs: null,
          lastCheckedAt: Date.now(),
          consecutiveFailures: get().consecutiveFailures + 1,
        });
      } finally {
        window.clearTimeout(coldStartId);
        inFlight = null;
      }
    });

    return inFlight;
  },

  startPolling: () => {
    let timerId: number | null = null;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      // Recovery should be quick, so a down backend is retried on a short fixed
      // interval rather than backing off into a multi-minute silence — and a
      // waking one faster still, since it may finish booting at any moment.
      const status = get().status;
      const delay =
        status === "online"
          ? RETRY_WHEN_UP_MS
          : status === "waking" || status === "checking"
            ? RETRY_WHEN_WAKING_MS
            : RETRY_WHEN_DOWN_MS;
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

  // Same rule as the probe: a request that failed to land before anything has
  // ever landed is not proof of an outage during a cold start.
  useBackendStatus.setState({
    status: mayStillBeWaking() ? "waking" : "offline",
    detail: event.detail ?? null,
    lastCheckedAt: event.at,
  });
});

/** True when a request to the backend has no chance of succeeding right now. */
export function isBackendUnreachable(status: BackendStatus): boolean {
  return status === "offline" || status === "unconfigured" || status === "blocked";
}
