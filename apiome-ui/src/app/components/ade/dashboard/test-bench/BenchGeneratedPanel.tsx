'use client';

/**
 * BenchGeneratedPanel (IXH-5.3, #5115).
 *
 * One-click loading of the IXH-5.2 generated sets: a **Generate** button, then one chip per
 * returned instance — the valid set (minimal / full / per-branch) and the mutant set (each
 * violating exactly one constraint). Every chip is labelled synthetic (the generator's label,
 * passed through, never re-derived) and clicking one loads its payload into the editor.
 *
 * Honesty rides along: `rejected_mutants` and any generation diagnostics are stated, so a
 * short mutant list is never mistaken for a complete one.
 */

import { Sparkles } from 'lucide-react';
import type { BenchSynthesisPayload, BenchSynthesizedInstance } from '@/app/utils/schema-test-bench';

export interface BenchGeneratedPanelProps {
  /** The last synthesis payload, or `null` before the first generation. */
  result: BenchSynthesisPayload | null;
  /** Whether a generation call is in flight. */
  generating: boolean;
  /** Whether a schema is selected (the button is useless without one). */
  enabled: boolean;
  /** Starts a generation call. */
  onGenerate: () => void;
  /** Loads one generated instance into the payload editor. */
  onLoadInstance: (instance: BenchSynthesizedInstance) => void;
}

/** Chip tone per instance kind: valid shapes green-ish, mutants rose. */
function chipToneClass(instance: BenchSynthesizedInstance): string {
  if (instance.kind === 'mutant') {
    return 'border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-950/70';
  }
  return 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/70';
}

/** Render the generate action and the loaded result's instance chips. */
export function BenchGeneratedPanel({
  result,
  generating,
  enabled,
  onGenerate,
  onLoadInstance,
}: BenchGeneratedPanelProps) {
  const instances = result?.instances ?? [];
  const validInstances = instances.filter((instance) => instance.kind !== 'mutant');
  const mutants = instances.filter((instance) => instance.kind === 'mutant');

  const renderChips = (list: BenchSynthesizedInstance[], group: string) => (
    <ul className="flex flex-wrap gap-1.5" data-testid={`test-bench-generated-${group}`}>
      {list.map((instance) => (
        <li key={instance.id}>
          <button
            type="button"
            data-testid={`test-bench-load-${instance.id}`}
            onClick={() => onLoadInstance(instance)}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${chipToneClass(instance)}`}
            title={`${instance.description} Loads into the payload editor; labelled synthetic.`}
          >
            {instance.title}
            <span className="rounded bg-violet-100 px-1 text-[9px] font-semibold uppercase tracking-wider text-violet-800 dark:bg-violet-900/50 dark:text-violet-300">
              synthetic
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="space-y-3" aria-label="Generated payloads">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="test-bench-generate"
          onClick={onGenerate}
          disabled={!enabled || generating}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <Sparkles className="h-4 w-4 text-violet-500" aria-hidden />
          {generating ? 'Generating…' : 'Generate payloads'}
        </button>
        {result?.notice ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">{result.notice}</p>
        ) : null}
      </div>

      {validInstances.length > 0 ? (
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Valid instances
          </h3>
          {renderChips(validInstances, 'valid')}
        </div>
      ) : null}

      {mutants.length > 0 ? (
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Mutants (each violates exactly one constraint)
          </h3>
          {renderChips(mutants, 'mutants')}
        </div>
      ) : null}

      {result && (result.rejected_mutants ?? 0) > 0 ? (
        <p data-testid="test-bench-rejected-mutants" className="text-xs text-gray-500 dark:text-gray-400">
          {result.rejected_mutants} mutant candidate{result.rejected_mutants === 1 ? '' : 's'} were
          rejected because they did not provoke exactly the targeted violation.
        </p>
      ) : null}

      {(result?.diagnostics ?? []).map((diagnostic, index) => (
        <p key={`${diagnostic.code}:${index}`} className="text-xs text-gray-500 dark:text-gray-400">
          <code className="font-mono text-[10px]">{diagnostic.code}</code> {diagnostic.message}
        </p>
      ))}
    </section>
  );
}
