let OrderStatus = < New | Paid | Shipped | Cancelled >

let OrderLine =
      { sku : Text
      , quantity : Natural
      , unitPrice : { value : Natural, currency : < EUR | GBP
