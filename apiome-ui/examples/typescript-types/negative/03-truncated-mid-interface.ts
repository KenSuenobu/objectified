export type OrderStatus = 'new' | 'paid' | 'shipped' | 'cancelled';

export interface Order {
  orderId: string;
  customerId: string;
  status: OrderSta
