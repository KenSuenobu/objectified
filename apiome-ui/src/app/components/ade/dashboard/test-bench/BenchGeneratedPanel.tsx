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
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import { BENCH_VERDICT_TONE } from '@/app/components/ade/version-dialogs/versionDialogsModel';
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

/**
 * The tone of an instance chip: a valid shape passes, a mutant is meant to fail.
 *
 * `BENCH_VERDICT_TONE` is the same table the findings list and the run history read, so a
 * mutant chip is the rose a failed payload is everywhere else in the bench.
 */
function chipTone(instance: BenchSynthesizedInstance): StatusTone {
  return BENCH_VERDICT_TONE[instance.kind === 'mutant' ? 'invalid' : 'valid'];
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
    <ul className="vdlg-chips" data-testid={`test-bench-generated-${group}`}>
      {list.map((instance) => (
        <li key={instance.id}>
          <button
            type="button"
            data-testid={`test-bench-load-${instance.id}`}
            onClick={() => onLoadInstance(instance)}
            className="vdlg-chip"
            data-tone={chipTone(instance)}
            aria-pressed={false}
            title={`${instance.description} Loads into the payload editor; labelled synthetic.`}
          >
            {instance.title}
            <Badge variant="violet">synthetic</Badge>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="vdlg-stack" aria-label="Generated payloads">
      <div className="vdlg-bench__row">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="test-bench-generate"
          onClick={onGenerate}
          disabled={!enabled || generating}
        >
          <Sparkles aria-hidden />
          {generating ? 'Generating…' : 'Generate payloads'}
        </Button>
        {result?.notice ? <p className="vdlg-quiet">{result.notice}</p> : null}
      </div>

      {validInstances.length > 0 ? (
        <div className="vdlg-bench__group">
          <h3 className="vdlg-caps">Valid instances</h3>
          {renderChips(validInstances, 'valid')}
        </div>
      ) : null}

      {mutants.length > 0 ? (
        <div className="vdlg-bench__group">
          <h3 className="vdlg-caps">Mutants (each violates exactly one constraint)</h3>
          {renderChips(mutants, 'mutants')}
        </div>
      ) : null}

      {result && (result.rejected_mutants ?? 0) > 0 ? (
        <p data-testid="test-bench-rejected-mutants" className="vdlg-quiet">
          {result.rejected_mutants} mutant candidate{result.rejected_mutants === 1 ? '' : 's'} were
          rejected because they did not provoke exactly the targeted violation.
        </p>
      ) : null}

      {(result?.diagnostics ?? []).map((diagnostic, index) => (
        <p key={`${diagnostic.code}:${index}`} className="vdlg-quiet">
          <code className="mono">{diagnostic.code}</code> {diagnostic.message}
        </p>
      ))}
    </section>
  );
}
