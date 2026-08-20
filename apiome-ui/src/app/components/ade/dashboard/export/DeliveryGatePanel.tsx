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
      return <ShieldAlert aria-hidden />;
    case 'fidelity':
      return <Gauge aria-hidden />;
    case 'policy':
      return <ScrollText aria-hidden />;
    case 'lint':
    default:
      return <FileCheck2 aria-hidden />;
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
      className="xstd-gate"
      data-testid="delivery-gate-panel"
      data-decision={delivery.decision}
    >
      <div className="xstd-gate__head">
        {blocked ? <ShieldAlert aria-hidden /> : <AlertTriangle aria-hidden />}
        <div className="min-w-0 space-y-1">
          <div className="xstd-gate__title">{delivery.headline}</div>
          <p className="xstd-quiet" data-testid="delivery-gate-message">
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
              className="xstd-gate__reason"
            >
              {dimensionIcon(reason.dimension)}
              <span className="min-w-0">
                <span className="xstd-gate__dimension">{DIMENSION_LABEL[reason.dimension]}</span>
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
          className="xstd-gate__override"
          data-testid="delivery-gate-override"
          data-available={delivery.override.available}
        >
          <p>{delivery.override.instructions}</p>
          {delivery.override.available && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-2xs">
              {delivery.override.endpoint && (
                <>
                  <dt>endpoint</dt>
                  <dd className="break-all" data-testid="delivery-gate-override-endpoint">
                    POST {delivery.override.endpoint}
                  </dd>
                </>
              )}
              {delivery.override.subject_key && (
                <>
                  <dt>subject</dt>
                  <dd className="break-all">{delivery.override.subject_key}</dd>
                </>
              )}
              {delivery.override.format_key && (
                <>
                  <dt>target</dt>
                  <dd className="break-all">{delivery.override.format_key}</dd>
                </>
              )}
              {delivery.override.roles && delivery.override.roles.length > 0 && (
                <>
                  <dt>roles</dt>
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
          className="xstd-gate__attestation"
          data-testid="delivery-gate-attestation"
          data-signed={delivery.attestation.signed}
        >
          <ShieldCheck aria-hidden />
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
