/** Root of the set: re-exports the model, and defines the aggregate type. */
export * from './customer';
export * from './order';

import type { Customer } from './customer';
import type { Order } from './order';

export interface CustomerWithOrders {
  customer: Customer;
  orders: Order[];
  totalSpend: number;
}
