import { Router } from 'express';
import { callerId, requireAuth } from '../auth/middleware.js';
import type { TokenSettings } from '../auth/tokens.js';
import type { Db } from '../db/index.js';
import type { NoteEvents } from '../events.js';
import { parse } from '../http/validate.js';
import { noteParamsSchema } from '../notes/schemas.js';
import { putShareSchema, shareParamsSchema } from './schemas.js';
import { deleteShare, listShares, putShare } from './service.js';

export function shareRoutes(db: Db, settings: TokenSettings, events: NoteEvents): Router {
  const router = Router();
  router.use('/notes/:id/shares', requireAuth(settings));

  router.get('/notes/:id/shares', async (req, res) => {
    const { id } = parse(noteParamsSchema, req.params);
    res.json({ shares: await listShares(db, callerId(req), id) });
  });

  router.put('/notes/:id/shares', async (req, res) => {
    const { id } = parse(noteParamsSchema, req.params);
    const input = parse(putShareSchema, req.body);
    const share = await putShare(db, callerId(req), id, input);
    // A role change can be a downgrade, so live viewers are re-checked.
    events.publish({ type: 'access.changed', noteId: id });
    res.json({ share });
  });

  router.delete('/notes/:id/shares/:shareId', async (req, res) => {
    const { id, shareId } = parse(shareParamsSchema, req.params);
    await deleteShare(db, callerId(req), id, shareId);
    events.publish({ type: 'access.changed', noteId: id });
    res.status(204).end();
  });

  return router;
}
