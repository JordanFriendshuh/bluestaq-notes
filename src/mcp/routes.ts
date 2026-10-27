import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router } from 'express';
import { callerId, requireAuth } from '../auth/middleware.js';
import type { TokenSettings } from '../auth/tokens.js';
import type { Db } from '../db/index.js';
import type { NoteEvents } from '../events.js';
import { HttpError } from '../http/errors.js';
import { buildMcpServer } from './tools.js';

/**
 * MCP over Streamable HTTP, stateless: each POST gets a fresh server bound to the token's user, so
 * there are no sessions to store, steal or expire separately from the token.
 */
export function mcpRoutes(db: Db, settings: TokenSettings, events: NoteEvents): Router {
  const router = Router();
  router.use('/mcp', requireAuth(settings));

  router.post('/mcp', async (req, res) => {
    const server = buildMcpServer(db, callerId(req), events);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless servers have no stream to resume (GET) and no session to end (DELETE).
  router.all('/mcp', () => {
    throw new HttpError(405, 'method_not_allowed', 'Use POST for MCP requests');
  });

  return router;
}
