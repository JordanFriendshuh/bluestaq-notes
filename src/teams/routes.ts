import { Router } from 'express';
import { callerId, requireAuth } from '../auth/middleware.js';
import type { TokenSettings } from '../auth/tokens.js';
import type { Db } from '../db/index.js';
import { parse } from '../http/validate.js';
import {
  addMemberSchema,
  createTeamSchema,
  memberParamsSchema,
  teamParamsSchema,
} from './schemas.js';
import { addMember, createTeam, getTeam, listTeams, removeMember } from './service.js';

export function teamRoutes(db: Db, settings: TokenSettings): Router {
  const router = Router();
  router.use('/teams', requireAuth(settings));

  router.post('/teams', async (req, res) => {
    const input = parse(createTeamSchema, req.body);
    res.status(201).json({ team: await createTeam(db, callerId(req), input) });
  });

  router.get('/teams', async (req, res) => {
    res.json({ teams: await listTeams(db, callerId(req)) });
  });

  router.get('/teams/:id', async (req, res) => {
    const { id } = parse(teamParamsSchema, req.params);
    res.json({ team: await getTeam(db, callerId(req), id) });
  });

  router.post('/teams/:id/members', async (req, res) => {
    const { id } = parse(teamParamsSchema, req.params);
    const input = parse(addMemberSchema, req.body);
    res.status(201).json({ member: await addMember(db, callerId(req), id, input) });
  });

  router.delete('/teams/:id/members/:userId', async (req, res) => {
    const { id, userId } = parse(memberParamsSchema, req.params);
    await removeMember(db, callerId(req), id, userId);
    res.status(204).end();
  });

  return router;
}
