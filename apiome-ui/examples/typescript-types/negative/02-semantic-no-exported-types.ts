// Compiles cleanly, but exports no type at all: an internal helper module with nothing
// a schema importer can model.
const DEFAULT_LIMIT = 25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function pageSize(requested: number): number {
  return clamp(requested, 1, DEFAULT_LIMIT);
}
