-- Additive (team m11). Price alerts on the SPEC section 12 tables users / watches / alerts, without accounts.
-- A watch is owned by an unguessable token: only its SHA-256 hash is stored (token_hash), never the token itself.
-- The one contact kept is the Telegram chat id the user linked (telegram_chat_id), and it is dropped when the watch
-- stops or expires. See src/watches.ts and src/telegram.ts.
-- D1 applies this file statement by statement: plain SQL only, and no semicolons inside comments or string literals.

-- watches.user_id is NOT NULL with a foreign key to users, and users.email is NOT NULL UNIQUE. Anonymous watches
-- all point at this one placeholder row (the .invalid domain can never be a real mailbox): no user data is stored.
INSERT OR IGNORE INTO users (email, marketing_consent, created_at)
  VALUES ('anonymous-watches@watches.invalid', 0, '2026-09-29T00:00:00.000Z');

ALTER TABLE watches ADD COLUMN token_hash TEXT;
-- The validated search (JSON of SearchRequest) the watch re-checks.
ALTER TABLE watches ADD COLUMN request_json TEXT;
-- Salted hash of the creating client (the per-client cap). Never the address itself.
ALTER TABLE watches ADD COLUMN client_hash TEXT;
ALTER TABLE watches ADD COLUMN created_at TEXT;
-- NULL until the user opens the bot link (a pending watch).
ALTER TABLE watches ADD COLUMN telegram_chat_id TEXT;
ALTER TABLE watches ADD COLUMN last_checked_at TEXT;
-- Whole-party total in ILS the first time the watch saw a price: the drop percentage is measured against it.
ALTER TABLE watches ADD COLUMN baseline_ils REAL;
-- Whole-party total in ILS of the last alert sent: the same price level is not announced again.
ALTER TABLE watches ADD COLUMN last_alert_ils REAL;
-- When the fare behind last_price_amount was fetched (its prices.checked_at): the age shown next to that cached price.
ALTER TABLE watches ADD COLUMN last_price_at TEXT;

ALTER TABLE alerts ADD COLUMN sent_telegram INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_watches_token ON watches(token_hash);
CREATE INDEX IF NOT EXISTS idx_watches_client ON watches(client_hash, active, expires_at);
CREATE INDEX IF NOT EXISTS idx_watches_chat ON watches(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_watches_due ON watches(active, last_checked_at);
