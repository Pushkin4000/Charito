import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mount the store with a stubbed probe transport.
 *
 * `probe` stands in for `apiClient.get`, which is what the health probe now
 * goes through -- deliberately the same instance real traffic uses, so the two
 * cannot diverge. `corsRetry` stands in for the raw no-cors `fetch` that tells
 * a CORS rejection apart from a dead host; that one stays a bare fetch because
 * axios cannot issue a no-cors request.
 */
async function mount(options: {
  probe: () => Promise<unknown>;
  corsRetry?: () => Promise<unknown>;
}) {
  const { apiClient } = await import("@/app/lib/api-client");
  const get = vi.fn(options.probe);
  vi.spyOn(apiClient, "get").mockImplementation(get as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      options.corsRetry ??
        (async () => {
          throw new Error("Network Error");
        }),
    ),
  );
  const { useBackendStatus } = await import("@/app/lib/backend-status");
  return { useBackendStatus, get };
}

/** A timestamp far enough back that any grace window has expired. */
const elapsed = () => Date.now() - 10 * 60_000;

const NETWORK_FAILURE = () => {
  throw new Error("Network Error");
};
const TIMEOUT = () => {
  throw new Error("timeout of 20000ms exceeded");
};

describe("backend reachability", () => {
  beforeEach(() => vi.resetModules());

  it("probes through apiClient, the same transport real traffic uses", async () => {
    // REGRESSION. A bare `fetch` probe failed against a backend the studio was
    // reaching on its very first request, pinning the overview page to
    // "waking". A probe with its own transport exercises a path that no real
    // traffic takes, so it can fail in ways nothing else does.
    const { useBackendStatus, get } = await mount({ probe: async () => ({ status: 200 }) });
    await useBackendStatus.getState().check();

    expect(get).toHaveBeenCalledTimes(1);
    const [url, config] = get.mock.calls[0] as [string, { params: Record<string, unknown> }];
    expect(url).toBe("/health");
    // Cache-busting belongs in the query string: a Cache-Control request header
    // is not CORS-safelisted and would force a preflight (234ef09).
    expect(config.params).toHaveProperty("_");
    expect(useBackendStatus.getState().status).toBe("online");
  });

  it("reports online once a real request comes back, even while the probe fails", async () => {
    const { useBackendStatus } = await mount({ probe: NETWORK_FAILURE });
    const { notifyReachable } = await import("@/app/lib/reachability");

    await useBackendStatus.getState().check();
    // Nothing has reached the backend yet, so a failed probe means "still
    // waking", not "down" -- see the cold-start tests below.
    expect(useBackendStatus.getState().status).toBe("waking");

    // Generation works -> a real response came back.
    notifyReachable();
    expect(useBackendStatus.getState().status).toBe("online");

    // A later failing probe must not overrule that.
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("online");
  });

  it("treats a non-2xx health response as reachable, not offline", async () => {
    // Axios rejects a 503, but the response interceptor has already reported
    // the completed round trip, so the store is online before the catch runs.
    const { useBackendStatus } = await mount({
      probe: async () => {
        const { notifyReachable } = await import("@/app/lib/reachability");
        notifyReachable();
        throw new Error("Request failed with status code 503");
      },
    });
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("online");
  });

  it("reports blocked, not offline, when the host answers but CORS rejects it", async () => {
    // A CORS rejection and a dead host fail identically; only the no-cors
    // retry tells them apart, by resolving when the server did in fact answer.
    const { useBackendStatus } = await mount({
      probe: NETWORK_FAILURE,
      corsRetry: async () => new Response("", { status: 200 }),
    });
    await useBackendStatus.getState().check();

    expect(useBackendStatus.getState().status).toBe("blocked");
    expect(useBackendStatus.getState().detail).toContain("Access-Control-Allow-Origin");
  });

  it("still reports offline when nothing has ever reached the backend", async () => {
    const { useBackendStatus } = await mount({ probe: NETWORK_FAILURE });
    // Past the cold-start budget: a sleeping instance would have answered.
    useBackendStatus.setState({ bootedAt: elapsed() });
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("offline");
  });


  it("keeps probing after an attempt that fails synchronously", async () => {
    // REGRESSION, and the reason the overview page froze on "waking".
    //
    // `fetch` THROWS rather than returning a rejected promise when a request is
    // blocked outright, so the probe body ran start to finish synchronously and
    // its `finally` nulled the shared in-flight handle before the assignment
    // setting that handle had finished. The assignment landed on top, and every
    // later check short-circuited on the settled promise it left behind: no
    // probe ever ran again, the status stayed wherever that first attempt put
    // it, and it could not even progress to "offline" once the budget expired.
    // A timeout, specifically: it is the one failure that needs no `await` to
    // classify, so the body runs start to finish without ever suspending.
    const { useBackendStatus, get } = await mount({ probe: TIMEOUT });

    await useBackendStatus.getState().check();
    expect(get).toHaveBeenCalledTimes(1);

    // The second check must reach the transport, not a stale handle.
    await useBackendStatus.getState().check();
    expect(get).toHaveBeenCalledTimes(2);

    // And it must still be able to change its mind about the status.
    useBackendStatus.setState({ bootedAt: elapsed() });
    await useBackendStatus.getState().check();
    expect(get).toHaveBeenCalledTimes(3);
    expect(useBackendStatus.getState().status).toBe("offline");
  });

  it("shares one round trip between overlapping probes", async () => {
    // Built outside the probe so the handle exists before the deferred body
    // gets a chance to run.
    let release!: () => void;
    const pending = new Promise<unknown>((resolve) => {
      release = () => resolve({ status: 200 });
    });
    const { useBackendStatus, get } = await mount({ probe: () => pending });

    const first = useBackendStatus.getState().check();
    const second = useBackendStatus.getState().check();
    release();
    await Promise.all([first, second]);

    // Deferring the body must not cost the de-duplication it protects.
    expect(get).toHaveBeenCalledTimes(1);
    expect(useBackendStatus.getState().status).toBe("online");
  });

  // -- Cold starts -----------------------------------------------------------
  //
  // The backend is a free-tier Render service. It sleeps after 15 idle minutes
  // and takes 30-60s to come back, which is longer than one probe timeout. A
  // failed probe in that window is not evidence that the backend is down.

  it("holds at 'waking' rather than 'offline' while the backend may still be booting", async () => {
    const { useBackendStatus } = await mount({ probe: TIMEOUT });
    await useBackendStatus.getState().check();

    expect(useBackendStatus.getState().status).toBe("waking");
    expect(useBackendStatus.getState().consecutiveFailures).toBe(1);
  });

  it("falls through to offline once the cold-start budget is spent", async () => {
    const { useBackendStatus } = await mount({ probe: TIMEOUT });
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("waking");

    useBackendStatus.setState({ bootedAt: elapsed() });
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("offline");
  });

  it("stops extending the cold-start grace once the backend has answered once", async () => {
    let alive = true;
    const { useBackendStatus } = await mount({
      probe: async () => {
        if (alive) return { status: 200 };
        throw new Error("timeout of 20000ms exceeded");
      },
    });
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("online");

    // It was demonstrably up, so a later failure is a real outage. Wind the
    // traffic grace back so it is not what keeps the status online.
    alive = false;
    useBackendStatus.setState({ lastReachableAt: elapsed() });
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("offline");
  });

  it("reports a failed real request as 'waking' during the cold-start window", async () => {
    const { useBackendStatus } = await mount({ probe: async () => ({ status: 200 }) });
    const { notifyUnreachable } = await import("@/app/lib/reachability");

    notifyUnreachable("Network Error");
    expect(useBackendStatus.getState().status).toBe("waking");

    useBackendStatus.setState({ bootedAt: elapsed() });
    notifyUnreachable("Network Error");
    expect(useBackendStatus.getState().status).toBe("offline");
  });
});
