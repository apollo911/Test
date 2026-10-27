import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  BOARD_FIELDS,
  CARD_FIELDS,
  LABEL_FIELDS,
  LIST_FIELDS,
  MEMBER_FIELDS,
  formatAction,
  formatBoard,
  formatCardDetail,
  formatCardSummary,
  formatChecklist,
  formatComment,
  formatLabel,
  formatList,
  formatMember,
} from "./format.js";
import { TrelloApiError, type TrelloClient } from "./trello-client.js";

type Obj = Record<string, any>;

export interface ToolOptions {
  /** When true, only read-only tools are registered. */
  readOnly?: boolean;
}

const LABEL_COLORS = [
  "green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink", "black",
  "green_dark", "yellow_dark", "orange_dark", "red_dark", "purple_dark", "blue_dark", "sky_dark", "lime_dark", "pink_dark", "black_dark",
  "green_light", "yellow_light", "orange_light", "red_light", "purple_light", "blue_light", "sky_light", "lime_light", "pink_light", "black_light",
] as const;

const id = (what: string) => z.string().min(1).describe(`${what} ID`);
const position = z
  .union([z.enum(["top", "bottom"]), z.number().positive()])
  .optional()
  .describe('"top", "bottom" or a positive number');
const dueDate = z
  .string()
  .nullable()
  .optional()
  .describe("ISO 8601 date-time, e.g. 2026-11-01T18:00:00Z; null clears it");

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof TrelloApiError) {
    const hints: Record<number, string> = {
      400: "Check the parameters (IDs, date formats, colors).",
      401: "The API key or token is invalid, expired, or lacks the required scope.",
      403: "The token has no access to this resource.",
      404: "The resource does not exist or is not visible to this token. Verify the ID.",
      429: "Trello rate limit exceeded. Wait a few seconds and retry.",
    };
    message = `Trello API error ${error.status}: ${error.body.slice(0, 300)}${hints[error.status] ? `\nHint: ${hints[error.status]}` : ""}`;
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Converts a nullable value to the form Trello expects in a query string. */
const nullable = (value: string | null | undefined) => (value === null ? "null" : value);

export function registerTools(server: McpServer, trello: TrelloClient, options: ToolOptions = {}) {
  const tool = <S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S; write?: boolean },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) => {
    if (config.write && options.readOnly) return;
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: config.write ? WRITE : READ,
      },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return ok(await handler(args));
        } catch (error) {
          return fail(error);
        }
      }) as any,
    );
  };

  // ---------------------------------------------------------------- read ---

  tool(
    "get_me",
    {
      title: "Get current user",
      description: "Returns the Trello user that owns the token, plus their workspaces.",
      inputSchema: {},
    },
    async () => {
      const me = await trello.get<Obj>("/members/me", {
        fields: `${MEMBER_FIELDS},url`,
        organizations: "all",
        organization_fields: "id,name,displayName",
      });
      return {
        ...formatMember(me),
        url: me.url,
        workspaces: (me.organizations ?? []).map((o: Obj) => ({ id: o.id, name: o.displayName, slug: o.name })),
      };
    },
  );

  tool(
    "list_boards",
    {
      title: "List boards",
      description: "Lists boards the user is a member of. Use this first to discover board IDs.",
      inputSchema: {
        filter: z.enum(["open", "closed", "all", "starred"]).default("open"),
        workspaceId: z.string().optional().describe("Only return boards from this workspace"),
      },
    },
    async ({ filter, workspaceId }) => {
      const path = workspaceId ? `/organizations/${workspaceId}/boards` : "/members/me/boards";
      const boards = await trello.get<Obj[]>(path, { filter, fields: BOARD_FIELDS });
      return boards.map(formatBoard);
    },
  );

  tool(
    "get_board",
    {
      title: "Get board overview",
      description:
        "Returns a board with its lists, labels and members (IDs and names). Use it to resolve list, label and member names to IDs.",
      inputSchema: { boardId: id("Board") },
    },
    async ({ boardId }) => {
      const b = await trello.get<Obj>(`/boards/${boardId}`, {
        fields: BOARD_FIELDS,
        lists: "open",
        list_fields: LIST_FIELDS,
        labels: "all",
        label_fields: LABEL_FIELDS,
        members: "all",
        member_fields: MEMBER_FIELDS,
      });
      return {
        ...formatBoard(b),
        lists: (b.lists ?? []).map(formatList),
        labels: (b.labels ?? []).map(formatLabel),
        members: (b.members ?? []).map(formatMember),
      };
    },
  );

  tool(
    "list_cards",
    {
      title: "List cards",
      description:
        "Lists cards in a list (listId) or on a whole board (boardId). Exactly one of them is required. Descriptions are shortened; use get_card for details.",
      inputSchema: {
        listId: z.string().optional().describe("List ID"),
        boardId: z.string().optional().describe("Board ID"),
        filter: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.number().int().min(1).max(1000).default(100),
      },
    },
    async ({ listId, boardId, filter, limit }) => {
      if (!!listId === !!boardId) throw new Error("Provide exactly one of listId or boardId");
      const path = listId ? `/lists/${listId}/cards` : `/boards/${boardId}/cards`;
      const cards = await trello.get<Obj[]>(path, { filter, fields: CARD_FIELDS });
      return { total: cards.length, cards: cards.slice(0, limit).map(formatCardSummary) };
    },
  );

  tool(
    "get_card",
    {
      title: "Get card details",
      description: "Returns full details of a card: description, labels, members, checklists and attachments.",
      inputSchema: { cardId: id("Card") },
    },
    async ({ cardId }) => {
      const card = await trello.get<Obj>(`/cards/${cardId}`, {
        fields: `${CARD_FIELDS},labels`,
        members: true,
        member_fields: MEMBER_FIELDS,
        checklists: "all",
        checklist_fields: "id,name",
        attachments: true,
        attachment_fields: "id,name,url",
      });
      return formatCardDetail(card);
    },
  );

  tool(
    "get_comments",
    {
      title: "Get card comments",
      description: "Returns comments on a card, newest first.",
      inputSchema: { cardId: id("Card"), limit: z.number().int().min(1).max(1000).default(50) },
    },
    async ({ cardId, limit }) => {
      const actions = await trello.get<Obj[]>(`/cards/${cardId}/actions`, { filter: "commentCard", limit });
      return actions.map(formatComment);
    },
  );

  tool(
    "search",
    {
      title: "Search Trello",
      description:
        'Full-text search across cards and boards. Supports Trello operators such as "@me", "due:week", "label:urgent", "list:Done", "is:open", "board:Name".',
      inputSchema: {
        query: z.string().min(1),
        boardIds: z.array(z.string()).optional().describe("Restrict search to these boards"),
        limit: z.number().int().min(1).max(100).default(20),
        partial: z.boolean().default(true).describe("Match word prefixes"),
      },
    },
    async ({ query, boardIds, limit, partial }) => {
      const result = await trello.get<Obj>("/search", {
        query,
        idBoards: boardIds?.length ? boardIds : undefined,
        modelTypes: "cards,boards",
        card_fields: CARD_FIELDS,
        cards_limit: limit,
        board_fields: BOARD_FIELDS,
        boards_limit: Math.min(limit, 10),
        partial,
      });
      return {
        cards: (result.cards ?? []).map(formatCardSummary),
        boards: (result.boards ?? []).map(formatBoard),
      };
    },
  );

  tool(
    "get_board_activity",
    {
      title: "Get board activity",
      description: "Returns recent activity on a board (card created/moved/updated, comments, ...), newest first.",
      inputSchema: {
        boardId: id("Board"),
        limit: z.number().int().min(1).max(1000).default(30),
        since: z.string().optional().describe("Only actions after this ISO date or action ID"),
      },
    },
    async ({ boardId, limit, since }) => {
      const actions = await trello.get<Obj[]>(`/boards/${boardId}/actions`, { limit, since });
      return actions.map(formatAction);
    },
  );

  // --------------------------------------------------------------- write ---

  tool(
    "create_list",
    {
      title: "Create list",
      description: "Creates a new list on a board.",
      inputSchema: { boardId: id("Board"), name: z.string().min(1), pos: position },
      write: true,
    },
    async ({ boardId, name, pos }) => formatList(await trello.post<Obj>("/lists", { idBoard: boardId, name, pos })),
  );

  tool(
    "update_list",
    {
      title: "Update list",
      description: "Renames, moves, archives (closed=true) or restores (closed=false) a list.",
      inputSchema: {
        listId: id("List"),
        name: z.string().min(1).optional(),
        pos: position,
        closed: z.boolean().optional(),
      },
      write: true,
    },
    async ({ listId, ...fields }) => formatList(await trello.put<Obj>(`/lists/${listId}`, fields)),
  );

  tool(
    "create_card",
    {
      title: "Create card",
      description: "Creates a card in a list. Use get_board to find list, label and member IDs.",
      inputSchema: {
        listId: id("List"),
        name: z.string().min(1),
        description: z.string().optional().describe("Markdown supported"),
        pos: position,
        due: dueDate,
        start: dueDate,
        labelIds: z.array(z.string()).optional(),
        memberIds: z.array(z.string()).optional(),
      },
      write: true,
    },
    async ({ listId, name, description, pos, due, start, labelIds, memberIds }) =>
      formatCardSummary(
        await trello.post<Obj>("/cards", {
          idList: listId,
          name,
          desc: description,
          pos,
          due: nullable(due),
          start: nullable(start),
          idLabels: labelIds,
          idMembers: memberIds,
        }),
      ),
  );

  tool(
    "update_card",
    {
      title: "Update card",
      description:
        "Updates card fields. Only provided fields change. labelIds/memberIds replace the whole set; use add_label/remove_label for single changes.",
      inputSchema: {
        cardId: id("Card"),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        due: dueDate,
        start: dueDate,
        dueComplete: z.boolean().optional(),
        labelIds: z.array(z.string()).optional(),
        memberIds: z.array(z.string()).optional(),
        closed: z.boolean().optional().describe("true archives the card, false restores it"),
      },
      write: true,
    },
    async ({ cardId, name, description, due, start, dueComplete, labelIds, memberIds, closed }) =>
      formatCardSummary(
        await trello.put<Obj>(`/cards/${cardId}`, {
          name,
          desc: description,
          due: nullable(due),
          start: nullable(start),
          dueComplete,
          // An empty array must be sent as an empty string to clear the set.
          idLabels: labelIds && (labelIds.length ? labelIds : ""),
          idMembers: memberIds && (memberIds.length ? memberIds : ""),
          closed,
        }),
      ),
  );

  tool(
    "move_card",
    {
      title: "Move card",
      description: "Moves a card to another list (optionally on another board) and/or position.",
      inputSchema: {
        cardId: id("Card"),
        listId: id("Target list"),
        boardId: z.string().optional().describe("Target board ID, only when moving across boards"),
        pos: position,
      },
      write: true,
    },
    async ({ cardId, listId, boardId, pos }) =>
      formatCardSummary(await trello.put<Obj>(`/cards/${cardId}`, { idList: listId, idBoard: boardId, pos })),
  );

  tool(
    "archive_card",
    {
      title: "Archive card",
      description: "Archives a card. It can be restored with update_card(closed=false). Cards are never deleted by this server.",
      inputSchema: { cardId: id("Card") },
      write: true,
    },
    async ({ cardId }) => formatCardSummary(await trello.put<Obj>(`/cards/${cardId}`, { closed: true })),
  );

  tool(
    "add_comment",
    {
      title: "Add comment",
      description: "Adds a comment to a card.",
      inputSchema: { cardId: id("Card"), text: z.string().min(1) },
      write: true,
    },
    async ({ cardId, text }) => formatComment(await trello.post<Obj>(`/cards/${cardId}/actions/comments`, { text })),
  );

  tool(
    "add_checklist",
    {
      title: "Add checklist",
      description: "Creates a checklist on a card, optionally with items.",
      inputSchema: {
        cardId: id("Card"),
        name: z.string().min(1),
        items: z.array(z.string().min(1)).optional(),
      },
      write: true,
    },
    async ({ cardId, name, items = [] }) => {
      const checklist = await trello.post<Obj>("/checklists", { idCard: cardId, name });
      const checkItems = [];
      // Sequential on purpose: keeps item order and respects rate limits.
      for (const item of items) {
        checkItems.push(
          await trello.post<Obj>(`/checklists/${checklist.id}/checkItems`, { name: item, pos: "bottom" }),
        );
      }
      return formatChecklist({ ...checklist, checkItems });
    },
  );

  tool(
    "add_checklist_item",
    {
      title: "Add checklist item",
      description: "Adds an item to an existing checklist.",
      inputSchema: { checklistId: id("Checklist"), name: z.string().min(1), pos: position },
      write: true,
    },
    async ({ checklistId, name, pos }) => {
      const item = await trello.post<Obj>(`/checklists/${checklistId}/checkItems`, { name, pos });
      return { id: item.id, name: item.name, complete: item.state === "complete" };
    },
  );

  tool(
    "update_checklist_item",
    {
      title: "Update checklist item",
      description: "Marks a checklist item complete/incomplete or renames it.",
      inputSchema: {
        cardId: id("Card"),
        checkItemId: id("Checklist item"),
        complete: z.boolean().optional(),
        name: z.string().min(1).optional(),
      },
      write: true,
    },
    async ({ cardId, checkItemId, complete, name }) => {
      const item = await trello.put<Obj>(`/cards/${cardId}/checkItem/${checkItemId}`, {
        state: complete === undefined ? undefined : complete ? "complete" : "incomplete",
        name,
      });
      return { id: item.id, name: item.name, complete: item.state === "complete" };
    },
  );

  tool(
    "create_label",
    {
      title: "Create label",
      description: "Creates a label on a board.",
      inputSchema: {
        boardId: id("Board"),
        name: z.string(),
        color: z.enum(LABEL_COLORS).nullable().describe("null creates a colorless label"),
      },
      write: true,
    },
    async ({ boardId, name, color }) =>
      formatLabel(await trello.post<Obj>("/labels", { idBoard: boardId, name, color: nullable(color) })),
  );

  tool(
    "add_label",
    {
      title: "Add label to card",
      description: "Adds an existing board label to a card.",
      inputSchema: { cardId: id("Card"), labelId: id("Label") },
      write: true,
    },
    async ({ cardId, labelId }) => {
      await trello.post(`/cards/${cardId}/idLabels`, { value: labelId });
      return { cardId, labelId, added: true };
    },
  );

  tool(
    "remove_label",
    {
      title: "Remove label from card",
      description: "Removes a label from a card (the label itself stays on the board).",
      inputSchema: { cardId: id("Card"), labelId: id("Label") },
      write: true,
    },
    async ({ cardId, labelId }) => {
      await trello.delete(`/cards/${cardId}/idLabels/${labelId}`);
      return { cardId, labelId, removed: true };
    },
  );
}
