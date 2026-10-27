import type { Generated, Selectable } from 'kysely';

// Columns are camelCase here; CamelCasePlugin maps them to the snake_case names in SQL.
export interface UsersTable {
  id: Generated<string>;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: Generated<Date>;
}

export type TeamRole = 'owner' | 'member';

export interface TeamsTable {
  id: Generated<string>;
  name: string;
  createdBy: string | null;
  createdAt: Generated<Date>;
}

export interface TeamMembersTable {
  teamId: string;
  userId: string;
  role: TeamRole;
  createdAt: Generated<Date>;
}

export interface NotesTable {
  id: Generated<string>;
  ownerId: string;
  title: string;
  body: Generated<string>;
  version: Generated<number>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface NoteItemsTable {
  id: Generated<string>;
  noteId: string;
  text: string;
  done: Generated<boolean>;
  position: string;
  version: Generated<number>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export type ShareRole = 'viewer' | 'editor';

export interface NoteSharesTable {
  id: Generated<string>;
  noteId: string;
  userId: string | null;
  teamId: string | null;
  role: ShareRole;
  createdAt: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  teams: TeamsTable;
  teamMembers: TeamMembersTable;
  notes: NotesTable;
  noteItems: NoteItemsTable;
  noteShares: NoteSharesTable;
}

export type UserRow = Selectable<UsersTable>;
export type NoteRow = Selectable<NotesTable>;
