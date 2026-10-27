import { describe, expect, it, vi } from "vitest";
import { TrelloApiError, TrelloClient } from "../src/trello-client.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const makeClient = (fetchImpl: typeof fetch, extra = {}) =>
  new TrelloClient({ apiKey: "key", token: "tok", fetchImpl, retryBaseDelayMs: 1, ...extra });

describe("TrelloClient", () => {
  it("sends auth in the header, not the URL, and encodes query params", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    await makeClient(fetchImpl).get("/boards/b1", { fields: "id,name", ids: ["a", "b"], skip: undefined });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.trello.com/1/boards/b1?fields=id%2Cname&ids=a%2Cb");
    expect(url).not.toContain("tok");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'OAuth oauth_consumer_key="key", oauth_token="tok"',
    );
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "API_TOKEN_LIMIT_EXCEEDED" }, 429))
      .mockResolvedValueOnce(new Response("oops", { status: 502 }))
      .mockResolvedValueOnce(json({ id: "c1" }));
    await expect(makeClient(fetchImpl).get("/cards/c1")).resolves.toEqual({ id: "c1" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid id", { status: 400 }));
    const error = await makeClient(fetchImpl).get("/cards/x").catch((e) => e);
    expect(error).toBeInstanceOf(TrelloApiError);
    expect(error.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(makeClient(fetchImpl, { maxRetries: 2 }).get("/x")).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throttles requests beyond the window limit", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    const client = makeClient(fetchImpl, { maxRequestsPerWindow: 2, windowMs: 100 });
    const start = Date.now();
    await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(95);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
