import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { itemAfter, itemText, newItemsSchema, updateItemSchema } from '../checklists/schemas.js';
import { addItem, deleteItem, updateItem } from '../checklists/service.js';
import type { Db } from '../db/index.js';
import type { NoteEvents } from '../events.js';
import { HttpError } from '../http/errors.js';
import { parse } from '../http/validate.js';
import { logger } from '../logger.js';
import { noteBody, noteTitle, updateNoteSchema } from '../notes/schemas.js';
import { createNote, getNote, listNotes, updateNote } from '../notes/service.js';
import { searchQuery } from '../search/schemas.js';
import { searchNotes } from '../search/service.js';
import { granteeEmail, putShareSchema } from '../shares/schemas.js';
import { putShare } from '../shares/service.js';
import { listTeams } from '../teams/service.js';

const noteId = z.uuid().describe('The note id');
const version = z
  .number()
  .int()
  .min(1)
  .describe('The version you last read; a stale version fails with version_conflict');

const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

/** Runs a tool body; HttpErrors become tool errors with the same code and message as REST. */
async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await body());
  } catch (err) {
    if (err instanceof HttpError) {
      const { code, message, details, extra } = err;
      return {
        ...json({ error: { code, message, ...(details && { details }), ...extra } }),
        isError: true,
      };
    }
    logger.error({ err }, 'mcp tool failed');
    return {
      ...json({ error: { code: 'internal', message: 'Internal server error' } }),
      isError: true,
    };
  }
}

/**
 * An MCP server bound to one caller: every tool acts as that user through the same services, access
 * checks and live events as REST.
 */
export function buildMcpServer(db: Db, userId: string, events: NoteEvents): McpServer {
  const server = new McpServer({ name: 'team-notes', version: '0.1.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'list_teams',
    { description: 'Teams you belong to, with your role in each.', annotations: readOnly },
    () => run(async () => ({ teams: await listTeams(db, userId) })),
  );

  server.registerTool(
    'search_notes',
    {
      description:
        'Notes you can read. With q, a ranked keyword search over titles, bodies and checklist items ' +
        '(every word must match; word starts and title typos count). For a vague question, try ' +
        'several short keyword searches. Without q, the most recently updated notes.',
      inputSchema: {
        q: searchQuery.optional().describe('Keywords'),
        scope: z.enum(['all', 'owned', 'shared']).default('all'),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: readOnly,
    },
    ({ q, ...input }) =>
      run(async () => ({
        notes: q
          ? await searchNotes(db, userId, { ...input, q })
          : await listNotes(db, userId, input),
      })),
  );

  server.registerTool(
    'get_note',
    {
      description: 'One note with its checklist, version and your role on it.',
      inputSchema: { noteId },
      annotations: readOnly,
    },
    (args) => run(async () => ({ note: await getNote(db, userId, args.noteId) })),
  );

  server.registerTool(
    'create_note',
    {
      description: 'Create a note you own, optionally with a starting checklist.',
      inputSchema: {
        title: noteTitle,
        body: noteBody.optional(),
        items: newItemsSchema.optional(),
      },
    },
    ({ title, body = '', items = [] }) =>
      run(async () => ({ note: await createNote(db, userId, { title, body, items }) })),
  );

  server.registerTool(
    'update_note',
    {
      description: "Change a note's title or body. Needs editor access and the current version.",
      inputSchema: { noteId, version, title: noteTitle.optional(), body: noteBody.optional() },
    },
    ({ noteId: id, version: expected, ...fields }) =>
      run(async () => {
        const input = parse(updateNoteSchema, fields);
        const note = await updateNote(db, userId, id, expected, input);
        const { title, body, version: current, updatedAt } = note;
        events.publish({
          type: 'note.updated',
          noteId: id,
          by: userId,
          note: { title, body, version: current, updatedAt },
        });
        return { note };
      }),
  );

  server.registerTool(
    'add_item',
    {
      description:
        'Add a checklist item: after another item id, null for the top, or omit for the bottom.',
      inputSchema: { noteId, text: itemText, after: itemAfter },
    },
    ({ noteId: id, text, after }) =>
      run(async () => {
        const placed = await addItem(db, userId, id, { text, done: false, after });
        events.publish({ type: 'item.added', noteId: id, by: userId, ...placed });
        return { item: placed.item };
      }),
  );

  server.registerTool(
    'update_item',
    {
      description:
        'Tick, rename or move a checklist item. Needs editor access and the item’s current version.',
      inputSchema: {
        noteId,
        itemId: z.uuid(),
        version,
        text: itemText.optional(),
        done: z.boolean().optional(),
        after: itemAfter,
      },
    },
    ({ noteId: id, itemId, version: expected, ...fields }) =>
      run(async () => {
        const input = parse(updateItemSchema, fields);
        const placed = await updateItem(db, userId, id, itemId, expected, input);
        events.publish({ type: 'item.updated', noteId: id, by: userId, ...placed });
        return { item: placed.item };
      }),
  );

  server.registerTool(
    'delete_item',
    {
      description: 'Remove a checklist item. Needs editor access.',
      inputSchema: { noteId, itemId: z.uuid() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ noteId: id, itemId }) =>
      run(async () => {
        await deleteItem(db, userId, id, itemId);
        events.publish({ type: 'item.deleted', noteId: id, by: userId, itemId });
        return { deleted: itemId };
      }),
  );

  server.registerTool(
    'share_note',
    {
      description:
        'Share a note you own with a user (by email) or one of your teams, as viewer or editor. ' +
        'Sharing again changes the role.',
      inputSchema: {
        noteId,
        userEmail: granteeEmail.optional(),
        teamId: z.uuid().optional(),
        role: z.enum(['viewer', 'editor']),
      },
    },
    ({ noteId: id, ...fields }) =>
      run(async () => {
        const share = await putShare(db, userId, id, parse(putShareSchema, fields));
        events.publish({ type: 'access.changed', noteId: id });
        return { share };
      }),
  );

  return server;
}
