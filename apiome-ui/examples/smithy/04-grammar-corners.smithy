$version: "2.0"

// Smithy 2.0 stress example — the grammar's less common corners in one model:
// a `union` shape, a `map` shape, an `@error` structure, operation `errors`,
// constraint traits (@pattern, @length, @range), and doc comments throughout.

namespace example.payments

service PaymentService {
    version: "2026-02-01"
    operations: [SubmitPayment]
}

/// Submit a payment using any supported payment method.
operation SubmitPayment {
    input: SubmitPaymentInput
    output: SubmitPaymentOutput
    errors: [PaymentRejected]
}

structure SubmitPaymentInput {
    @required
    @pattern("^[A-Z0-9-]{1,32}$")
    paymentId: String

    @required
    method: PaymentMethod

    @required
    @range(min: 1)
    amountMinor: Long

    @required
    @length(min: 3, max: 3)
    currency: String

    /// Free-form key-value metadata attached to the payment.
    metadata: MetadataMap
}

structure SubmitPaymentOutput {
    @required
    paymentId: String

    @required
    status: PaymentStatus
}

/// Exactly one member of the union is present on the wire.
union PaymentMethod {
    card: CardMethod
    bankTransfer: BankTransferMethod
    walletToken: String
}

structure CardMethod {
    @required
    panLastFour: String

    @required
    expiryMonth: Integer

    @required
    expiryYear: Integer
}

structure BankTransferMethod {
    @required
    iban: String

    bic: String
}

map MetadataMap {
    key: String
    value: String
}

enum PaymentStatus {
    PENDING
    SETTLED
    FAILED
}

/// Returned when the payment cannot be accepted.
@error("client")
structure PaymentRejected {
    @required
    reason: String

    retryAfterSeconds: Integer
}
