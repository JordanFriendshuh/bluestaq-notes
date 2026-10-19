import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../logger.js';
import { HttpError, notFound } from './errors.js';

export const unknownRoute: RequestHandler = () => {
  throw notFound('Route');
};

/** Turns any thrown error into the standard error body; unexpected errors become a bare 500. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    const { status, code, message, details } = err;
    res.status(status).json({ error: { code, message, ...(details && { details }) } });
    return;
  }
  // express.json() flags client mistakes (bad JSON, too large, unsupported charset) with expose and a 4xx status.
  if (err?.expose === true && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: { code: 'invalid_body', message: err.message } });
    return;
  }
  logger.error({ err, method: req.method, url: req.originalUrl }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
};
