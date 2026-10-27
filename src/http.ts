import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import { TrelloClient } from "./trello-client.js";

/**
 * Stateless Streamable HTTP handler for hosted deployments (e.g. Supabase
 * Edge Functions). Trello credentials come from the connector URL
 * (`?key=...&token=...`), so nothing is stored server-side and each user
 * brings their own access.
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const apiKey = url.searchParams.get("key");
  const token = url.searchParams.get("token");

  if (!apiKey || !token) {
    return Response.json(
      { error: "Add your Trello credentials to the URL: ?key=YOUR_API_KEY&token=YOUR_TOKEN" },
      { status: 401 },
    );
  }
  if (req.method !== "POST") {
    // Stateless server: no SSE stream to resume, no session to delete.
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const readOnly = /^(1|true|yes)$/i.test(url.searchParams.get("readonly") ?? "");
  const server = createServer(new TrelloClient({ apiKey, token }), { readOnly });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
