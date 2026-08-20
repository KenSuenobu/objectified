-- PostgreSQL dialect: enum type, identity column, checks, foreign keys, comments.

CREATE SCHEMA commerce;

CREATE TYPE commerce.order_status AS ENUM ('new', 'paid', 'shipped', 'cancelled');

CREATE TABLE commerce.customer (
    customer_id   text PRIMARY KEY,
    display_name  text        NOT NULL,
    email         text        NOT NULL UNIQUE,
    country_code  char(2)     NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_country_code_upper CHECK (country_code = upper(country_code))
);

COMMENT ON TABLE commerce.customer IS 'One row per customer account.';
COMMENT ON COLUMN commerce.customer.email IS 'Login address; unique across the tenant.';

CREATE TABLE commerce."order" (
    order_id     text                    PRIMARY KEY,
    customer_id  text                    NOT NULL,
    status       commerce.order_status   NOT NULL DEFAULT 'new',
    placed_at    timestamptz             NOT NULL DEFAULT now(),
    total_amount numeric(13,2)           NOT NULL DEFAULT 0,
    currency     char(3)                 NOT NULL,
    note         text,
    CONSTRAINT order_customer_fk
        FOREIGN KEY (customer_id) REFERENCES commerce.customer (customer_id)
        ON DELETE RESTRICT,
    CONSTRAINT order_total_non_negative CHECK (total_amount >= 0)
);

CREATE TABLE commerce.order_line (
    order_id    text          NOT NULL,
    line_number integer       NOT NULL,
    sku         text          NOT NULL,
    quantity    numeric(9,3)  NOT NULL,
    unit_price  numeric(13,4) NOT NULL,
    PRIMARY KEY (order_id, line_number),
    FOREIGN KEY (order_id) REFERENCES commerce."order" (order_id) ON DELETE CASCADE,
    CHECK (quantity > 0)
);

CREATE INDEX order_customer_idx ON commerce."order" (customer_id);
CREATE INDEX order_placed_at_idx ON commerce."order" (placed_at DESC);
CREATE UNIQUE INDEX customer_email_lower_idx ON commerce.customer (lower(email));

CREATE VIEW commerce.open_orders AS
SELECT order_id, customer_id, placed_at, total_amount
FROM commerce."order"
WHERE status IN ('new', 'paid');
