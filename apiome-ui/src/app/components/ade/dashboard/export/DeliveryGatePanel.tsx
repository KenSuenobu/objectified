/**
 * DeliveryGatePanel — the export delivery gate's decision, reasons, and override path (IXH-2.5).
 *
 * The Studio used to say only two things about a delivery: it worked, or the emitted artifact was
 * rejected by a validator. The delivery gate adds the rest of the picture — an artifact that is
 * legal in its target format may still be refused because the *source* carries open error-severity
 * findings, because too little of it survives the conversion, or because the tenant's export
 * quality policy says so. This panel renders that decision:
 *
 *  - the toned headline (blocked / delivered with warnings) and the server's own sentence;
 *  - every **named reason**, tagged with the dimension it came from (validation, lint, fidelity,
 *    policy) and whether it blocked or warned — codes come from the server, so the copy and the
 *    branch never disagree;
 *  - for a block, the **override path**: the waiver endpoint, the subject key it must be recorded
 *    under, and which roles may record it (or why no override exists at all);
 *  - for a delivered artifact, the **attestation** reference — its predicate type and whether it
 *    is signed, so a user knows there is something to verify offline.
 *
 * Pure presentation: it renders what {@link deliveryReportFor} hands it and owns no state. The
 * blocked case appears inside the Generate failure surface; the warning case alongside a completed
 * artifact.
 */

import { AlertTriangle, FileCheck2, Gauge, ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge } from '../../../ui/Badge';
import type {
  DeliveryDimension,
  DeliveryGateReport,
  DeliveryReason,
  DeliverySeverity,
} from './exportJob';

export interface DeliveryGatePanelProps {
  /** The delivery gate decision to render (blocked, or delivered with warnings). */
  delivery: DeliveryGateReport;
}

/** Human label for each contributing dimension — the vocabulary the reasons are grouped by. */
const DIMENSION_LABEL: Record<DeliveryDimension, string> = {
  validation: 'Artifact validation',
  lint: 'Source quality',
  fidelity: 'Conversion fidelity',
  policy: 'Tenant policy',
};

/** The icon for each dimension, so a scan of the list reads without parsing the words. */
function dimensionIcon(dimension: DeliveryDimension) {
  switch (dimension) {
    case 'validation':
      return <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />;
    case 'fidelity':
      return <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />;
    case 'policy':
      return <ScrollText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />;
    case 'lint':
    default:
      return <FileCheck2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />;
  }
}

/** Row tint per reason severity — blocking reads as an error, warning as an advisory. */
function reasonRowClass(severity: DeliverySeverity): string {
  switch (severity) {
    case 'blocking':
      return 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-100';
    case 'warning':
      return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100';
    case 'info':
    default:
      return 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-200';
  }
}

/**
 * DeliveryGatePanel — render one delivery gate decision (IXH-2.5).
 *
 * @param delivery The decision from a failed job's error context or a completed job's result.
 * @returns The panel, or null for a clean `allow` (which has nothing to say).
 */
export function DeliveryGatePanel({ delivery }: DeliveryGatePanelProps) {
  if (delivery.decision === 'allow') return null;
  const blocked = delivery.decision === 'block';

  return (
    <div
      className={`space-y-3 rounded-lg border p-4 ${
        blocked
          ? 'border-rose-300 bg-rose-50/60 dark:border-rose-800 dark:bg-rose-950/20'
          : 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20'
      }`}
      data-testid="delivery-gate-panel"
      data-decision={delivery.decision}
    >
      <div className="flex items-start gap-3">
        {blocked ? (
          <ShieldAlert
            className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-300"
            aria-hidden
          />
        ) : (
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300"
            aria-hidden
          />
        )}
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {delivery.headline}
          </div>
          <p
            className="text-xs text-gray-700 dark:text-gray-200"
            data-testid="delivery-gate-message"
          >
            {delivery.message}
          </p>
        </div>
      </div>

      {/* The named contributing reasons — the whole point of a single combined verdict. */}
      {delivery.reasons.length > 0 && (
        <ul className="space-y-1.5" data-testid="delivery-gate-reasons">
          {delivery.reasons.map((reason: DeliveryReason) => (
            <li
              key={reason.code + reason.message}
              data-testid="delivery-gate-reason"
              data-reason-code={reason.code}
              data-severity={reason.severity}
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${reasonRowClass(
                reason.severity,
              )}`}
            >
              {dimensionIcon(reason.dimension)}
              <span className="min-w-0">
                <span className="font-semibold">{DIMENSION_LABEL[reason.dimension]}</span>
                {' — '}
                {reason.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* How to proceed: the waiver path, or why there is none. */}
      {blocked && (
        <div
          className="rounded-md border border-gray-200 bg-white/70 p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-200"
          data-testid="delivery-gate-override"
          data-available={delivery.override.available}
        >
          <p>{delivery.override.instructions}</p>
          {delivery.override.available && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-2xs">
              {delivery.override.endpoint && (
                <>
                  <dt className="text-gray-500 dark:text-gray-400">endpoint</dt>
                  <dd className="break-all" data-testid="delivery-gate-override-endpoint">
                    POST {delivery.override.endpoint}
                  </dd>
                </>
              )}
              {delivery.override.subject_key && (
                <>
                  <dt className="text-gray-500 dark:text-gray-400">subject</dt>
                  <dd className="break-all">{delivery.override.subject_key}</dd>
                </>
              )}
              {delivery.override.format_key && (
                <>
                  <dt className="text-gray-500 dark:text-gray-400">target</dt>
                  <dd className="break-all">{delivery.override.format_key}</dd>
                </>
              )}
              {delivery.override.roles && delivery.override.roles.length > 0 && (
                <>
                  <dt className="text-gray-500 dark:text-gray-400">roles</dt>
                  <dd>{delivery.override.roles.join(', ')}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      )}

      {/* A delivered artifact says what it carries, so a user knows there is proof to check. */}
      {delivery.attestation && (
        <div
          className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"
          data-testid="delivery-gate-attestation"
          data-signed={delivery.attestation.signed}
        >
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            This artifact carries a{delivery.attestation.signed ? ' signed' : 'n unsigned'} delivery
            attestation.
          </span>
          <Badge variant={delivery.attestation.signed ? 'success' : 'secondary'}>
            {delivery.attestation.signed ? 'signed' : 'unsigned'}
          </Badge>
        </div>
      )}
    </div>
  );
}

export default DeliveryGatePanel;
