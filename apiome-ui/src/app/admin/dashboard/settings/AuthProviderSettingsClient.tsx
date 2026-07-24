'use client';

/**
 * Sign-in provider configuration screen (OLO-8.7, #4973).
 *
 * The list shows only providers that are already configured (any field stored in the DB, or an
 * existing DB row). New providers are added via the header's "+ Add Provider" menu, which lists
 * the remaining registry providers (coming-soon entries as disabled items) — so the page stays
 * uncluttered no matter how many providers the registry grows. An added-but-unsaved provider
 * stays visible locally until its first save persists it.
 *
 * Each card renders:
 *   - a three-way enablement control (Enabled / Disabled / Use .env) matching the V196
 *     `enabled` column's `true` / `false` / `null` semantics (OLO-8.2/8.5);
 *   - the OAuth client id;
 *   - a **write-only** client-secret field — the UI shows only "set / not set" and never
 *     receives the stored value from the server;
 *   - provider-specific extras (Azure tenant/authority, GitHub/GitLab base URLs) stored in the
 *     `config` JSONB, env-var-keyed for the OLO-8.5 merge resolver;
 *   - a per-field "using .env fallback" badge whenever no DB value is set;
 *   - a Validate affordance surfacing the OLO-8.4 completeness check (`can_enable` /
 *     `missing_for_enable`).
 *
 * All reads/writes go through the super-admin proxy (`/api/admin/auth-providers`), gated by the
 * hardened session (OLO-8.1). Saves send only the fields the admin actually changed (partial
 * update). A blocked enable (incomplete or coming-soon provider) surfaces the structured 422
 * guidance from OLO-8.4 inline on the card.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { getProviderBrand } from '@/app/components/auth/provider-brand';
import {
  AdminProviderConfigView,
  AdminProviderListResponse,
  PROVIDER_EXTRA_FIELDS,
  buildProviderUpdatePayload,
  extractRestErrorMessage,
} from '@lib/auth/admin-provider-config';

/** The three admin-selectable enablement states (mirrors `enabled: true | false | null`). */
type EnablementChoice = 'on' | 'off' | 'env';

/** Map a stored `enabled` value to the control state. */
function enablementFromView(enabled: boolean | null): EnablementChoice {
  if (enabled === true) return 'on';
  if (enabled === false) return 'off';
  return 'env';
}

/** Map the control state back to the stored `enabled` value. */
function enabledFromChoice(choice: EnablementChoice): boolean | null {
  if (choice === 'on') return true;
  if (choice === 'off') return false;
  return null;
}

/** Initial extras input values for a view: its stored string entries, blank when unset. */
function extrasFromView(view: AdminProviderConfigView): Record<string, string> {
  const fields = PROVIDER_EXTRA_FIELDS[view.provider_id] ?? [];
  const extras: Record<string, string> = {};
  for (const field of fields) {
    const stored = view.config[field.envKey];
    extras[field.envKey] = typeof stored === 'string' ? stored : '';
  }
  return extras;
}

/** Small slate chip marking a field whose effective value comes from `.env` (OLO-8.5). */
function FallbackBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
      using .env fallback
    </span>
  );
}

/** Colored chip summarizing a provider's stored enablement state. */
function EnablementChip({ enabled }: { enabled: boolean | null }) {
  if (enabled === true) {
    return (
      <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-400">
        Enabled (database)
      </span>
    );
  }
  if (enabled === false) {
    return (
      <span className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-400">
        Disabled (database)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
      Env-derived
    </span>
  );
}

/** Shared classes for the card text inputs. */
const INPUT_CLASSES =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-600';

/** Shared classes for secondary (outline) buttons. */
const SECONDARY_BUTTON_CLASSES =
  'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';

/** One option of the three-way enablement control. */
function EnablementOption({
  label,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onSelect}
      className={[
        'px-3 py-1 text-sm font-medium transition-colors first:rounded-l-md last:rounded-r-md',
        active
          ? 'bg-indigo-600 text-white'
          : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800',
        'disabled:cursor-not-allowed disabled:opacity-50',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

/**
 * Whether a provider counts as "configured" and therefore appears in the list.
 *
 * True when any of its fields is stored in the database (rather than falling back to `.env`),
 * when non-secret extras are stored, or when a DB row exists at all (`updated_at` set) — a row
 * whose fields were all cleared back to fallback still shows, since an admin deliberately
 * touched it. Purely env-fallback providers stay hidden until added via the header menu.
 */
function isConfigured(view: AdminProviderConfigView): boolean {
  return (
    view.enabled_source === 'db' ||
    view.client_id_source === 'db' ||
    view.secret_source === 'db' ||
    Object.keys(view.config ?? {}).length > 0 ||
    view.updated_at !== null
  );
}

/**
 * Case/whitespace-insensitive match of a picker candidate against the search query. Matches the
 * human-facing label ("Microsoft") and the registry slug ("azure") so admins can search by either
 * name. A blank query matches everything.
 *
 * @param candidate The provider view offered by the picker.
 * @param query The raw search-box value.
 * @returns True when the candidate should stay visible for this query.
 */
function matchesProviderQuery(candidate: AdminProviderConfigView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    candidate.label.toLowerCase().includes(needle) ||
    candidate.provider_id.toLowerCase().includes(needle)
  );
}

/**
 * The header's "+ Add Provider" affordance: a button opening a menu of every registry provider
 * not currently shown in the list. Available providers are selectable (adding their card to the
 * page); coming-soon providers appear as disabled entries so the roadmap stays discoverable.
 *
 * The panel is built for a large registry (the Better Auth catalog-parity waves, OLO-9.16–9.49,
 * grow it toward ~50 entries): a search box pinned at the top filters candidates by label or slug
 * ({@link matchesProviderQuery}), and the item list below it scrolls inside a capped-height region
 * so the menu never outgrows the viewport. Pressing Enter in the search box adds the first
 * *available* (non-coming-soon) match — the one-keystroke path for an exact search. The query
 * resets whenever the menu closes, so each open starts from the full list.
 *
 * @param candidates Providers not currently visible, in registry order.
 * @param disabled Disables the trigger (while the list is loading or failed to load).
 * @param onAdd Called with the chosen provider id.
 */
function AddProviderMenu({
  candidates,
  disabled,
  onAdd,
}: {
  candidates: AdminProviderConfigView[];
  disabled: boolean;
  onAdd: (providerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Close the menu and clear the query. Every close path runs through this so a fresh open always
   * starts unfiltered — a stale query from a previous open would silently hide providers behind
   * an easy-to-miss search box.
   */
  const closeMenu = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  // Close on outside click / Escape, only while open.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, closeMenu]);

  const filtered = candidates.filter((candidate) => matchesProviderQuery(candidate, query));

  /** Add a candidate and close the menu (shared by item click and the Enter shortcut). */
  const choose = (providerId: string) => {
    onAdd(providerId);
    closeMenu();
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : setOpen(true))}
        className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-4 w-4" /> Add Provider
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Add a sign-in provider"
          className="absolute right-0 z-20 mt-2 w-64 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {candidates.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
              All providers are already configured.
            </p>
          ) : (
            <>
              <div className="border-b border-slate-200 p-2 dark:border-slate-700">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
                  <input
                    type="text"
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      const first = filtered.find(
                        (candidate) => candidate.status === 'available'
                      );
                      if (first) choose(first.provider_id);
                    }}
                    placeholder="Search providers…"
                    aria-label="Search providers"
                    className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-600"
                  />
                </div>
              </div>
              {/* Capped height keeps the grown registry usable: the list scrolls, the search stays pinned. */}
              <div className="max-h-64 overflow-y-auto py-1">
                {filtered.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                    No providers match &ldquo;{query.trim()}&rdquo;.
                  </p>
                ) : (
                  filtered.map((candidate) => {
                    const brand = getProviderBrand(candidate.provider_id);
                    const comingSoon = candidate.status !== 'available';
                    return (
                      <button
                        key={candidate.provider_id}
                        type="button"
                        role="menuitem"
                        disabled={comingSoon}
                        onClick={() => choose(candidate.provider_id)}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        <brand.Icon size={16} className={brand.iconClassName} />
                        <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                        {comingSoon && (
                          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-400">
                            Coming soon
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Result of the Validate affordance: the server-computed completeness for one provider. */
interface ValidationResult {
  canEnable: boolean;
  missing: string[];
}

/**
 * One provider's configuration card.
 *
 * @param view The provider's server-confirmed masked view.
 * @param onViewChange Callback replacing the view after a save or validate refresh.
 * @param onDismiss When set, renders a Cancel button (bottom right) that dismisses the card.
 *   Passed only for cards added this session but not yet saved — a persisted provider would
 *   just reappear on the next load, so dismissing it would mislead.
 */
function ProviderCard({
  view,
  onViewChange,
  onDismiss,
}: {
  view: AdminProviderConfigView;
  onViewChange: (view: AdminProviderConfigView) => void;
  onDismiss?: () => void;
}) {
  const brand = getProviderBrand(view.provider_id);
  const extraFields = PROVIDER_EXTRA_FIELDS[view.provider_id] ?? [];
  const comingSoon = view.status !== 'available';

  const [enablement, setEnablement] = useState<EnablementChoice>(() =>
    enablementFromView(view.enabled)
  );
  const [clientId, setClientId] = useState(view.client_id ?? '');
  const [secretInput, setSecretInput] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [extras, setExtras] = useState<Record<string, string>>(() => extrasFromView(view));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [errorMissingFields, setErrorMissingFields] = useState<string[]>([]);
  const [justSaved, setJustSaved] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  const payload = comingSoon
    ? null
    : buildProviderUpdatePayload(view, {
        enabled: enabledFromChoice(enablement),
        clientId,
        clientSecret: secretInput,
        clearSecret,
        extras,
      });
  const dirty = payload !== null;

  /** Reset every editable control to a freshly-saved view. */
  const syncFromView = (next: AdminProviderConfigView) => {
    setEnablement(enablementFromView(next.enabled));
    setClientId(next.client_id ?? '');
    setSecretInput('');
    setClearSecret(false);
    setExtras(extrasFromView(next));
  };

  /** Clear transient outcome indicators when the admin edits anything. */
  const touch = () => {
    setJustSaved(false);
    setSaveError(null);
    setErrorMissingFields([]);
  };

  const handleSave = async () => {
    if (!payload || saving) return;
    setSaving(true);
    setSaveError(null);
    setErrorMissingFields([]);
    setJustSaved(false);
    setValidation(null);
    try {
      const response = await fetch(
        `/api/admin/auth-providers/${encodeURIComponent(view.provider_id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const next = body as AdminProviderConfigView;
        onViewChange(next);
        syncFromView(next);
        setJustSaved(true);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setSaveError('Your admin session has expired. Sign out and back in, then retry.');
        return;
      }
      setSaveError(
        extractRestErrorMessage(body, 'Saving failed. Check the configuration service and retry.')
      );
      const detail =
        body && typeof body === 'object'
          ? (body as { detail?: { missing_fields?: unknown } }).detail
          : undefined;
      if (detail && typeof detail === 'object' && Array.isArray(detail.missing_fields)) {
        setErrorMissingFields(detail.missing_fields.map(String));
      }
    } catch {
      setSaveError('Saving failed: the server could not be reached.');
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    if (validating) return;
    setValidating(true);
    setValidation(null);
    setSaveError(null);
    setErrorMissingFields([]);
    try {
      const response = await fetch('/api/admin/auth-providers', { cache: 'no-store' });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setSaveError(
          extractRestErrorMessage(body, 'Validation failed. Check the configuration service and retry.')
        );
        return;
      }
      const fresh = (body as AdminProviderListResponse).providers?.find(
        (candidate) => candidate.provider_id === view.provider_id
      );
      if (!fresh) {
        setSaveError('Validation failed: the provider was missing from the server response.');
        return;
      }
      // Refresh the stored view (badges, timestamps) but leave any unsaved edits in place.
      onViewChange(fresh);
      setValidation({ canEnable: fresh.can_enable, missing: fresh.missing_for_enable });
    } catch {
      setSaveError('Validation failed: the server could not be reached.');
    } finally {
      setValidating(false);
    }
  };

  return (
    <section
      aria-label={`${view.label} provider configuration`}
      className={[
        'rounded-lg border bg-white dark:bg-slate-900',
        comingSoon
          ? 'border-dashed border-slate-300 opacity-70 dark:border-slate-700'
          : 'border-slate-200 dark:border-slate-800',
      ].join(' ')}
    >
      {/* Card header: brand, name, state chips */}
      <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
          <brand.Icon size={20} className={brand.iconClassName} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {view.label}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{view.provider_id}</p>
        </div>
        {comingSoon ? (
          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-400">
            Coming soon
          </span>
        ) : (
          <EnablementChip enabled={view.enabled} />
        )}
      </div>

      {comingSoon ? (
        <p className="px-5 py-4 text-sm text-slate-500 dark:text-slate-400">
          This provider is on the roadmap. Configuration will be available once its sign-in
          integration ships.
        </p>
      ) : (
        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Enablement */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-32 shrink-0 text-sm font-medium text-slate-700 dark:text-slate-300">
              Enablement
            </span>
            <div
              role="radiogroup"
              aria-label={`${view.label} enablement`}
              className="inline-flex divide-x divide-slate-300 overflow-hidden rounded-md border border-slate-300 dark:divide-slate-700 dark:border-slate-700"
            >
              <EnablementOption
                label="Enabled"
                active={enablement === 'on'}
                disabled={saving}
                onSelect={() => {
                  touch();
                  setEnablement('on');
                }}
              />
              <EnablementOption
                label="Disabled"
                active={enablement === 'off'}
                disabled={saving}
                onSelect={() => {
                  touch();
                  setEnablement('off');
                }}
              />
              <EnablementOption
                label="Use .env"
                active={enablement === 'env'}
                disabled={saving}
                onSelect={() => {
                  touch();
                  setEnablement('env');
                }}
              />
            </div>
            {view.enabled === null && <FallbackBadge />}
          </div>
          <p className="-mt-2 pl-32 text-xs text-slate-500 dark:text-slate-400">
            &ldquo;Enabled&rdquo; forces this provider on using the database credentials below;
            &ldquo;Use .env&rdquo; derives enablement from environment variables.
          </p>

          {/* Client id */}
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor={`${view.provider_id}-client-id`}
              className="w-32 shrink-0 text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Client ID
            </label>
            <input
              id={`${view.provider_id}-client-id`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              className={`${INPUT_CLASSES} max-w-md flex-1`}
              placeholder="Falls back to .env when blank"
              value={clientId}
              disabled={saving}
              onChange={(event) => {
                touch();
                setClientId(event.target.value);
              }}
            />
            {view.client_id_source === 'env-fallback' && <FallbackBadge />}
          </div>

          {/* Client secret (write-only) */}
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor={`${view.provider_id}-client-secret`}
              className="w-32 shrink-0 text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Client secret
            </label>
            <input
              id={`${view.provider_id}-client-secret`}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              className={`${INPUT_CLASSES} max-w-md flex-1`}
              placeholder={
                view.secret_set
                  ? 'Secret is set — type a new value to replace it'
                  : 'Enter client secret'
              }
              value={secretInput}
              disabled={saving || clearSecret}
              onChange={(event) => {
                touch();
                setSecretInput(event.target.value);
              }}
            />
            <span
              className={[
                'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                view.secret_set
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-400'
                  : 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400',
              ].join(' ')}
            >
              {view.secret_set ? 'Secret: set' : 'Secret: not set'}
            </span>
            {view.secret_source === 'env-fallback' && <FallbackBadge />}
          </div>
          <div className="-mt-2 pl-32 text-xs text-slate-500 dark:text-slate-400">
            {clearSecret ? (
              <span className="inline-flex items-center gap-2 text-amber-700 dark:text-amber-400">
                The stored secret will be cleared on save; the provider then falls back to .env.
                <button
                  type="button"
                  className="font-medium underline"
                  onClick={() => {
                    touch();
                    setClearSecret(false);
                  }}
                >
                  Undo
                </button>
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                Write-only: the stored value is never shown.
                {view.secret_set && (
                  <button
                    type="button"
                    className="font-medium text-rose-600 underline dark:text-rose-400"
                    onClick={() => {
                      touch();
                      setSecretInput('');
                      setClearSecret(true);
                    }}
                  >
                    Clear stored secret
                  </button>
                )}
              </span>
            )}
          </div>

          {/* Provider-specific extras (config JSONB) */}
          {extraFields.map((field) => {
            const stored = view.config[field.envKey];
            const storedInDb = typeof stored === 'string' && stored.trim().length > 0;
            return (
              <div key={field.envKey} className="flex flex-wrap items-center gap-3">
                <label
                  htmlFor={`${view.provider_id}-extra-${field.envKey}`}
                  className="w-32 shrink-0 text-sm font-medium text-slate-700 dark:text-slate-300"
                  title={field.envKey}
                >
                  {field.label}
                </label>
                <div className="max-w-md flex-1">
                  <input
                    id={`${view.provider_id}-extra-${field.envKey}`}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    className={INPUT_CLASSES}
                    placeholder={`Default: ${field.defaultValue}`}
                    value={extras[field.envKey] ?? ''}
                    disabled={saving}
                    onChange={(event) => {
                      touch();
                      setExtras((current) => ({
                        ...current,
                        [field.envKey]: event.target.value,
                      }));
                    }}
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {field.help} ({field.envKey})
                  </p>
                </div>
                {!storedInDb && <FallbackBadge />}
              </div>
            );
          })}

          {/* Save error / enable guidance */}
          {saveError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p>{saveError}</p>
                {errorMissingFields.length > 0 && (
                  <p className="mt-1">
                    Missing: {errorMissingFields.join(', ')}. Fill them in on this card, then
                    save again.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Validation result */}
          {validation &&
            (validation.canEnable ? (
              <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <p>Database configuration is complete — this provider can be enabled.</p>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Not ready to enable — missing: {validation.missing.join(', ')}. Save the
                  missing values on this card first; .env values do not count toward enabling
                  here.
                </p>
              </div>
            ))}

          {/* Actions */}
          <div className="flex items-center gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleValidate}
              disabled={validating || saving}
              className={SECONDARY_BUTTON_CLASSES}
            >
              {validating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              Validate
            </button>
            {justSaved && (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Saved
              </span>
            )}
            {view.updated_at && (
              <span className="ml-auto text-xs text-slate-400 dark:text-slate-500">
                Last changed {new Date(view.updated_at).toLocaleString()}
                {view.updated_by ? ` by ${view.updated_by}` : ''}
              </span>
            )}
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                disabled={saving}
                className={`${SECONDARY_BUTTON_CLASSES} ml-auto`}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The System Configuration screen: header plus one card per configured (or just-added) provider. */
export default function AuthProviderSettingsClient() {
  const [providers, setProviders] = useState<AdminProviderConfigView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Providers added from the header menu this session; kept visible even before their first
  // save persists them (after which isConfigured() takes over).
  const [addedIds, setAddedIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch('/api/admin/auth-providers', { cache: 'no-store' });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setLoadError('Your admin session has expired. Sign out and back in.');
        } else {
          setLoadError(
            extractRestErrorMessage(
              body,
              'Could not load provider configuration. Check the configuration service and retry.'
            )
          );
        }
        setProviders(null);
        return;
      }
      setProviders((body as AdminProviderListResponse).providers ?? []);
    } catch {
      setLoadError('Could not load provider configuration: the server could not be reached.');
      setProviders(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceView = (next: AdminProviderConfigView) => {
    setProviders((current) =>
      current
        ? current.map((view) => (view.provider_id === next.provider_id ? next : view))
        : current
    );
  };

  // The list shows only configured providers plus any added (but not yet saved) this session;
  // everything else is reachable through the header's Add menu.
  const visibleProviders = (providers ?? []).filter(
    (view) => isConfigured(view) || addedIds.includes(view.provider_id)
  );
  const addCandidates = (providers ?? []).filter(
    (view) => !isConfigured(view) && !addedIds.includes(view.provider_id)
  );

  return (
    <>
      <header className="shrink-0 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-4 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
              System Configuration
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Sign-in providers — database values override .env; blank fields fall back to .env.
            </p>
          </div>
          <AddProviderMenu
            candidates={addCandidates}
            disabled={loading || providers === null}
            onAdd={(providerId) =>
              setAddedIds((current) =>
                current.includes(providerId) ? current : [...current, providerId]
              )
            }
          />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-slate-950">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {loading && (
            <div className="flex items-center gap-2 py-10 text-sm text-slate-500 dark:text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading provider configuration…
            </div>
          )}

          {!loading && loadError && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
            >
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="flex-1">
                <p>{loadError}</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className={`${SECONDARY_BUTTON_CLASSES} mt-3`}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Retry
                </button>
              </div>
            </div>
          )}

          {!loading && !loadError && visibleProviders.length === 0 && (
            <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No providers configured.
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Click Add to add a new provider.
              </p>
            </div>
          )}

          {!loading &&
            !loadError &&
            visibleProviders.map((view) => (
              <ProviderCard
                key={view.provider_id}
                view={view}
                onViewChange={replaceView}
                onDismiss={
                  isConfigured(view)
                    ? undefined
                    : () =>
                        setAddedIds((current) =>
                          current.filter((id) => id !== view.provider_id)
                        )
                }
              />
            ))}
        </div>
      </main>
    </>
  );
}
