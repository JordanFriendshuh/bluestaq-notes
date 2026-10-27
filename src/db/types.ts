import type { ColumnType, Generated, Selectable } from 'kysely';

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

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface NotesTable {
  id: Generated<string>;
  ownerId: string;
  title: string;
  body: Generated<string>;
  // pg parses jsonb on read; writes take a JSON string.
  items: ColumnType<ChecklistItem[], string | undefined, string>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  teams: TeamsTable;
  teamMembers: TeamMembersTable;
  notes: NotesTable;
}

export type UserRow = Selectable<UsersTable>;
export type NoteRow = Selectable<NotesTable>;
