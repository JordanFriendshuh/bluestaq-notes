-- Realistic volume for EXPLAIN ANALYZE: 1,000 users, 200 teams, 50,000 notes, ~270,000 checklist
-- items, ~60,000 shares. User 'active@example.com' owns 300 notes, is on 3 teams and has notes
-- shared with them directly and through those teams. Deterministic (setseed), run on an empty schema.
SELECT setseed(0.42);

CREATE TEMP TABLE pool (words text[], users uuid[], teams uuid[]);
INSERT INTO pool (words) VALUES (string_to_array(
  'meeting roadmap budget release deploy review design sprint retro planning customer feedback ' ||
  'invoice contract hiring onboarding incident outage postmortem metrics dashboard migration ' ||
  'database index query cache latency launch marketing campaign pricing quarter goals okr ' ||
  'standup demo backlog ticket bug feature security audit compliance vendor travel offsite ' ||
  'agenda notes summary action decision risk timeline milestone estimate dependency api ' ||
  'frontend backend mobile infra kubernetes terraform monitoring alerting oncall runbook ' ||
  'groceries recipe workout reading podcast garden birthday gift vacation flight hotel', ' '));

-- Volatile functions, so every row gets its own random pick.
CREATE FUNCTION pg_temp.phrase(n int) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT string_agg(p.words[1 + floor(random() * cardinality(p.words))::int], ' ')
  FROM pool p, generate_series(1, n)
$$;
-- A random user other than the active user (who is users[1]).
CREATE FUNCTION pg_temp.other_user() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT p.users[2 + floor(random() * (cardinality(p.users) - 1))::int] FROM pool p
$$;
CREATE FUNCTION pg_temp.any_team() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT p.teams[1 + floor(random() * cardinality(p.teams))::int] FROM pool p
$$;

INSERT INTO users (email, display_name, password_hash)
SELECT CASE WHEN i = 1 THEN 'active@example.com' ELSE 'user' || i || '@example.com' END,
       'User ' || i, 'not-a-real-hash'
FROM generate_series(1, 1000) i;
UPDATE pool SET users = ARRAY(SELECT id FROM users ORDER BY email <> 'active@example.com', email);

INSERT INTO teams (name, created_by) SELECT 'Team ' || i, pg_temp.other_user() FROM generate_series(1, 200) i;
UPDATE pool SET teams = ARRAY(SELECT id FROM teams ORDER BY name);

INSERT INTO team_members (team_id, user_id, role)
SELECT t.id, pg_temp.other_user(), 'member'
FROM teams t CROSS JOIN LATERAL generate_series(1, 5 + floor(random() * 6)::int + 0 * length(t.name)) k
ON CONFLICT DO NOTHING;
UPDATE team_members tm SET role = 'owner'
WHERE (tm.team_id, tm.user_id) IN (SELECT team_id, min(user_id::text)::uuid FROM team_members GROUP BY team_id);
INSERT INTO team_members (team_id, user_id, role)
SELECT t, (SELECT users[1] FROM pool), 'member' FROM (SELECT unnest(teams[1:3]) t FROM pool) x;

INSERT INTO notes (owner_id, title, body, created_at, updated_at)
SELECT CASE WHEN i <= 300 THEN (SELECT users[1] FROM pool) ELSE pg_temp.other_user() END,
       initcap(pg_temp.phrase(2 + floor(random() * 4)::int)),
       pg_temp.phrase(20 + floor(random() * 80)::int),
       now() - random() * interval '365 days', now() - random() * interval '90 days'
FROM generate_series(1, 50000) i;

-- 'a' + one base-62 digit is a valid fractional-indexing integer key, so later inserts can go between.
INSERT INTO note_items (note_id, text, done, position)
SELECT n.id, pg_temp.phrase(2 + floor(random() * 5)::int), random() < 0.4,
       'a' || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', k, 1)
FROM notes n
CROSS JOIN LATERAL generate_series(1,
  CASE WHEN random() < 0.6 + 0 * length(n.title) THEN 3 + floor(random() * 13)::int ELSE 0 END) k;

INSERT INTO note_shares (note_id, user_id, role)
SELECT id, pg_temp.other_user(), CASE WHEN random() < 0.3 THEN 'editor' ELSE 'viewer' END
FROM notes ORDER BY random() LIMIT 40000
ON CONFLICT DO NOTHING;
DELETE FROM note_shares s USING notes n WHERE s.note_id = n.id AND s.user_id = n.owner_id;
INSERT INTO note_shares (note_id, team_id, role)
SELECT id, pg_temp.any_team(), CASE WHEN random() < 0.3 THEN 'editor' ELSE 'viewer' END
FROM notes ORDER BY random() LIMIT 20000
ON CONFLICT DO NOTHING;
-- The active user's inbox: 400 direct shares on top of what their 3 teams receive.
INSERT INTO note_shares (note_id, user_id, role)
SELECT id, (SELECT users[1] FROM pool), 'viewer'
FROM notes WHERE owner_id <> (SELECT users[1] FROM pool) ORDER BY random() LIMIT 400
ON CONFLICT DO NOTHING;

ANALYZE;
