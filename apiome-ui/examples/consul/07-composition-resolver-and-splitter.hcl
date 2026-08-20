# Within-document composition: the three configuration entries that only mean anything
# together — a resolver defining subsets, a splitter distributing across them, and a
# router selecting by path. Consul evaluates them as a chain: router → splitter →
# resolver.

Kind = "service-defaults"
Name = "checkout"
Protocol = "http"

MeshGateway {
  Mode = "local"
}

Kind = "service-resolver"
Name = "checkout"
DefaultSubset = "stable"

Subsets = {
  stable = {
    Filter = "Service.Meta.version == 3.4.1"
  }
  canary = {
    Filter = "Service.Meta.version == 3.5.0-rc.2"
  }
  failover = {
    Filter = "Service.Meta.region == eu-central-1"
    OnlyPassing = true
  }
}

Failover = {
  "*" = {
    Targets = [
      { Service = "checkout", ServiceSubset = "failover" },
      { Datacenter = "eu-central-1" }
    ]
  }
}

Kind = "service-splitter"
Name = "checkout"
Splits = [
  {
    Weight        = 90
    ServiceSubset = "stable"
    RequestHeaders {
      Set {
        x-checkout-variant = "stable"
      }
    }
  },
  {
    Weight        = 10
    ServiceSubset = "canary"
    RequestHeaders {
      Set {
        x-checkout-variant = "canary"
      }
    }
  }
]

Kind = "service-router"
Name = "checkout"
Routes = [
  {
    Match {
      HTTP {
        PathPrefix = "/v3/checkout"
        Header = [
          {
            Name  = "x-employee"
            Exact = "true"
          }
        ]
      }
    }
    Destination {
      Service       = "checkout"
      ServiceSubset = "canary"
    }
  },
  {
    Match {
      HTTP {
        PathPrefix = "/v3/checkout"
      }
    }
    Destination {
      # No subset: falls through to the splitter, then the resolver.
      Service        = "checkout"
      RequestTimeout = "20s"
      NumRetries     = 2
    }
  }
]
