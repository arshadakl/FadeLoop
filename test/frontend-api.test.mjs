import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, request } from "../frontend/src/lib/api";
let events;
beforeEach(() => {
  events = new EventTarget();
  vi.stubGlobal("window", events);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("frontend API boundary", () => {
  it("preserves the campaign POST contract and authenticates with cookies", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"ok":true}'));
    const body = { campaign: { campaign_id: "test" }, active: false };
    expect(await api("/api/campaigns", { method: "POST", body })).toEqual({
      ok: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "/api/campaigns",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  });
  it("expires the UI session on protected 401s without retrying mutations or exports", async () => {
    const ended = vi.fn();
    events.addEventListener("fadeloop:session-ended", ended);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response('{"error":"unauthorized"}', { status: 401 }),
      );
    await expect(request("/api/contacts/export")).rejects.toThrow(
      "Your session has ended.",
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
  });
  it("keeps invalid-login errors separate from session expiry", async () => {
    const ended = vi.fn();
    events.addEventListener("fadeloop:session-ended", ended);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"error":"Invalid email or password"}', { status: 401 }),
    );
    await expect(
      api("/session/login", { method: "POST", session: false }),
    ).rejects.toThrow("Invalid email or password");
    expect(ended).not.toHaveBeenCalled();
  });
  it("uses Retry-After to explain throttling", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 429, headers: { "retry-after": "121" } }),
    );
    await expect(api("/session/login", { session: false })).rejects.toThrow(
      "Try again in 3 minutes",
    );
  });
  it("keeps aborts intact so obsolete requests cannot report network failures", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException("Aborted", "AbortError");
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    await expect(
      api("/api/dashboard", { signal: controller.signal }),
    ).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledWith(
      "/api/dashboard",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
  it("provides useful network and unreadable-response errors", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("<html>gateway error</html>"));
    await expect(api("/session", { session: false })).rejects.toThrow(
      "Check your connection",
    );
    await expect(api("/session", { session: false })).rejects.toThrow(
      "unreadable response",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
