#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { TrelloClient } from "./trello-client.js";

const apiKey = process.env.TRELLO_API_KEY;
const token = process.env.TRELLO_TOKEN;

if (!apiKey || !token) {
  console.error(
    "Missing TRELLO_API_KEY or TRELLO_TOKEN. Get them at https://trello.com/power-ups/admin (see README).",
  );
  process.exit(1);
}

const readOnly = /^(1|true|yes)$/i.test(process.env.TRELLO_READ_ONLY ?? "");
const server = createServer(new TrelloClient({ apiKey, token }), { readOnly });

await server.connect(new StdioServerTransport());
// stdout is reserved for the MCP protocol, so diagnostics go to stderr.
console.error(`trello-mcp running on stdio${readOnly ? " (read-only)" : ""}`);
