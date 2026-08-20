/** Discriminated unions: the pattern a normalizer must turn into a canonical union. */

export type WebhookEvent =
  | OrderPlacedEvent
  | OrderShippedEvent
  | OrderCancelledEvent
  | PaymentSettledEvent;

export interface EventEnvelope {
  eventId: string;
  occurredAt: string;
  tenantId: string;
}

export interface OrderPlacedEvent extends EventEnvelope {
  type: 'order.placed';
  data: {
    orderId: string;
    customerId: string;
    total: number;
  };
}

export interface OrderShippedEvent extends EventEnvelope {
  type: 'order.shipped';
  data: {
    orderId: string;
    carrier: string;
    trackingNumber: string;
    shippedAt: string;
  };
}

export interface OrderCancelledEvent extends EventEnvelope {
  type: 'order.cancelled';
  data: {
    orderId: string;
    reason: 'customer_request' | 'fraud' | 'out_of_stock';
    refunded: boolean;
  };
}

export interface PaymentSettledEvent extends EventEnvelope {
  type: 'payment.settled';
  data: {
    orderId: string;
    authorizationId: string;
    settledAmount: number;
    currency: 'EUR' | 'GBP' | 'USD';
  };
}

export type EventType = WebhookEvent['type'];
