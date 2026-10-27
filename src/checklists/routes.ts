import { Router } from 'express';
import { callerId, requireAuth } from '../auth/middleware.js';
import type { TokenSettings } from '../auth/tokens.js';
import type { Db } from '../db/index.js';
import type { NoteEvents } from '../events.js';
import { expectedVersion, setVersionTag } from '../http/preconditions.js';
import { parse } from '../http/validate.js';
import { noteParamsSchema } from '../notes/schemas.js';
import { addItemSchema, itemParamsSchema, updateItemSchema } from './schemas.js';
import { addItem, deleteItem, updateItem } from './service.js';

export function checklistRoutes(db: Db, settings: TokenSettings, events: NoteEvents): Router {
  const router = Router();
  router.use('/notes/:id/items', requireAuth(settings));

  router.post('/notes/:id/items', async (req, res) => {
    const { id } = parse(noteParamsSchema, req.params);
    const input = parse(addItemSchema, req.body);
    const { item, after } = await addItem(db, callerId(req), id, input);
    events.publish({ type: 'item.added', noteId: id, by: callerId(req), item, after });
    res.status(201).json({ item });
  });

  router.patch('/notes/:id/items/:itemId', async (req, res) => {
    const { id, itemId } = parse(itemParamsSchema, req.params);
    const input = parse(updateItemSchema, req.body);
    const placed = await updateItem(db, callerId(req), id, itemId, expectedVersion(req), input);
    events.publish({ type: 'item.updated', noteId: id, by: callerId(req), ...placed });
    const { item } = placed;
    setVersionTag(res, item.version);
    res.json({ item });
  });

  router.delete('/notes/:id/items/:itemId', async (req, res) => {
    const { id, itemId } = parse(itemParamsSchema, req.params);
    await deleteItem(db, callerId(req), id, itemId);
    events.publish({ type: 'item.deleted', noteId: id, by: callerId(req), itemId });
    res.status(204).end();
  });

  return router;
}
