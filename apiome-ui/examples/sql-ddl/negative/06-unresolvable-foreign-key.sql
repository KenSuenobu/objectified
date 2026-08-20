-- The foreign key names a table that no statement in this script creates and no
-- other file in the set supplies, so the relationship cannot be resolved.
CREATE TABLE invoice (
    invoice_id  VARCHAR(12) PRIMARY KEY,
    customer_id VARCHAR(20) NOT NULL,
    amount      NUMERIC(13,2) NOT NULL,
    CONSTRAINT invoice_customer_fk
        FOREIGN KEY (customer_id) REFERENCES customer_master (customer_id)
);
