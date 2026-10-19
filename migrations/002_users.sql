CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
