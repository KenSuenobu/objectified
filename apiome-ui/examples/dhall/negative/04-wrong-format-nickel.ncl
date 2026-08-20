{
  OrderLine = {
    sku | String
        | doc "Stock keeping unit",
    quantity | Number
             | std.number.Integer,
  },

  Order = {
    orderId | String,
    lines | Array OrderLine,
  },
}
