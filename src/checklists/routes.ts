import { Router } from 'express';
import { callerId, requireAuth } from '../auth/middleware.js';
import type { TokenSettings } from '../auth/tokens.js';
import type { Db } from '../db/index.js';
import { parse } from '../http/validate.js';
import { noteParamsSchema } from '../notes/schemas.js';
import { addItemSchema, itemParamsSchema, updateItemSchema } from './schemas.js';
import { addItem, deleteItem, updateItem } from './service.js';

export function checklistRoutes(db: Db, settings: TokenSettings): Router {
  const router = Router();
  router.use('/notes/:id/items', requireAuth(settings));

  router.post('/notes/:id/items', async (req, res) => {
    const { id } = parse(noteParamsSchema, req.params);
    const input = parse(addItemSchema, req.body);
    res.status(201).json({ item: await addItem(db, callerId(req), id, input) });
  });

  router.patch('/notes/:id/items/:itemId', async (req, res) => {
    const { id, itemId } = parse(itemParamsSchema, req.params);
    const input = parse(updateItemSchema, req.body);
    res.json({ item: await updateItem(db, callerId(req), id, itemId, input) });
  });

  router.delete('/notes/:id/items/:itemId', async (req, res) => {
    const { id, itemId } = parse(itemParamsSchema, req.params);
    await deleteItem(db, callerId(req), id, itemId);
    res.status(204).end();
  });

  return router;
}
