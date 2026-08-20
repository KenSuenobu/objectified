-- Migration 1: the initial shape. A migrations directory imports as its FINAL state,
-- so nothing in this file survives unchanged into the canonical model — later
-- migrations rename, widen and constrain it.

CREATE TABLE account (
    account_id  SERIAL PRIMARY KEY,
    login       VARCHAR(40) NOT NULL,
    email       VARCHAR(120),
    created_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entry (
    entry_id   BIGSERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES account (account_id),
    amount     NUMERIC(12,2) NOT NULL,
    booked_at  TIMESTAMP NOT NULL
);
