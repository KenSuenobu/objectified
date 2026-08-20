with source as (
    select * from {{ source('raw_commerce', 'orders_raw') }}
)

select
    id            as order_id,
    customer_id   as customer_id,
    placed_at     as placed_at,
    total_amount  as total_amount
from source
where deleted_at is null
