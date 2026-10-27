import { EventEmitter } from 'node:events';
import type { ChecklistItem } from './checklists/service.js';

/** A change made through REST, pushed live to everyone viewing the note. `by` is the editor's user id. */
export type NoteEvent =
  | {
      type: 'note.updated';
      noteId: string;
      by: string;
      note: { title: string; body: string; version: number; updatedAt: Date };
    }
  | { type: 'note.deleted'; noteId: string; by: string }
  | { type: 'item.added'; noteId: string; by: string; item: ChecklistItem; after: string | null }
  | {
      type: 'item.updated';
      noteId: string;
      by: string;
      item: ChecklistItem;
      after?: string | null;
    }
  | { type: 'item.deleted'; noteId: string; by: string; itemId: string };

/** In-process fan-out of note changes; more than one process would need Redis pub/sub here. */
export class NoteEvents {
  private readonly emitter = new EventEmitter();

  publish(event: NoteEvent): void {
    this.emitter.emit('event', event);
  }

  /** Calls `listener` for every event until the returned function is called. */
  subscribe(listener: (event: NoteEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
