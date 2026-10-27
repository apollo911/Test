import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { TrelloClient } from "../src/trello-client.js";

type Route = (url: URL, method: string) => unknown;

/** Spins up the MCP server against a fake Trello API and returns a connected client. */
async function setup(route: Route, options = {}) {
  const calls: { method: string; url: URL }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const body = route(url, method);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body ?? {}), { status: 200 });
  });
  const trello = new TrelloClient({ apiKey: "k", token: "t", fetchImpl, retryBaseDelayMs: 1 });
  const server = createServer(trello, options);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as any;
    const text = result.content[0].text as string;
    return { isError: !!result.isError, text, data: result.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, calls };
}

describe("tool registration", () => {
  it("registers read and write tools with annotations", async () => {
    const { client } = await setup(() => ({}));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_boards", "get_card", "create_card", "move_card"]));
    expect(tools.find((t) => t.name === "get_card")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "create_card")?.annotations?.readOnlyHint).toBe(false);
  });

  it("hides write tools in read-only mode", async () => {
    const { client } = await setup(() => ({}), { readOnly: true });
    const { tools } = await client.listTools();
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain("create_card");
  });
});

describe("tools", () => {
  it("get_board returns compact lists, labels and members", async () => {
    const { call, calls } = await setup(() => ({
      id: "b1",
      name: "Roadmap",
      desc: "",
      url: "https://trello.com/b/b1",
      closed: false,
      lists: [{ id: "l1", name: "To Do", pos: 1, closed: false, idBoard: "b1", extra: "x" }],
      labels: [{ id: "lb1", name: "bug", color: "red" }],
      members: [{ id: "m1", username: "alice", fullName: "Alice" }],
    }));
    const { data } = await call("get_board", { boardId: "b1" });
    expect(calls[0].url.pathname).toBe("/1/boards/b1");
    expect(calls[0].url.searchParams.get("lists")).toBe("open");
    expect(data.lists).toEqual([{ id: "l1", name: "To Do", pos: 1 }]);
    expect(data.labels[0]).toEqual({ id: "lb1", name: "bug", color: "red" });
    expect(data.members[0].username).toBe("alice");
  });

  it("list_cards requires exactly one of listId / boardId", async () => {
    const { call } = await setup(() => []);
    const result = await call("list_cards", {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/exactly one/);
  });

  it("list_cards applies the limit and reports the total", async () => {
    const cards = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: `Card ${i}`, idList: "l1", desc: "" }));
    const { call, calls } = await setup(() => cards);
    const { data } = await call("list_cards", { listId: "l1", limit: 2 });
    expect(calls[0].url.pathname).toBe("/1/lists/l1/cards");
    expect(data.total).toBe(5);
    expect(data.cards.map((c: any) => c.id)).toEqual(["c0", "c1"]);
  });

  it("create_card maps arguments to Trello params", async () => {
    const { call, calls } = await setup(() => ({ id: "c9", name: "Write docs", idList: "l1" }));
    const { data } = await call("create_card", {
      listId: "l1",
      name: "Write docs",
      description: "Use **markdown**",
      due: "2026-11-01T18:00:00Z",
      labelIds: ["lb1", "lb2"],
      pos: "top",
    });
    const { method, url } = calls[0];
    expect(method).toBe("POST");
    expect(url.pathname).toBe("/1/cards");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      idList: "l1",
      name: "Write docs",
      desc: "Use **markdown**",
      due: "2026-11-01T18:00:00Z",
      idLabels: "lb1,lb2",
      pos: "top",
    });
    expect(data.id).toBe("c9");
  });

  it("update_card can clear the due date and labels", async () => {
    const { call, calls } = await setup(() => ({ id: "c1" }));
    await call("update_card", { cardId: "c1", due: null, labelIds: [] });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url.searchParams.get("due")).toBe("null");
    expect(calls[0].url.searchParams.get("idLabels")).toBe("");
  });

  it("move_card and archive_card use PUT /cards/:id", async () => {
    const { call, calls } = await setup(() => ({ id: "c1" }));
    await call("move_card", { cardId: "c1", listId: "l2", pos: "bottom" });
    await call("archive_card", { cardId: "c1" });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "PUT /1/cards/c1?idList=l2&pos=bottom",
      "PUT /1/cards/c1?closed=true",
    ]);
  });

  it("add_checklist creates the checklist and its items in order", async () => {
    const { call, calls } = await setup((url) =>
      url.pathname === "/1/checklists"
        ? { id: "cl1", name: "Release" }
        : { id: `i-${url.searchParams.get("name")}`, name: url.searchParams.get("name"), state: "incomplete", pos: 1 },
    );
    const { data } = await call("add_checklist", { cardId: "c1", name: "Release", items: ["Build", "Ship"] });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/1/checklists",
      "/1/checklists/cl1/checkItems",
      "/1/checklists/cl1/checkItems",
    ]);
    expect(data.items.map((i: any) => i.name)).toEqual(["Build", "Ship"]);
  });

  it("update_checklist_item maps complete to state", async () => {
    const { call, calls } = await setup(() => ({ id: "i1", name: "Build", state: "complete" }));
    const { data } = await call("update_checklist_item", { cardId: "c1", checkItemId: "i1", complete: true });
    expect(calls[0].url.pathname).toBe("/1/cards/c1/checkItem/i1");
    expect(calls[0].url.searchParams.get("state")).toBe("complete");
    expect(data.complete).toBe(true);
  });

  it("get_comments filters card actions by commentCard", async () => {
    const { call, calls } = await setup(() => [
      { id: "a1", date: "2026-10-01", memberCreator: { username: "bob" }, data: { text: "LGTM" } },
    ]);
    const { data } = await call("get_comments", { cardId: "c1" });
    expect(calls[0].url.searchParams.get("filter")).toBe("commentCard");
    expect(data).toEqual([{ id: "a1", date: "2026-10-01", by: "bob", text: "LGTM" }]);
  });

  it("search passes board filters and returns cards and boards", async () => {
    const { call, calls } = await setup(() => ({ cards: [{ id: "c1", name: "Bug" }], boards: [] }));
    const { data } = await call("search", { query: "label:bug", boardIds: ["b1", "b2"] });
    expect(calls[0].url.searchParams.get("idBoards")).toBe("b1,b2");
    expect(data.cards[0].id).toBe("c1");
  });

  it("returns a helpful error for Trello API failures", async () => {
    const { call } = await setup(() => new Response("invalid token", { status: 401 }));
    const result = await call("get_me");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/401/);
    expect(result.text).toMatch(/Hint: The API key or token is invalid/);
  });

  it("rejects invalid arguments via the schema", async () => {
    const { call } = await setup(() => ({}));
    const result = await call("create_label", { boardId: "b1", name: "x", color: "magenta" });
    expect(result.isError).toBe(true);
  });
});
