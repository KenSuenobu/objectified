-- Union types with payloads plus the `::` completion operator: the two idioms a Dhall
-- schema reader meets most often.

let Currency = < EUR | GBP | USD >

let Payment =
      < Card : { networkToken : Text, expiryMonth : Natural, expiryYear : Natural }
      | BankTransfer : { iban : Text, bic : Optional Text }
      | Cash
      >

let Product =
      { Type =
          { sku : Text
          , name : Text
          , price : Double
          , currency : Currency
          , discontinued : Bool
          , tags : List Text
          }
      , default =
        { currency = Currency.EUR, discontinued = False, tags = [] : List Text }
      }

let widget = Product::{ sku = "WID-0001", name = "Stainless widget 40mm", price = 180.0 }

let gadget =
      Product::{
      , sku = "GAD-0007"
      , name = "Gadget, boxed"
      , price = 42.0
      , tags = [ "hardware", "boxed" ]
      }

let bracket =
      Product::{
      , sku = "BRK-0020"
      , name = "Bracket"
      , price = 1.5
      , discontinued = True
      }

in  { Currency
    , Payment
    , Product
    , catalogue = { version = "2026.08", products = [ widget, gadget, bracket ] }
    }
