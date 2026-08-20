# HCL form plus the service-mesh configuration entries: a service-defaults, a
# service-resolver with subsets, a service-splitter and a service-router. The router is
# the only one that carries path semantics; the rest are traffic policy.

services {
  id      = "payments-1"
  name    = "payments"
  tags    = ["v3", "grpc", "canary=false"]
  address = "10.30.0.11"
  port    = 8443

  meta = {
    version  = "3.4.1"
    protocol = "grpc"
  }

  connect {
    sidecar_service {
      port = 20000
      proxy {
        upstreams = [
          {
            destination_name = "ledger"
            local_bind_port  = 9101
          },
          {
            destination_name = "fraud"
            local_bind_port  = 9102
            config = {
              connect_timeout_ms = 2000
            }
          }
        ]
      }
    }
  }

  checks = [
    {
      name     = "payments gRPC"
      grpc     = "10.30.0.11:8443/grpc.health.v1.Health"
      grpc_use_tls = true
      interval = "10s"
    },
    {
      name    = "payments alias"
      alias_service = "payments"
    }
  ]
}

Kind = "service-router"
Name = "payments"
Routes = [
  {
    Match {
      HTTP {
        PathPrefix = "/v3/payments/authorizations"
        Methods    = ["POST"]
        Header = [
          {
            Name  = "x-employee"
            Exact = "true"
          }
        ]
      }
    }
    Destination {
      Service       = "payments"
      ServiceSubset = "canary"
      RequestTimeout = "20s"
      NumRetries     = 2
      RetryOnConnectFailure = true
    }
  },
  {
    Match {
      HTTP {
        PathExact = "/v3/payments/healthz"
      }
    }
    Destination {
      Service = "payments"
      ServiceSubset = "stable"
    }
  },
  {
    Match {
      HTTP {
        PathRegex = "/v3/payments/authorizations/[a-z0-9-]+/captures"
        QueryParam = [
          {
            Name  = "mode"
            Exact = "final"
          }
        ]
      }
    }
    Destination {
      Service = "payments"
      PrefixRewrite = "/internal/captures"
    }
  }
]
