CREATE SCHEMA commerce;

CREATE TABLE commerce.customer (
    customer_id  text PRIMARY KEY,
    display_name text NOT NULL,
    email        text NOT NULL UNIQUE,
    country_code char(2
