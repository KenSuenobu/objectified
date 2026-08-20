{{ config(materialized='table') }}

-- The ref() calls are the lineage edges FMT-5.4 must record as relationships.
with orders as (
    select * from {{ ref('stg_orders') }}
),

customers as (
    select * from {{ ref('stg_customers') }}
)

select
    orders.order_id,
    orders.customer_id,
    customers.country_code as customer_country,
    orders.placed_at,
    orders.total_amount
from orders
left join customers
    on orders.customer_id = customers.customer_id
