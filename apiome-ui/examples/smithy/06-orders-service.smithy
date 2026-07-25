$version: "2.0"

// Smithy 2.0 typical example — an everyday order-management service with a
// service shape, CRUD-style operations, structures, a list, and an enum.

namespace example.orders

service OrderService {
    version: "2026-03-01"
    operations: [CreateOrder, GetOrder, CancelOrder]
}

/// Place a new order.
operation CreateOrder {
    input: CreateOrderInput
    output: Order
}

/// Fetch an order by id.
operation GetOrder {
    input: GetOrderInput
    output: Order
}

/// Cancel an open order.
operation CancelOrder {
    input: GetOrderInput
    output: Order
}

structure CreateOrderInput {
    @required
    customerId: String

    @required
    lines: OrderLineList
}

structure GetOrderInput {
    @required
    orderId: String
}

/// An order as returned by the service.
structure Order {
    @required
    orderId: String

    @required
    customerId: String

    @required
    status: OrderStatus

    @required
    lines: OrderLineList

    totalMinor: Long
}

structure OrderLine {
    @required
    sku: String

    @required
    quantity: Integer

    unitPriceMinor: Long
}

list OrderLineList {
    member: OrderLine
}

enum OrderStatus {
    OPEN
    SHIPPED
    CANCELLED
}
