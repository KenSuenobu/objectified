-- Root of the set: the package file that composes the sibling modules, the conventional
-- Dhall entry point.
let shared = ./shared.dhall

let Shipment =
      { Type =
          { shipmentId : Text
          , destination : shared.Address
          , price : shared.Money
          , weightKg : Double
          , parcels : List { parcelId : Text, fragile : Bool }
          }
      , default = { parcels = [] : List { parcelId : Text, fragile : Bool } }
      }

in  { Shipment, Address = shared.Address, Money = shared.Money }
