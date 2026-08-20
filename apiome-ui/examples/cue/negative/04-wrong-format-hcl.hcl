variable "region" {
  type    = string
  default = "eu-west-1"
}

resource "example_service" "orders" {
  name     = "orders"
  replicas = 4

  resources {
    cpu    = "1000m"
    memory = "2Gi"
  }
}
