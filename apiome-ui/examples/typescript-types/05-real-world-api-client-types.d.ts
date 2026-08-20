/**
 * Declaration file as an API client package ships one: request/response types for every
 * operation, a discriminated error union, and pagination helpers.
 */

export type Currency = 'EUR' | 'GBP' | 'USD';

export interface Money {
  /** Minor units — 1250 is EUR 12.50. */
  value: number;
  currency: Currency;
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  countryCode: string;
}

export interface Customer {
  customerId: string;
  displayName: string;
  email: string;
  billingAddress?: Address;
  createdAt: string;
}

export type AuthorizationResult =
  | 'APPROVED'
  | 'DECLINED'
  | 'REFERRAL'
  | 'EXPIRED_CARD'
  | 'INSUFFICIENT_FUNDS';

export interface CardReference {
  networkToken: string;
  expiryMonth: number;
  expiryYear: number;
  cardholderNameHint?: string;
}

export interface AuthorizationRequest {
  merchantId: string;
  amount: Money;
  card: CardReference;
  captureMode?: 'AUTOMATIC' | 'MANUAL';
  idempotencyKey: string;
}

export interface Authorization {
  authorizationId: string;
  result: AuthorizationResult;
  amount: Money;
  authorizedAmount?: Money;
  networkCode?: string;
  decidedAt: string;
}

export interface CaptureRequest {
  amount: Money;
  finalCapture?: boolean;
}

export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Paginated<T> {
  items: T[];
  pageInfo: PageInfo;
}

export type AuthorizationPage = Paginated<Authorization>;
export type CustomerPage = Paginated<Customer>;

export interface ValidationProblem {
  type: 'validation';
  field: string;
  message: string;
}

export interface RateLimitProblem {
  type: 'rate_limit';
  retryAfterSeconds: number;
}

export interface UpstreamProblem {
  type: 'upstream';
  component: string;
  transient: boolean;
}

export type ApiProblem = ValidationProblem | RateLimitProblem | UpstreamProblem;

export interface ApiError {
  status: number;
  problem: ApiProblem;
  requestId: string;
}
