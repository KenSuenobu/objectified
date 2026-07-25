/**
 * "Skip the quality step" preference for the catalog import wizard (IXH-2.2, #5097).
 *
 * Power users who import the same well-known sources repeatedly can opt out of stopping on the
 * quality step. The preference is an *auto-advance* switch, not a bypass: the wizard still runs the
 * pre-flight, and it still stops on the step whenever the report would block the commit or could
 * not be produced. Nothing is ever committed against a blocking policy without the user seeing it.
 *
 * Stored in localStorage alongside the other per-surface wizard preferences (same pattern as
 * `lint-violation-display-preferences`), so it survives a reload and is per-browser, per-user.
 */

export interface ImportQualityPreferences {
  /** When true, a non-blocking pre-flight commits without stopping on the quality step. */
  skipQualityStep: boolean;
}

export const DEFAULT_IMPORT_QUALITY_PREFERENCES: ImportQualityPreferences = {
  skipQualityStep: false,
};

const STORAGE_KEY = 'apiome.import-quality.v1';

/** Read the persisted preferences; defaults off-browser or when storage is unreadable. */
export function readImportQualityPreferences(): ImportQualityPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_IMPORT_QUALITY_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_IMPORT_QUALITY_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<ImportQualityPreferences> | null;
    return {
      skipQualityStep:
        typeof parsed?.skipQualityStep === 'boolean'
          ? parsed.skipQualityStep
          : DEFAULT_IMPORT_QUALITY_PREFERENCES.skipQualityStep,
    };
  } catch {
    return { ...DEFAULT_IMPORT_QUALITY_PREFERENCES };
  }
}

/** Persist a patch over the current preferences. Storage failures are a no-op. */
export function persistImportQualityPreferences(patch: Partial<ImportQualityPreferences>): void {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readImportQualityPreferences(), ...patch };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — no-op */
  }
}
