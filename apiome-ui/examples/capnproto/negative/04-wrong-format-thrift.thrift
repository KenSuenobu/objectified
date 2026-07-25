namespace java com.example.ping

struct PingRequest {
  1: required string message
}

struct PingResponse {
  1: required string message
  2: optional i64 receivedAt
}

service PingService {
  PingResponse ping(1: PingRequest request)
}
