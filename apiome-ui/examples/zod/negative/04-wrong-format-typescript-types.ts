export type OrderStatus = 'new' | 'paid' | 'shipped' | 'cancelled';

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  orderId: string;
  status: OrderStatus;
  lines: OrderLine[];
}
