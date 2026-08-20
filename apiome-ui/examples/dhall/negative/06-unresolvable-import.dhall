-- ./missing.dhall is not in the fileset, so the import cannot be resolved and type
-- checking never starts. The failure must name the missing import.
let shared = ./missing.dhall

let Shipment = { shipmentId : Text, destination : shared.Address }

in  { Shipment }
