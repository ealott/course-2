-- People. A user without email/password is a "no-login" member someone added
-- (e.g. Grandma); they can be given a one-time login link later.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  zelle TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- One-time login links (new device, password reset, setting up a no-login member).
CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE split_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id);

CREATE TABLE hauls (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  organizer_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  store TEXT,
  purchased_on TEXT,
  pickup TEXT,
  tax_rate REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX hauls_group ON hauls(group_id, created_at);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  haul_id TEXT NOT NULL REFERENCES hauls(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  item_number TEXT,
  barcode TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'item',
  shares INTEGER NOT NULL DEFAULT 1 CHECK (shares >= 1),
  taxable INTEGER NOT NULL DEFAULT 0,
  expires_on TEXT,
  notes TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX items_haul ON items(haul_id, position);

-- How many portions of an item each person takes.
CREATE TABLE claims (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shares INTEGER NOT NULL CHECK (shares > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX claims_user ON claims(user_id);

-- Per person per haul: done selecting, what they say they sent, what the organizer confirmed.
CREATE TABLE settlements (
  haul_id TEXT NOT NULL REFERENCES hauls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confirmed_at INTEGER,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  paid_at INTEGER,
  verified_cents INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  PRIMARY KEY (haul_id, user_id)
);

-- Barcode memory: what this group called a product and paid for it last time.
CREATE TABLE products (
  group_id TEXT NOT NULL REFERENCES split_groups(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  shares INTEGER,
  price_cents INTEGER,
  taxable INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, code)
);
