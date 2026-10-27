/**
 * Trello responses are large. These helpers pick the fields an LLM actually
 * needs so tool results stay small and readable.
 */

type Obj = Record<string, any>;

export const BOARD_FIELDS = "id,name,desc,url,closed,idOrganization,dateLastActivity";
export const LIST_FIELDS = "id,name,closed,pos,idBoard";
export const CARD_FIELDS =
  "id,name,desc,url,closed,idList,idBoard,idLabels,idMembers,due,dueComplete,start,pos,dateLastActivity";
export const LABEL_FIELDS = "id,name,color";
export const MEMBER_FIELDS = "id,username,fullName";

const truncate = (text: string | undefined, max = 1000) =>
  text && text.length > max ? `${text.slice(0, max)}… [truncated]` : text || undefined;

export const formatBoard = (b: Obj) => ({
  id: b.id,
  name: b.name,
  description: truncate(b.desc, 500),
  url: b.url,
  closed: b.closed || undefined,
  workspaceId: b.idOrganization ?? undefined,
  lastActivity: b.dateLastActivity,
});

export const formatList = (l: Obj) => ({
  id: l.id,
  name: l.name,
  closed: l.closed || undefined,
  pos: l.pos,
});

export const formatLabel = (l: Obj) => ({ id: l.id, name: l.name || undefined, color: l.color ?? undefined });

export const formatMember = (m: Obj) => ({ id: m.id, username: m.username, fullName: m.fullName });

/** Compact card for listings; descriptions are cut short. */
export const formatCardSummary = (c: Obj) => ({
  id: c.id,
  name: c.name,
  listId: c.idList,
  url: c.url,
  due: c.due ?? undefined,
  dueComplete: c.due ? c.dueComplete : undefined,
  labelIds: c.idLabels?.length ? c.idLabels : undefined,
  memberIds: c.idMembers?.length ? c.idMembers : undefined,
  closed: c.closed || undefined,
  description: truncate(c.desc, 200),
});

export const formatChecklist = (cl: Obj) => ({
  id: cl.id,
  name: cl.name,
  items: (cl.checkItems ?? [])
    .slice()
    .sort((a: Obj, b: Obj) => a.pos - b.pos)
    .map((i: Obj) => ({ id: i.id, name: i.name, complete: i.state === "complete" })),
});

export const formatCardDetail = (c: Obj) => ({
  ...formatCardSummary(c),
  boardId: c.idBoard,
  description: truncate(c.desc, 4000),
  start: c.start ?? undefined,
  lastActivity: c.dateLastActivity,
  labels: c.labels?.map(formatLabel),
  members: c.members?.map(formatMember),
  checklists: c.checklists?.map(formatChecklist),
  attachments: c.attachments?.map((a: Obj) => ({ id: a.id, name: a.name, url: a.url })),
});

export const formatAction = (a: Obj) => ({
  id: a.id,
  type: a.type,
  date: a.date,
  by: a.memberCreator?.username,
  card: a.data?.card ? { id: a.data.card.id, name: a.data.card.name } : undefined,
  list: a.data?.list?.name ?? undefined,
  listBefore: a.data?.listBefore?.name ?? undefined,
  listAfter: a.data?.listAfter?.name ?? undefined,
  text: truncate(a.data?.text, 1000),
});

export const formatComment = (a: Obj) => ({
  id: a.id,
  date: a.date,
  by: a.memberCreator?.username,
  text: a.data?.text,
});
