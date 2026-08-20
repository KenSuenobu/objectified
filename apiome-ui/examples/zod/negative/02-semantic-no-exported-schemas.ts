import { z } from 'zod';

// Zod is imported and used, but every schema is module-private: nothing is exported, so
// there is no schema surface to extract.
const internalOnly = z.object({ id: z.string() });

export function validate(input: unknown): boolean {
  return internalOnly.safeParse(input).success;
}
