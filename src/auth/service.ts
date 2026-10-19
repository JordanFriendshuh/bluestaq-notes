import bcrypt from 'bcryptjs';
import type { Db } from '../db/index.js';
import type { UserRow } from '../db/types.js';
import { HttpError } from '../http/errors.js';
import type { LoginInput, RegisterInput } from './schemas.js';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
}

const UNIQUE_VIOLATION = '23505';
const invalidCredentials = () =>
  new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');

// Compared against when the email is unknown, so a miss costs as much time as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

/** Creates a user with a hashed password; a duplicate email (any case) is a 409. */
export async function registerUser(
  db: Db,
  input: RegisterInput,
  bcryptRounds: number,
): Promise<PublicUser> {
  const passwordHash = await bcrypt.hash(input.password, bcryptRounds);
  try {
    const user = await db
      .insertInto('users')
      .values({ email: input.email, displayName: input.displayName, passwordHash })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPublicUser(user);
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new HttpError(409, 'email_taken', 'An account with that email already exists');
    }
    throw err;
  }
}

/** Checks credentials and returns the user; unknown email and wrong password look identical. */
export async function authenticate(db: Db, input: LoginInput): Promise<PublicUser> {
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', input.email)
    .executeTakeFirst();

  const passwordMatches = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordMatches) throw invalidCredentials();
  return toPublicUser(user);
}

export async function findUserById(db: Db, id: string): Promise<PublicUser | undefined> {
  const user = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  return user && toPublicUser(user);
}
