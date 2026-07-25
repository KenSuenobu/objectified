// Apache Thrift IDL example — a typical payments service.
//
// An everyday RPC surface: an enum for payment methods, request/response
// structs, a declined-payment exception, and a three-method service.
namespace java com.example.payments

enum PaymentMethod {
  CARD = 1,
  BANK = 2,
  WALLET = 3,
}

struct Payment {
  1: required string id,
  2: required i64 amountMinor,
  3: required string currency,
  4: PaymentMethod method,
  5: optional string reference,
}

struct RefundRequest {
  1: required string paymentId,
  2: i64 amountMinor,
}

exception PaymentDeclined {
  1: string reason,
  2: i32 code,
}

service PaymentService {
  Payment authorize(
    1: Payment payment
  ) throws (1: PaymentDeclined d),

  Payment capture(
    1: string paymentId
  ),

  Payment refund(
    1: RefundRequest request
  ) throws (1: PaymentDeclined d),
}
