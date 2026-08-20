-- PostgreSQL: composition inside one script — a domain and a composite type reused by
-- several tables, table inheritance, a partitioned parent with two partitions, and a
-- view assembled from three tables.

CREATE DOMAIN sku_code AS varchar(18)
    CHECK (VALUE ~ '^[A-Z]{3}-[0-9]{4}$');

CREATE TYPE money_amount AS (
    minor_units bigint,
    currency    char(3)
);

CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped', 'cancelled');

CREATE TABLE audited (
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text        NOT NULL,
    updated_at timestamptz,
    updated_by text
);

-- Table inheritance: product and service both carry the audited columns.
CREATE TABLE product (
    sku       sku_code PRIMARY KEY,
    name      text NOT NULL,
    price     money_amount NOT NULL
) INHERITS (audited);

CREATE TABLE service (
    code      varchar(12) PRIMARY KEY,
    name      text NOT NULL,
    hourly    money_amount NOT NULL
) INHERITS (audited);

-- Declarative partitioning: one logical table, two physical children.
CREATE TABLE sales_order (
    order_id    text        NOT NULL,
    placed_at   timestamptz NOT NULL,
    status      order_status NOT NULL DEFAULT 'new',
    total       money_amount NOT NULL,
    PRIMARY KEY (order_id, placed_at)
) PARTITION BY RANGE (placed_at);

CREATE TABLE sales_order_2025 PARTITION OF sales_order
    FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

CREATE TABLE sales_order_2026 PARTITION OF sales_order
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE TABLE sales_order_line (
    order_id    text        NOT NULL,
    placed_at   timestamptz NOT NULL,
    line_number integer     NOT NULL,
    sku         sku_code    NOT NULL REFERENCES product (sku),
    quantity    numeric(9,3) NOT NULL CHECK (quantity > 0),
    unit_price  money_amount NOT NULL,
    PRIMARY KEY (order_id, placed_at, line_number),
    FOREIGN KEY (order_id, placed_at) REFERENCES sales_order (order_id, placed_at)
        ON DELETE CASCADE
);

-- A view composed from three tables: its columns are derived, not declared.
CREATE VIEW order_summary AS
SELECT o.order_id,
       o.placed_at,
       o.status,
       count(l.line_number)                       AS line_count,
       sum((l.unit_price).minor_units * l.quantity) AS computed_minor_units,
       max(p.name)                                AS sample_product
FROM   sales_order o
JOIN   sales_order_line l
       ON l.order_id = o.order_id AND l.placed_at = o.placed_at
JOIN   product p ON p.sku = l.sku
GROUP BY o.order_id, o.placed_at, o.status;

CREATE MATERIALIZED VIEW order_summary_daily AS
SELECT date_trunc('day', placed_at) AS day, count(*) AS orders
FROM   sales_order
GROUP BY 1;
