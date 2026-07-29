/**
 * Standing preferences for the Primitives import wizard.
 *
 * The wizard's Options can be set per-import, but some of them are really a way of working rather
 * than a per-document choice — those live here so they survive closing the dialog.
 *
 * Stored in localStorage alongside the other per-surface wizard preferences (same pattern as
 * `import-quality-preferences`), so they are per-browser, per-user, and survive a reload.
 */

export interface PrimitiveImportPreferences {
  /**
   * When true, the target namespace is pulled from the source document's `$id` as soon as a
   * document loads, instead of waiting for "Extract from Target" to be pressed.
   */
  autoExtractNamespace: boolean;
}

export const DEFAULT_PRIMITIVE_IMPORT_PREFERENCES: PrimitiveImportPreferences = {
  autoExtractNamespace: false,
};

const STORAGE_KEY = 'apiome.primitive-import.v1';

/** Read the persisted preferences; defaults off-browser or when storage is unreadable. */
export function readPrimitiveImportPreferences(): PrimitiveImportPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_PRIMITIVE_IMPORT_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PRIMITIVE_IMPORT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<PrimitiveImportPreferences> | null;
    return {
      autoExtractNamespace:
        typeof parsed?.autoExtractNamespace === 'boolean'
          ? parsed.autoExtractNamespace
          : DEFAULT_PRIMITIVE_IMPORT_PREFERENCES.autoExtractNamespace,
    };
  } catch {
    return { ...DEFAULT_PRIMITIVE_IMPORT_PREFERENCES };
  }
}

/** Persist a patch over the current preferences. Storage failures are a no-op. */
export function persistPrimitiveImportPreferences(patch: Partial<PrimitiveImportPreferences>): void {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readPrimitiveImportPreferences(), ...patch };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — no-op */
  }
}
