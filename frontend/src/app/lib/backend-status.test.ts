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
    expect(useBackendStatus.getState().status).toBe("offline");

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

  it("still reports offline when nothing has ever reached the backend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const { useBackendStatus } = await import("@/app/lib/backend-status");
    await useBackendStatus.getState().check();
    expect(useBackendStatus.getState().status).toBe("offline");
  });
});
