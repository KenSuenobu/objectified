-- Platform configuration schema as a team ships one: a record type with a defaults
-- record, enumerated environments, and two concrete services built by amending the
-- default. Reconstructed shape; no upstream text copied.

let Environment = < Dev | Staging | Production >

let Resources =
      { Type = { cpu : Text, memory : Text }
      , default = { cpu = "250m", memory = "512Mi" }
      }

let Probe =
      { Type =
          { path : Text
          , initialDelaySeconds : Natural
          , periodSeconds : Natural
          , failureThreshold : Natural
          }
      , default =
        { path = "/healthz"
        , initialDelaySeconds = 10
        , periodSeconds = 10
        , failureThreshold = 3
        }
      }

let Ingress =
      { Type =
          { enabled : Bool, host : Optional Text, paths : List Text, tls : Bool }
      , default = { enabled = False, host = None Text, paths = [ "/" ], tls = True }
      }

let Service =
      { Type =
          { name : Text
          , env : Environment
          , image : Text
          , replicas : Natural
          , port : Natural
          , resources : Resources.Type
          , liveness : Probe.Type
          , readiness : Probe.Type
          , ingress : Ingress.Type
          , envVars : List { mapKey : Text, mapValue : Text }
          , secrets : List Text
          }
      , default =
        { replicas = 2
        , port = 8080
        , resources = Resources.default
        , liveness = Probe.default
        , readiness = Probe::{ path = "/readyz" }
        , ingress = Ingress.default
        , envVars = [] : List { mapKey : Text, mapValue : Text }
        , secrets = [] : List Text
        }
      }

let orders
    : Service.Type
    = Service::{
      , name = "orders"
      , env = Environment.Production
      , image = "registry.example.com/orders:2.3.0"
      , replicas = 4
      , resources = Resources::{ cpu = "1000m", memory = "2Gi" }
      , ingress = Ingress::{
        , enabled = True
        , host = Some "api.example.com"
        , paths = [ "/v2/orders" ]
        }
      , envVars =
        [ { mapKey = "LOG_LEVEL", mapValue = "info" }
        , { mapKey = "REGION", mapValue = "eu-west-1" }
        ]
      , secrets = [ "orders-db", "orders-signing-key" ]
      }

let catalogue
    : Service.Type
    = Service::{
      , name = "catalogue"
      , env = Environment.Production
      , image = "registry.example.com/catalogue:1.9.4"
      , ingress = Ingress::{
        , enabled = True
        , host = Some "api.example.com"
        , paths = [ "/v2/products" ]
        }
      , envVars = [ { mapKey = "LOG_LEVEL", mapValue = "warn" } ]
      }

in  { Environment
    , Resources
    , Probe
    , Ingress
    , Service
    , services = [ orders, catalogue ]
    }
