import type { Generated, Selectable } from 'kysely';

// Columns are camelCase here; CamelCasePlugin maps them to the snake_case names in SQL.
export interface UsersTable {
  id: Generated<string>;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: Generated<Date>;
}

export interface Database {
  users: UsersTable;
}

export type UserRow = Selectable<UsersTable>;
