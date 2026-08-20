/** Order domain types as a team actually writes them. */

export type OrderStatus = 'new' | 'paid' | 'shipped' | 'cancelled';

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPrice: number;
  /** Absent for promotional lines. */
  discount?: number;
}

export interface Order {
  orderId: string;
  customerId: string;
  status: OrderStatus;
  placedAt: string;
  lines: OrderLine[];
  total: number;
  currency: string;
  note?: string | null;
  readonly createdBy: string;
}

export interface NewOrder {
  customerId: string;
  lines: Array<Pick<OrderLine, 'sku' | 'quantity'>>;
  note?: string;
}

export type OrderSummary = Omit<Order, 'lines' | 'note'>;
