CREATE TABLE note_shares (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id    uuid NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users (id) ON DELETE CASCADE,
  team_id    uuid REFERENCES teams (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(user_id, team_id) = 1),
  UNIQUE (note_id, user_id),
  UNIQUE (note_id, team_id)
);

-- "Shared with me" looks grants up by grantee.
CREATE INDEX note_shares_user_id_idx ON note_shares (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX note_shares_team_id_idx ON note_shares (team_id) WHERE team_id IS NOT NULL;
