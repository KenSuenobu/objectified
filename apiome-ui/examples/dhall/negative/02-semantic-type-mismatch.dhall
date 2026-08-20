-- Type checking fails: the annotation says Natural and the value is Text, so
-- `dhall-to-json` produces nothing.
let count
    : Natural
    = "not a number"

let Order = { orderId : Text, quantity : Natural }

let order
    : Order
    = { orderId = "ORD-00000001", quantity = count }

in  { Order, order }
