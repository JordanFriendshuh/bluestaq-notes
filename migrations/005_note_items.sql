ALTER TABLE notes
  ADD COLUMN items jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array');
