import type { Request, Response } from 'express';
import { HttpError } from './errors.js';

// A strong ETag ("3") or, for convenience with curl, a bare number. Nine digits keeps it inside int4.
const IF_MATCH = /^(?:"(\d{1,9})"|(\d{1,9}))$/;

/** The version the client last saw, from If-Match; 428 if missing, 400 if it isn't a version ETag. */
export function expectedVersion(req: Request): number {
  const header = req.get('If-Match');
  if (header === undefined) {
    throw new HttpError(
      428,
      'precondition_required',
      'Send If-Match with the version you last read',
    );
  }
  const match = IF_MATCH.exec(header.trim());
  if (!match)
    throw new HttpError(400, 'invalid_if_match', 'If-Match must be a version ETag like "3"');
  return Number(match[1] ?? match[2]);
}

export function setVersionTag(res: Response, version: number): void {
  res.set('ETag', `"${version}"`);
}

/** A 409 carrying the current copy, so the client can merge and retry. */
export function versionConflict(current: object): HttpError {
  return new HttpError(409, 'version_conflict', 'Someone else changed this first', undefined, {
    current,
  });
}
