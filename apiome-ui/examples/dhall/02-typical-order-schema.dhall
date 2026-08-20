-- Order schema: a record type, a union type, and a default record — the three shapes a
-- Dhall schema file is built from.
let OrderStatus = < New | Paid | Shipped | Cancelled >

let Currency = < EUR | GBP | USD >

let Money = { value : Natural, currency : Currency }

let OrderLine =
      { sku : Text
      , quantity : Natural
      , unitPrice : Money
      , discount : Optional Double
      }

let Order =
      { orderId : Text
      , customerId : Text
      , status : OrderStatus
      , placedAt : Text
      , lines : List OrderLine
      , total : Money
      , note : Optional Text
      }

let defaultOrder
    : Order
    = { orderId = ""
      , customerId = ""
      , status = OrderStatus.New
      , placedAt = ""
      , lines = [] : List OrderLine
      , total = { value = 0, currency = Currency.EUR }
      , note = None Text
      }

in  { OrderStatus
    , Currency
    , Money
    , OrderLine
    , Order
    , defaultOrder
    }
