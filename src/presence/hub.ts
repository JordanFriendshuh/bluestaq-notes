import type { WebSocket } from 'ws';
import type { NoteEvent } from '../events.js';
import type { NoteRole } from '../notes/access.js';

export interface Cursor {
  field: string;
  anchor: number;
  head: number;
}

export interface Member {
  userId: string;
  displayName: string;
  role: NoteRole;
  mode: 'viewing' | 'editing';
  cursor?: Cursor;
}

/** Who is in each note's room, per connection; in memory, so it only covers this process. */
export class PresenceHub {
  private readonly rooms = new Map<string, Map<WebSocket, Member>>();

  /** `maxBufferedBytes`: a client this far behind on reading is dropped instead of buffered forever. */
  constructor(private readonly maxBufferedBytes: number) {}

  join(noteId: string, socket: WebSocket, member: Member): void {
    let room = this.rooms.get(noteId);
    if (!room) {
      room = new Map();
      this.rooms.set(noteId, room);
    }
    room.set(socket, member);
    this.broadcastPresence(noteId);
  }

  leave(noteId: string, socket: WebSocket): void {
    const room = this.rooms.get(noteId);
    if (!room?.delete(socket)) return;
    if (room.size === 0) this.rooms.delete(noteId);
    else this.broadcastPresence(noteId);
  }

  leaveAll(socket: WebSocket): void {
    for (const noteId of [...this.rooms.keys()]) this.leave(noteId, socket);
  }

  roomCount(socket: WebSocket): number {
    let count = 0;
    for (const room of this.rooms.values()) if (room.has(socket)) count += 1;
    return count;
  }

  /** A snapshot of every membership, or only one note's, safe to iterate while rooms change. */
  memberships(noteId?: string): { noteId: string; socket: WebSocket; member: Member }[] {
    const rooms =
      noteId === undefined ? [...this.rooms] : [[noteId, this.rooms.get(noteId)] as const];
    return rooms.flatMap(([id, room]) =>
      [...(room ?? [])].map(([socket, member]) => ({ noteId: id, socket, member })),
    );
  }

  member(noteId: string, socket: WebSocket): Member | undefined {
    return this.rooms.get(noteId)?.get(socket);
  }

  /** Applies a change to a member's state and tells the room. */
  update(noteId: string, socket: WebSocket, change: Partial<Member>): void {
    const member = this.member(noteId, socket);
    if (!member) return;
    Object.assign(member, change);
    this.broadcastPresence(noteId);
  }

  /** Forwards a REST change to the note's room; a deleted note's room is closed. */
  forward(event: NoteEvent): void {
    this.broadcast(event.noteId, event);
    if (event.type === 'note.deleted') this.rooms.delete(event.noteId);
  }

  private broadcastPresence(noteId: string): void {
    const room = this.rooms.get(noteId);
    if (!room) return;
    const users = [...room.values()].map(({ userId, displayName, mode, cursor }) => ({
      userId,
      displayName,
      mode,
      ...(cursor && { cursor }),
    }));
    this.broadcast(noteId, { type: 'presence', noteId, users });
  }

  private broadcast(noteId: string, message: object): void {
    const room = this.rooms.get(noteId);
    if (!room) return;
    const data = JSON.stringify(message);
    for (const socket of room.keys()) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.bufferedAmount > this.maxBufferedBytes) socket.terminate();
      else socket.send(data);
    }
  }
}
