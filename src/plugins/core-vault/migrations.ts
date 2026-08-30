import type { Migration } from '../../main/core/db'

export const VAULT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY,
  rel_path   TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  links      TEXT NOT NULL DEFAULT '[]',
  tags       TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  device_id  TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0
);

-- FTS over title + raw content; rowid mirrors notes.id
CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tokenize='trigram');
`
  }
]
