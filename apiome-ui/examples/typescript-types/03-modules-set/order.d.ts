import type { Address } from './customer';

export type OrderStatus = 'new' | 'paid' | 'shipped' | 'cancelled';

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  orderId: string;
  customerId: string;
  status: OrderStatus;
  lines: OrderLine[];
  shipTo: Address;
  total: number;
}
