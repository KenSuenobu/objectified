-- ANSI SQL: the smallest thing a DDL importer must read.
CREATE TABLE beacon (
    beacon_id VARCHAR(16) NOT NULL,
    seen_at   TIMESTAMP   NOT NULL,
    PRIMARY KEY (beacon_id)
);
