# trello-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants
(Claude Desktop, Claude Code, Cursor, …) read and manage Trello boards, lists and cards.

- **21 tools**: boards, lists, cards, checklists, comments, labels, search, activity
- **LLM-friendly output**: compact JSON with only the useful fields, long text truncated
- **Safe by default**: cards and lists are archived, never deleted; optional read-only mode
- **Rate-limit aware**: client-side throttling (90 req / 10 s per token) and retries with backoff on `429` / `5xx`
- **Secrets stay out of URLs**: credentials are sent in the `Authorization` header

## Tools

| Tool | Description | Mode |
|---|---|---|
| `get_me` | Current user and their workspaces | read |
| `list_boards` | Boards of the user or of a workspace | read |
| `get_board` | Board with its lists, labels and members (resolve names → IDs) | read |
| `list_cards` | Cards in a list or on a board | read |
| `get_card` | Card details: description, labels, members, checklists, attachments | read |
| `get_comments` | Comments on a card | read |
| `search` | Full-text search with Trello operators (`@me`, `due:week`, `label:bug`, …) | read |
| `get_board_activity` | Recent actions on a board | read |
| `create_list` / `update_list` | Create, rename, move, archive or restore a list | write |
| `create_card` / `update_card` | Create or edit a card (name, description, dates, labels, members) | write |
| `move_card` | Move a card to another list/board/position | write |
| `archive_card` | Archive a card (restorable) | write |
| `add_comment` | Comment on a card | write |
| `add_checklist` / `add_checklist_item` / `update_checklist_item` | Manage checklists | write |
| `create_label` / `add_label` / `remove_label` | Manage labels | write |

## Setup

### 1. Get Trello credentials

1. Open <https://trello.com/power-ups/admin>, create a Power-Up (any name) and generate an **API key**.
2. On the same page click the **Token** link next to the key, or open
   `https://trello.com/1/authorize?expiration=30days&scope=read,write&response_type=token&key=YOUR_API_KEY`
   and approve access. Copy the **token**.

Use `scope=read` together with `TRELLO_READ_ONLY=true` if you only need read access.

### 2. Build

```bash
git clone <this repo> && cd trello-mcp
npm install
npm run build
```

Requires Node.js 18+.

### 3. Configure your client

**Claude Code**

```bash
claude mcp add trello \
  -e TRELLO_API_KEY=your_key -e TRELLO_TOKEN=your_token \
  -- node /absolute/path/to/trello-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "trello": {
      "command": "node",
      "args": ["/absolute/path/to/trello-mcp/dist/index.js"],
      "env": {
        "TRELLO_API_KEY": "your_key",
        "TRELLO_TOKEN": "your_token"
      }
    }
  }
}
```

### Option B: hosted (no install) — Claude custom connector

The server also runs as a stateless HTTP endpoint (`src/http.ts`), packaged as a Supabase Edge Function:

```bash
npm run build:edge                                    # writes supabase/functions/trello-mcp
supabase functions deploy trello-mcp --no-verify-jwt  # or deploy via the Supabase MCP / dashboard
```

Then in Claude: **Settings → Connectors → Add custom connector**, URL:

```
https://<project-ref>.supabase.co/functions/v1/trello-mcp?key=YOUR_API_KEY&token=YOUR_TOKEN
```

Add `&readonly=1` for read-only tools. Credentials live only in your connector URL; nothing is stored
server-side. Treat that URL like a password.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `TRELLO_API_KEY` | yes | Trello API key |
| `TRELLO_TOKEN` | yes | Trello user token |
| `TRELLO_READ_ONLY` | no | `true` registers only read tools |

## Example prompts

- "What's on my Roadmap board? Summarize each list."
- "Create a card 'Prepare release notes' in To Do, due Friday, with a checklist: draft, review, publish."
- "Move all cards labeled `done` from In Progress to Done."
- "What changed on the Marketing board since yesterday?"

## Development

```bash
npm run build      # compile TypeScript to dist/
npm test           # unit + MCP integration tests (Trello API is mocked)
npm run typecheck
npm run inspect    # open the MCP Inspector against the built server
```

Project layout:

```
src/
  index.ts          entry point (stdio transport, env config)
  server.ts         McpServer factory
  tools.ts          tool definitions (zod schemas + handlers)
  trello-client.ts  REST client: auth, throttling, retries, errors
  format.ts         compact response mappers
test/               vitest suites (client + end-to-end tool calls)
```

## Design notes

- **Authentication**: API key + token is the simplest fit for a local, single-user server.
  Trello also offers OAuth 2.0 (3LO) since September 2026, the natural next step for a hosted multi-user version.
- **Rate limits**: Trello allows 300 req / 10 s per key and 100 req / 10 s per token
  (`/1/members` is limited to 100 req / 900 s). The client keeps under the token limit and backs off on `429`.
- **No deletes**: archiving is reversible, deleting is not, so the server only archives.

## Possible extensions

Attachments upload, custom fields, webhooks, board creation from templates, Streamable HTTP transport with OAuth 2.0.

## License

MIT
