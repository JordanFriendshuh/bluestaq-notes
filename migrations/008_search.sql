-- Each text is indexed twice: 'simple' keeps words as typed, so prefixes match while the user is still
-- typing ("meetin" finds "meeting"); 'english' stems them, so "meetings" finds "meeting".
ALTER TABLE notes ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('english', title), 'A') ||
  setweight(to_tsvector('simple', body), 'B') || setweight(to_tsvector('english', body), 'B')
) STORED;
CREATE INDEX notes_search_idx ON notes USING gin (search);

ALTER TABLE note_items ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', text) || to_tsvector('english', text)
) STORED;
CREATE INDEX note_items_search_idx ON note_items USING gin (search);
