-- Above the divider: types a JSON Schema projection can carry.
-- Below it: Dhall constructs that exceed it, which FMT-8.5 requires declared as limits.

let Prelude = ./prelude.dhall

-- ---------------------------------------------------------------- expressible

let Scalars =
      { text : Text
      , count : Natural
      , signed : Integer
      , ratio : Double
      , flag : Bool
      , nothing : Optional Text
      , when : Text
      }

let Level = < Debug | Info | Warn | Error >

let Shape = < Circle : { radius : Double } | Square : { side : Double } | Point >

let Collections =
      { items : List Text
      , pairs : List { mapKey : Text, mapValue : Natural }
      , nested : List (List Natural)
      , optionalList : Optional (List Text)
      }

let Nested = { inner : { deep : { value : Natural } } }

let WithDefaults =
      { Type = { level : Level, retries : Natural, label : Text }
      , default = { level = Level.Info, retries = 3, label = "unnamed" }
      }

let recordTypeMerge = Scalars //\\ { extra : Bool }

let recordPrefer = { a = 1 } /\ { b = 2 }

-- ---------------------------------------------------------------- declared limits

-- Functions: Dhall types are values, so a schema can be *computed*.
let Page = \(a : Type) -> { items : List a, total : Natural, cursor : Optional Text }

let OrderPage = Page Text

-- Dependent-ish construction: the record's shape depends on a parameter.
let withEnvelope =
      \(payload : Type) ->
      \(withTrace : Bool) ->
        { payload : payload
        , meta : List { mapKey : Text, mapValue : Text }
        }

-- Fold and list comprehension at type-check time.
let total = Prelude.Natural.sum [ 1, 2, 3 ]

-- Imports as values, including one with an integrity hash.
let remoteType =
      ./shared.dhall sha256:0000000000000000000000000000000000000000000000000000000000000000

in  { Scalars
    , Level
    , Shape
    , Collections
    , Nested
    , WithDefaults
    , recordTypeMerge
    , recordPrefer
    , Page
    , OrderPage
    , withEnvelope
    , total
    }
