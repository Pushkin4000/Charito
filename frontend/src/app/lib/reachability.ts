/**
 * A dependency-free channel between the API client and the reachability store.
 *
 * Real API traffic is far better evidence than a synthetic probe: if a request
 * came back at all — even a 401 or a 500 — the backend is demonstrably up. This
 * module lets `api-client` report that without importing the store, and lets
 * the store listen without importing anything that would form a cycle.
 */

export interface ReachabilityEvent {
  reachable: boolean;
  detail?: string;
  at: number;
}

type Listener = (event: ReachabilityEvent) => void;

const listeners = new Set<Listener>();
let lastEvent: ReachabilityEvent | null = null;

export function subscribeReachability(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: ReachabilityEvent): void {
  lastEvent = event;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A listener must never be able to break an API response path.
    }
  }
}

/** The backend answered. Any status code counts — reaching it is the claim. */
export function notifyReachable(): void {
  emit({ reachable: true, at: Date.now() });
}

/** The request never reached the backend: DNS, refused connection, TLS, CORS. */
export function notifyUnreachable(detail: string): void {
  emit({ reachable: false, detail, at: Date.now() });
}

/** Timestamp of the last confirmed round trip, or null if there has not been one. */
export function lastReachableAt(): number | null {
  return lastEvent?.reachable ? lastEvent.at : null;
}
