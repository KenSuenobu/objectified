import { z } from 'zod';

/**
 * Request and response validation as a service actually ships it: shared value schemas,
 * per-endpoint request bodies, a paginated response helper and a problem-details union.
 */

export const Currency = z.enum(['EUR', 'GBP', 'USD']);

export const Money = z.object({
  value: z.number().int().nonnegative(),
  currency: Currency,
});

export const Address = z.object({
  line1: z.string().min(1).max(60),
  line2: z.string().max(60).optional(),
  city: z.string().min(1).max(40),
  postalCode: z.string().min(3).max(10),
  countryCode: z.string().length(2).regex(/^[A-Z]{2}$/),
});

export const Customer = z.object({
  customerId: z.string().regex(/^CUS-[0-9]{6}$/),
  displayName: z.string().min(1).max(120),
  email: z.string().email(),
  billingAddress: Address.optional(),
  createdAt: z.string().datetime(),
});

export const CardReference = z.object({
  networkToken: z.string().min(16).max(64),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2026).max(2099),
  cardholderNameHint: z.string().max(80).optional(),
});

export const AuthorizationRequest = z.object({
  merchantId: z.string().regex(/^MER-[0-9]{6}$/),
  amount: Money,
  card: CardReference,
  captureMode: z.enum(['AUTOMATIC', 'MANUAL']).default('AUTOMATIC'),
  idempotencyKey: z.string().uuid(),
});

export const Authorization = z.object({
  authorizationId: z.string().regex(/^AUT-[0-9]{5,}$/),
  result: z.enum(['APPROVED', 'DECLINED', 'REFERRAL', 'EXPIRED_CARD', 'INSUFFICIENT_FUNDS']),
  amount: Money,
  authorizedAmount: Money.optional(),
  networkCode: z.string().length(2).optional(),
  decidedAt: z.string().datetime(),
});

export const CaptureRequest = z.object({
  amount: Money,
  finalCapture: z.boolean().default(true),
});

export const ListQuery = z.object({
  status: z.enum(['APPROVED', 'DECLINED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const Problem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('validation'), field: z.string(), message: z.string() }),
  z.object({ type: z.literal('rate_limit'), retryAfterSeconds: z.number().int().positive() }),
  z.object({ type: z.literal('upstream'), component: z.string(), transient: z.boolean() }),
]);

export const ApiError = z.object({
  status: z.number().int().min(400).max(599),
  problem: Problem,
  requestId: z.string().uuid(),
});

export const AuthorizationPage = z.object({
  items: z.array(Authorization),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type AuthorizationRequest = z.infer<typeof AuthorizationRequest>;
export type Authorization = z.infer<typeof Authorization>;
export type ApiError = z.infer<typeof ApiError>;
