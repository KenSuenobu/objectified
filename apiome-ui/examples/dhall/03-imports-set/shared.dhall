-- Imported module: the value types the package composes.
let Currency = < EUR | GBP | USD >

let Address =
      { line1 : Text
      , line2 : Optional Text
      , city : Text
      , postalCode : Text
      , countryCode : Text
      }

let Money = { value : Natural, currency : Currency }

in  { Currency, Address, Money }
