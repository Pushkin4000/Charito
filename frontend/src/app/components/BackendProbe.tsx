import { useEffect } from "react";
import { useBackendStatus } from "@/app/lib/backend-status";

/**
 * Starts the reachability poll once, for the lifetime of the app shell.
 *
 * This file used to also hold the notice components -- a site-wide bar, a
 * studio panel and a shared detail block -- that announced an unreachable
 * backend. They are gone deliberately: the site no longer reports reachability
 * faults to the visitor at all, and the header tell says something only when
 * the backend has actually answered.
 *
 * The poll itself is kept because that tell depends on it, and because the
 * store's `detail` and `consecutiveFailures` remain accurate for anyone
 * debugging from the console. What changed is what the page says out loud, not
 * what it knows.
 *
 * NOTE for whoever wants the warnings back: nothing here is load-bearing for
 * error reporting elsewhere. Failures of actual operations -- a run, a file
 * write, a workspace session -- are reported by `useAgentStore` against the
 * thing the user was doing, and were never part of this.
 */
export function useBackendProbe() {
  const startPolling = useBackendStatus((state) => state.startPolling);
  useEffect(() => startPolling(), [startPolling]);
}
