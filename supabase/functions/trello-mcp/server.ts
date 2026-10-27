import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolOptions } from "./tools.ts";
import type { TrelloClient } from "./trello-client.ts";

export const SERVER_NAME = "trello-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(trello: TrelloClient, options: ToolOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for Trello. Start with list_boards to find a board, then get_board to resolve list, label and member IDs. " +
        "Use search for free-text lookups. Cards are archived, never deleted.",
    },
  );
  registerTools(server, trello, options);
  return server;
}
