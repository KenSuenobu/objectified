-- Migration 2: rename a column, widen another, add one.

ALTER TABLE account RENAME COLUMN login TO username;
ALTER TABLE account ALTER COLUMN email TYPE VARCHAR(255);
ALTER TABLE account ADD COLUMN country_code CHAR(2);

ALTER TABLE ledger_entry ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'EUR';
