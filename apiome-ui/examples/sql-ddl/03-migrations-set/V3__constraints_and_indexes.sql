-- Migration 3: the constraints and indexes that define the final state.

ALTER TABLE account ALTER COLUMN email SET NOT NULL;
ALTER TABLE account ADD CONSTRAINT account_username_uq UNIQUE (username);
ALTER TABLE account ADD CONSTRAINT account_country_upper
    CHECK (country_code IS NULL OR country_code = upper(country_code));

ALTER TABLE ledger_entry
    ADD CONSTRAINT ledger_entry_amount_nonzero CHECK (amount <> 0);

CREATE INDEX ledger_entry_account_idx ON ledger_entry (account_id, booked_at DESC);

CREATE TABLE ledger_entry_tag (
    entry_id BIGINT NOT NULL REFERENCES ledger_entry (entry_id) ON DELETE CASCADE,
    tag      VARCHAR(40) NOT NULL,
    PRIMARY KEY (entry_id, tag)
);
