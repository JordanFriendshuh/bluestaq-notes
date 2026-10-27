-- position holds fractional-indexing keys, which sort by byte value, so it needs the C collation.
CREATE TABLE note_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id    uuid NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  text       text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  done       boolean NOT NULL DEFAULT false,
  position   text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, position)
);
