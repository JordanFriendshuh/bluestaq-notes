import { Router } from 'express';
import { callerId, requireAuth } from '../auth/middleware.js';
import type { TokenSettings } from '../auth/tokens.js';
import type { Db } from '../db/index.js';
import type { NoteEvents } from '../events.js';
import { expectedVersion, setVersionTag } from '../http/preconditions.js';
import { parse } from '../http/validate.js';
import {
  createNoteSchema,
  listNotesSchema,
  noteParamsSchema,
  updateNoteSchema,
} from './schemas.js';
import { createNote, deleteNote, getNote, listNotes, updateNote } from './service.js';

export function noteRoutes(db: Db, settings: TokenSettings, events: NoteEvents): Router {
  const router = Router();
  router.use('/notes', requireAuth(settings));

  router.post('/notes', async (req, res) => {
    const input = parse(createNoteSchema, req.body);
    const note = await createNote(db, callerId(req), input);
    setVersionTag(res, note.version);
    res.status(201).json({ note });
  });

  router.get('/notes', async (req, res) => {
    const input = parse(listNotesSchema, req.query);
    res.json({ notes: await listNotes(db, callerId(req), input) });
  });

  router.get('/notes/:id', async (req, res) => {
    const { id } = parse(noteParamsSchema, req.params);
    const note = await getNote(db, callerId(req), id);
    setVersionTag(res, note.version);
    res.json({ note });
  });

  router.patch('/notes/:id', async (req, res) => {
    const { id } = parse(noteParamsSchema, req.params);
    const input = parse(updateNoteSchema, req.body);
    const note = await updateNote(db, callerId(req), id, expectedVersion(req), input);
    const { title, body, version, updatedAt } = note;
    events.publish({
      type: 'note.updated',
      noteId: id,
      by: callerId(req),
      note: { title, body, version, updatedAt },
    });
    setVersionTag(res, note.version);
    res.json({ note });
  });

  router.delete('/notes/:id', async (req, res) => {
    const { id } = parse(noteParamsSchema, req.params);
    await deleteNote(db, callerId(req), id);
    events.publish({ type: 'note.deleted', noteId: id, by: callerId(req) });
    res.status(204).end();
  });

  return router;
}
