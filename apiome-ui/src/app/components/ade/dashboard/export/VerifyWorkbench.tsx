'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseZap,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
} from 'lucide-react';
import { Button } from '../../../ui/Button';
import { Alert, AlertDescription, AlertTitle } from '../../../ui/Alert';
import { lensBadgeTone } from '@/app/components/ade/export-studio';
import { TAB_LIST_CLASS, tabTriggerClass } from '../../../ui/tabStyles';
import { FidelityWarningPanel } from './FidelityWarningPanel';
import { ValidationResultsLens } from './ValidationResultsLens';
import { EmittedLintLens, type EmittedLintSourceReport } from './EmittedLintLens';
import type { LocatedProblem } from './exportProblemMarkers';
import type { TargetFidelitySummary } from './exportTargetCatalog';
import {
  fidelityAcknowledgementMode,
  isSevereConversion,
  lensBadgeCount,
  verifyVerdictBanner,
  verifyVerdictAlertVariant,
  type ExportVerifyResponse,
  type ExportVerifyVerdict,
  type VerifyLensKey,
} from './exportVerify';

export interface VerifyWorkbenchProps {
  /** Human label of the chosen target format (e.g. `gRPC / Protobuf`). */
  targetLabel: string;
  /** One-line description of the target, shown in the fidelity lens. */
  targetDescription: string;
  /** The coarse per-target fidelity summary — feeds the fidelity lens's immediate ring/chips. */
  fidelitySummary: TargetFidelitySummary;
  /** Whether a verification is currently in flight. */
  running: boolean;
  /** Whether a verification has run and settled for the current configuration. */
  hasRun: boolean;
  /** The error from a failed run, else null. */
  error: string | null;
  /** The verify result once a run settles, else null. */
  result: ExportVerifyResponse | null;
  /** The overall verdict derived/served for {@link result}, else null before a run. */
  verdict: ExportVerifyVerdict | null;
  /** Whether the user has acknowledged a lossy conversion ("Export anyway"). */
  acknowledged: boolean;
  /** Toggle the lossy acknowledgement. */
  onAcknowledgedChange: (acknowledged: boolean) => void;
  /**
   * Trigger (or re-trigger) a verification run. `force` (the explicit re-run / retry actions)
   * bypasses the session result cache so the conversion is measured again (MFX-42.6).
   */
  onRun: (force?: boolean) => void;
  /**
   * Whether automatic (debounced) re-verification is on — the explicit opt-in behind which
   * configuration changes re-verify themselves (MFX-42.6). The toggle renders only when
   * {@link onAutoVerifyChange} is supplied.
   */
  autoVerify?: boolean;
  /** Toggle automatic re-verification; omit to hide the toggle entirely. */
  onAutoVerifyChange?: (autoVerify: boolean) => void;
  /**
   * One-line description of the configuration the displayed verdict belongs to (MFX-42.6), e.g.
   * `gRPC / Protobuf · package = com.example`. Rendered under the verdict banner so a verdict is
   * never ambiguous about which target + options it measured.
   */
  configSummary?: string | null;
  /** Whether the displayed verdict came from the session cache rather than a fresh run (MFX-42.6). */
  fromCache?: boolean;
  /**
   * The source's own (catalog) lint report, linked from the lint lens's distinguishing note so the
   * emitted-artifact lint is never conflated with the source's catalog lint. Omitted when unknown.
   */
  sourceLintReport?: EmittedLintSourceReport | null;
  /**
   * The located problems that can open in the Review editor (MFX-43.3): the Studio passes these
   * only once a generated artifact exists to open. Findings matching one render as clickable rows
   * in the validation/lint lenses.
   */
  openableProblems?: LocatedProblem[];
  /** Open a located finding in the Review editor (file + line), MFX-43.3. */
  onOpenProblem?: (problem: LocatedProblem) => void;
  /**
   * The destination-aware projection map (EFP-2.2, #4814), rendered once below the lenses
   * after a settled run. The Studio owns its construction (it knows the artifact, target,
   * and option coordinates); the workbench just places it, keeping this component
   * fetch-free — and places it outside the lens bodies so lens switches never remount it.
   */
  projectionPanel?: ReactNode;
}

/** The three lenses, in tab / accordion order. */
const LENSES: { key: VerifyLensKey; label: string }[] = [
  { key: 'fidelity', label: 'Fidelity' },
  { key: 'validation', label: 'Validation' },
  { key: 'lint', label: 'Lint' },
];

/** DOM id of a lens tab — the panel points back at it with `aria-labelledby`. */
function lensTabId(lens: VerifyLensKey): string {
  return `verify-tab-${lens}`;
}

/** DOM id of a lens panel — the tab points at it with `aria-controls`. */
function lensPanelId(lens: VerifyLensKey): string {
  return `verify-panel-${lens}`;
}

/**
 * What a lens badge's number means, spoken (MFX-41.5). A bare digit in a coloured pill is not a
 * label: "3" beside "Lint" could be anything, so the badge carries this sentence for screen
 * readers while the pill shows the number.
 *
 * @param lens The lens the badge belongs to.
 * @param count The badge's count.
 * @returns A phrase naming what was counted.
 */
function lensBadgeLabel(lens: VerifyLensKey, count: number): string {
  const noun =
    lens === 'fidelity'
      ? `construct${count === 1 ? '' : 's'} affected`
      : lens === 'validation'
        ? `validation problem${count === 1 ? '' : 's'}`
        : `lint finding${count === 1 ? '' : 's'}`;
  return `${count} ${noun}`;
}

/**
 * VerifyWorkbench — the Studio's Verify step orchestration UI (MFX-42.1, #4354).
 *
 * A single **Run verification** action calls the one-call dry-run verify (MFX-42.5) and yields
 * all three lenses at once — fidelity, emitted-output validation, and emitted-artifact lint —
 * under one go/no-go **verdict banner** (`Clean` / `Lossy — acknowledge to continue` /
 * `Severe — acknowledge to continue` / `Invalid — export blocked`, per the MFX-5.3 gate + the
 * MFX-3.3 transcoding guard). The lenses lay out as tabs-with-badges (count per lens) on desktop
 * and as an accordion on narrow widths.
 *
 * The verdict gates Generate (MFX-42.4 matrix): `invalid` blocks unconditionally (with the
 * validator's detail); `severe` — a types-only / near-empty reduction — requires the explicit
 * **typed** acknowledgement in the fidelity lens; `lossy` requires the "Export anyway" checkbox;
 * `clean` is the green path. The verdict and its result live in Studio state so the Review step
 * shows the same banner.
 *
 * A verdict is always shown with the configuration it measured (MFX-42.6): the header carries the
 * **Verify automatically** opt-in, and a settled verdict is captioned with its target + option
 * overrides — marked *Cached* when it was served from the session cache rather than re-measured.
 * Changing anything clears the verdict upstream (`useExportVerify` keys results by configuration),
 * so the workbench never has to render a verdict that no longer describes what is configured.
 */
export function VerifyWorkbench({
  targetLabel,
  targetDescription,
  fidelitySummary,
  running,
  hasRun,
  error,
  result,
  verdict,
  acknowledged,
  onAcknowledgedChange,
  onRun,
  autoVerify = false,
  onAutoVerifyChange,
  configSummary = null,
  fromCache = false,
  sourceLintReport = null,
  openableProblems,
  onOpenProblem,
  projectionPanel = null,
}: VerifyWorkbenchProps) {
  // Lead with the lens that most needs attention: the validator's detail for a blocked export,
  // else the fidelity lens (where the loss + acknowledgement live).
  const defaultLensFor = (v: ExportVerifyVerdict | null): VerifyLensKey =>
    v === 'invalid' ? 'validation' : 'fidelity';
  const [activeLens, setActiveLens] = useState<VerifyLensKey>(() => defaultLensFor(verdict));

  // Reset the tab when the verdict changes (a fresh run) using the "adjust state during render"
  // pattern — not an effect — so a manual tab pick still survives re-renders that don't change the
  // verdict.
  const [verdictAtLastReset, setVerdictAtLastReset] = useState(verdict);
  if (verdict !== verdictAtLastReset) {
    setVerdictAtLastReset(verdict);
    setActiveLens(defaultLensFor(verdict));
  }

  // Roving tabindex: the strip holds one Tab stop and the arrow keys move the selection, so a
  // keyboard user reaches the lenses in one Tab and cycles them without tabbing through each
  // (MFX-41.5 / WAI-ARIA tabs). Selecting also moves DOM focus, which is what makes the pattern
  // announce the newly selected lens.
  const tabRefs = useRef<Partial<Record<VerifyLensKey, HTMLButtonElement | null>>>({});
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = LENSES.findIndex((lens) => lens.key === activeLens);
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (current + 1) % LENSES.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (current - 1 + LENSES.length) % LENSES.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = LENSES.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const key = LENSES[next].key;
    setActiveLens(key);
    tabRefs.current[key]?.focus();
  };

  // The framing line + the automatic-verification opt-in, shown in every state so the toggle is
  // reachable before a run, during one, after a failure, and beside a settled verdict (MFX-42.6).
  const header = (
    <VerifyIntro
      targetLabel={targetLabel}
      autoVerify={autoVerify}
      onAutoVerifyChange={onAutoVerifyChange}
    />
  );

  // Before the first run (and not mid-run): the explicit call to action.
  if (!hasRun && !running) {
    return (
      <div className="space-y-4" data-testid="verify-workbench">
        {header}
        <div className="xstd-advisory">
          <p className="xstd-advisory__text">
            Run all three checks — fidelity, validation, and lint — in one pass, before you
            generate anything. Nothing is emitted or stored until you choose to generate.
            {autoVerify
              ? ' Automatic verification is on, so this configuration verifies itself in a moment.'
              : ''}
          </p>
          <Button data-testid="verify-run" onClick={() => onRun()}>
            <Sparkles aria-hidden />
            Run verification
          </Button>
        </div>
      </div>
    );
  }

  // While the single dry-run is in flight: a per-lens progress list (MFX-42.1 "progress states
  // per lens"). The one call fans out to all three; each row is pending until the call settles.
  if (running) {
    return (
      <div className="space-y-4" data-testid="verify-workbench">
        {header}
        {/* Announced politely: a run started by keyboard leaves focus on the button, so the only
            signal that anything is happening would otherwise be a spinner (MFX-41.5). The live
            region wraps the list rather than replacing its role, so the rows stay list items. */}
        <div role="status" data-testid="verify-progress-region">
          <ul className="space-y-2" data-testid="verify-progress">
            {LENSES.map((lens) => (
              <li
                key={lens.key}
                data-testid={`verify-progress-${lens.key}`}
                className="xstd-loading-row xstd-finding"
              >
                <Loader2 className="motion-safe:animate-spin" aria-hidden />
                Checking {lens.label.toLowerCase()}…
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  // A failed run: no lens has a coarse fallback, so the gate stays closed. Offer a retry.
  if (error || !result || !verdict) {
    return (
      <div className="space-y-4" data-testid="verify-workbench">
        {header}
        <Alert variant="error" data-testid="verify-error">
          {error || 'Verification did not return a result. Try again.'}
        </Alert>
        {/* A failure is never cached, and it also stops the automatic loop — so the retry forces a
            fresh measurement rather than waiting for the debounce that will not come. */}
        <Button variant="outline" data-testid="verify-rerun" onClick={() => onRun(true)}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="verify-workbench">
      {header}
      <VerdictBanner verdict={verdict} />
      {/* Which configuration this verdict belongs to (MFX-42.6) — a verdict without its target +
          options is ambiguous the moment the user starts iterating. */}
      <VerifyConfigNote summary={configSummary} fromCache={fromCache} />

      {/* Desktop: tabs-with-badges + the active lens panel. Full WAI-ARIA tabs (MFX-41.5): the
          strip is one Tab stop (roving `tabindex`), ←/→/Home/End move between lenses, each tab
          owns its panel by id, and the panel is focusable so Tab from the strip lands in the
          content rather than skipping past it. */}
      <div className="hidden sm:block" data-testid="verify-lens-tabs">
        <div
          role="tablist"
          aria-label="Verification lenses"
          onKeyDown={handleTabKeyDown}
          className={TAB_LIST_CLASS}
        >
          {LENSES.map((lens) => {
            const selected = lens.key === activeLens;
            return (
              <button
                key={lens.key}
                id={lensTabId(lens.key)}
                ref={(node) => {
                  tabRefs.current[lens.key] = node;
                }}
                role="tab"
                type="button"
                aria-selected={selected}
                aria-controls={lensPanelId(lens.key)}
                tabIndex={selected ? 0 : -1}
                data-testid={`verify-tab-${lens.key}`}
                onClick={() => setActiveLens(lens.key)}
                className={tabTriggerClass({ active: selected })}
              >
                {lens.label}
                <LensBadge lens={lens.key} result={result} />
              </button>
            );
          })}
        </div>
        <div
          role="tabpanel"
          id={lensPanelId(activeLens)}
          aria-labelledby={lensTabId(activeLens)}
          tabIndex={0}
          data-testid={`verify-panel-${activeLens}`}
          className="xstd-panel pt-4"
        >
          <LensBody
            lens={activeLens}
            result={result}
            verdict={verdict}
            targetLabel={targetLabel}
            targetDescription={targetDescription}
            fidelitySummary={fidelitySummary}
            acknowledged={acknowledged}
            onAcknowledgedChange={onAcknowledgedChange}
            sourceLintReport={sourceLintReport}
            openableProblems={openableProblems}
            onOpenProblem={onOpenProblem}
          />
        </div>
      </div>

      {/* Narrow: the same three lenses as an accordion (all bodies present, no hidden detail). */}
      <div className="space-y-2 sm:hidden" data-testid="verify-lens-accordion">
        {LENSES.map((lens) => (
          <details
            key={lens.key}
            data-testid={`verify-accordion-${lens.key}`}
            open={lens.key === activeLens}
            className="xstd-details"
          >
            <summary className="xstd-details__summary">
              <span className="flex items-center gap-2">
                {lens.label}
                <LensBadge lens={lens.key} result={result} />
              </span>
            </summary>
            <div className="xstd-details__body">
              <LensBody
                lens={lens.key}
                result={result}
                verdict={verdict}
                targetLabel={targetLabel}
                targetDescription={targetDescription}
                fidelitySummary={fidelitySummary}
                acknowledged={acknowledged}
                onAcknowledgedChange={onAcknowledgedChange}
                sourceLintReport={sourceLintReport}
                openableProblems={openableProblems}
                onOpenProblem={onOpenProblem}
              />
            </div>
          </details>
        ))}
      </div>

      {/* The destination-aware projection map (EFP-2.2, #4814): one instance at workbench
          level — not inside a lens body — so switching lenses (or the desktop/narrow layout
          swap) never remounts it and re-fetches the evidence pages. */}
      {projectionPanel}

      <div className="flex justify-end">
        {/* An explicit re-run means "measure it again", so it bypasses the cached verdict for this
            configuration (MFX-42.6) — otherwise the button would be a no-op on a cached result. */}
        <Button variant="outline" data-testid="verify-rerun" onClick={() => onRun(true)}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Re-run verification
        </Button>
      </div>
    </div>
  );
}

/**
 * The Verify step's framing line, with the automatic re-verification opt-in beside it (MFX-42.6).
 *
 * Verification is real compute (a full dry-run emit), so it stays a deliberate action by default;
 * a user who is iterating on options can switch it on and have each change re-verify itself after
 * a short pause. The toggle is omitted entirely when the host supplies no handler.
 */
function VerifyIntro({
  targetLabel,
  autoVerify,
  onAutoVerifyChange,
}: {
  targetLabel: string;
  autoVerify: boolean;
  onAutoVerifyChange?: (autoVerify: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="xstd-caps">
        <ShieldCheck aria-hidden />
        Verify the {targetLabel} conversion
      </div>
      {onAutoVerifyChange && (
        <label
          className="xstd-check"
          title="Re-run verification automatically a moment after you change the target or an option."
        >
          <input
            type="checkbox"
            data-testid="verify-auto-toggle"
            checked={autoVerify}
            onChange={(event) => onAutoVerifyChange(event.target.checked)}
          />
          Verify automatically
        </label>
      )}
    </div>
  );
}

/**
 * The caption naming the configuration a settled verdict was measured for (MFX-42.6).
 *
 * A verdict only ever renders for the configuration on screen (`useExportVerify` keys results by
 * configuration and drops any that no longer match), so this states *what* was measured rather
 * than warning that it might be stale. A cached verdict says so, because "instant" would otherwise
 * be indistinguishable from "nothing happened".
 */
function VerifyConfigNote({
  summary,
  fromCache,
}: {
  summary: string | null;
  fromCache: boolean;
}) {
  if (!summary) return null;
  return (
    <p
      data-testid="verify-config-summary"
      data-cached={fromCache ? 'true' : 'false'}
      className="xstd-config"
    >
      <span>
        This verdict describes <strong>{summary}</strong>.
      </span>
      {fromCache && (
        <span
          data-testid="verify-cached-chip"
          className="xstd-chip"
          title="Restored from this session — this configuration was already verified, so nothing was re-run."
        >
          <DatabaseZap className="h-3 w-3" aria-hidden />
          Cached
        </span>
      )}
    </p>
  );
}

/** The single go/no-go verdict banner shown above the lenses (and reused on Review). */
export function VerdictBanner({ verdict }: { verdict: ExportVerifyVerdict }) {
  const banner = verifyVerdictBanner(verdict);
  const Icon =
    banner.tone === 'invalid'
      ? ShieldX
      : banner.tone === 'severe'
        ? ShieldAlert
        : banner.tone === 'lossy'
          ? AlertTriangle
          : CheckCircle2;
  return (
    <Alert
      // The go/no-go is the whole point of the step and it appears without the user moving focus,
      // so it announces politely when a run settles (MFX-41.5). Tone is icon + words + palette.
      role="status"
      data-testid="verify-verdict"
      data-verdict={verdict}
      variant={verifyVerdictAlertVariant(banner.tone)}
      icon={<Icon aria-hidden />}
    >
      <AlertTitle>{banner.label}</AlertTitle>
      <AlertDescription>{banner.description}</AlertDescription>
    </Alert>
  );
}

/** A lens tab/accordion count badge; toned by how much the lens is flagging. */
function LensBadge({ lens, result }: { lens: VerifyLensKey; result: ExportVerifyResponse | null }) {
  const count = lensBadgeCount(lens, result);
  const tone = lensBadgeTone(count, lensBlocks(lens, result));
  return (
    <span
      data-testid={`verify-badge-${lens}`}
      className="xstd-lens-badge"
      data-tone={tone}
    >
      <span aria-hidden>{count}</span>
      <span className="sr-only">{lensBadgeLabel(lens, count)}</span>
    </span>
  );
}

/**
 * Whether a lens's findings *block* delivery, which is the only thing its badge's tone turns on.
 *
 * Validation blocks when the emitted artifact failed to re-parse, lint when any finding is an
 * error, and fidelity when the conversion is severe (types-only or near-empty) — the same
 * condition its verdict banner reads. Everything else is advisory.
 *
 * @param lens Which lens the badge belongs to.
 * @param result The settled verify response, or null before one exists.
 * @returns Whether the count should read as blocking rather than advisory.
 */
function lensBlocks(lens: VerifyLensKey, result: ExportVerifyResponse | null): boolean {
  if (lens === 'validation') return Boolean(result?.validation.blocks_delivery);
  if (lens === 'lint') {
    return (result?.lint?.findings ?? []).some((f) => f.severity === 'error');
  }
  return Boolean(result && isSevereConversion(result));
}

interface LensBodyProps {
  lens: VerifyLensKey;
  result: ExportVerifyResponse;
  verdict: ExportVerifyVerdict;
  targetLabel: string;
  targetDescription: string;
  fidelitySummary: TargetFidelitySummary;
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
  sourceLintReport: EmittedLintSourceReport | null;
  openableProblems?: LocatedProblem[];
  onOpenProblem?: (problem: LocatedProblem) => void;
}

/** Dispatch a lens key to its body; shared by the desktop tab panel and the narrow accordion. */
function LensBody({
  lens,
  result,
  verdict,
  targetLabel,
  targetDescription,
  fidelitySummary,
  acknowledged,
  onAcknowledgedChange,
  sourceLintReport,
  openableProblems,
  onOpenProblem,
}: LensBodyProps) {
  if (lens === 'fidelity') {
    return (
      <FidelityWarningPanel
        targetLabel={targetLabel}
        targetDescription={targetDescription}
        fidelity={fidelitySummary}
        preview={result}
        previewLoading={false}
        previewError={null}
        acknowledged={acknowledged}
        onAcknowledgedChange={onAcknowledgedChange}
        acknowledgementMode={fidelityAcknowledgementMode(verdict)}
      />
    );
  }
  if (lens === 'validation') {
    return (
      <ValidationResultsLens
        validation={result.validation}
        openableProblems={openableProblems}
        onOpenProblem={onOpenProblem}
      />
    );
  }
  return (
    <EmittedLintLens
      lint={result.lint}
      targetLabel={targetLabel}
      sourceReport={sourceLintReport}
      openableProblems={openableProblems}
      onOpenProblem={onOpenProblem}
    />
  );
}

export default VerifyWorkbench;
