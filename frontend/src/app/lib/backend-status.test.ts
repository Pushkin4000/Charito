import { beforeEach, describe, expect, it, vi } from "vitest";

describe("backend reachability", () => {
  beforeEach(() => vi.resetModules());

  it("does not send Cache-Control/Pragma request headers (keeps the GET CORS-simple)", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response("{}", { status: 200 });
    }));

    const { useBackendStatus } = await import("@/app/lib/backend-status");
    await useBackendStatus.getState().check();

    const [url, init] = calls[0];
    expect(url).toContain("/health");
    // `cache: "no-store"` makes the browser append Cache-Control + Pragma,
    // which are not CORS-safelisted and force a preflight.
    expect(init?.cache).toBeUndefined();
    expect(useBackendStatus.getState().status).toBe("online");
  });

  it("reports online once a real request comes back, even while the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    const { useBackendStatus } = await import("@/app/lib/backend-status");
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
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const { useBackendStatus } = await import("@/app/lib/backend-status");
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("online");
    expect(useBackendStatus.getState().detail).toContain("503");
  });

  it("reports blocked, not offline, when the host answers but CORS rejects it", async () => {
    // A CORS rejection and a dead host both surface as a bare TypeError; only
    // the no-cors retry can tell them apart.
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      // A real opaque response reports status 0, but the Response constructor
      // rejects that; all this branch needs is for the promise to resolve.
      if (init?.mode === "no-cors") return new Response("", { status: 200 });
      throw new TypeError("Failed to fetch");
    }));

    const { useBackendStatus } = await import("@/app/lib/backend-status");
    await useBackendStatus.getState().check();

    expect(useBackendStatus.getState().status).toBe("blocked");
    expect(useBackendStatus.getState().detail).toContain("Access-Control-Allow-Origin");
  });

  it("still reports offline when nothing has ever reached the backend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const { useBackendStatus } = await import("@/app/lib/backend-status");
    // Past the cold-start budget: a sleeping instance would have answered.
    useBackendStatus.setState({ bootedAt: Date.now() - 10 * 60_000 });
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("offline");
  });

  // -- Cold starts -----------------------------------------------------------
  //
  // The backend is a free-tier Render service. It sleeps after 15 idle minutes
  // and takes 30-60s to come back, which is longer than one probe timeout. A
  // failed probe in that window is not evidence that the backend is down.

  it("holds at 'waking' rather than 'offline' while the backend may still be booting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }));

    const { useBackendStatus } = await import("@/app/lib/backend-status");
    await useBackendStatus.getState().check();

    expect(useBackendStatus.getState().status).toBe("waking");
    expect(useBackendStatus.getState().consecutiveFailures).toBe(1);
  });

  it("falls through to offline once the cold-start budget is spent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }));

    const { useBackendStatus } = await import("@/app/lib/backend-status");
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("waking");

    useBackendStatus.setState({ bootedAt: Date.now() - 10 * 60_000 });
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("offline");
  });

  it("stops extending the cold-start grace once the backend has answered once", async () => {
    let alive = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (alive) return new Response("{}", { status: 200 });
      throw new TypeError("Failed to fetch");
    }));

    const { useBackendStatus } = await import("@/app/lib/backend-status");
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("online");

    // It was demonstrably up, so a later failure is a real outage. Wind the
    // traffic grace back so it is not what keeps the status online.
    alive = false;
    useBackendStatus.setState({ lastReachableAt: Date.now() - 10 * 60_000 });
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("offline");
  });

  it("reports a failed real request as 'waking' during the cold-start window", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const { useBackendStatus } = await import("@/app/lib/backend-status");
    const { notifyUnreachable } = await import("@/app/lib/reachability");

    notifyUnreachable("Network Error");
    expect(useBackendStatus.getState().status).toBe("waking");

    useBackendStatus.setState({ bootedAt: Date.now() - 10 * 60_000 });
    notifyUnreachable("Network Error");
    expect(useBackendStatus.getState().status).toBe("offline");
  });
});
