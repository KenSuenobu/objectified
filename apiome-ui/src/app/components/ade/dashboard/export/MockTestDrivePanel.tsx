'use client';

/**
 * MockTestDrivePanel — hit a live mock of the emitted artifact (MFX-44.5, #4371).
 *
 * The Verify workbench tells the user what the conversion *cost*; the round-trip panel proves the
 * artifact can be read back. This panel answers the last question either leaves open: **does the
 * thing actually behave like an API?** One click provisions a short-lived mock of the emitted
 * document (the existing Mock Server engine serves it), and from there the user can send it real
 * requests and watch what it answers.
 *
 * What the panel is careful about:
 *
 *  - **Explicit and bounded.** Starting a mock costs a server-side emit and a live instance, so it
 *    happens only on the button — never on a render, a preview, or a step change.
 *  - **Honest about absence.** A target the engine cannot serve renders nothing at all; a *server*
 *    without mock infrastructure renders the panel disabled carrying the server's own reason. The
 *    two are different facts and the ticket asks for both.
 *  - **Expiry is visible while it matters.** The countdown ticks down in the header and turns
 *    urgent under five minutes, so "instances expire" is something the user sees coming rather
 *    than discovers as a 410.
 *  - **The schema verdict is the point.** Every log row states in words whether an operation
 *    matched and whether the body agreed with the response schema — a mock that answers 200 with a
 *    body its own document does not describe has failed the test drive, and colour is never the
 *    only thing that says so.
 */

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Play,
  RefreshCcw,
  Send,
  Square,
  Zap,
} from 'lucide-react';
import { cn } from '@lib/utils';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import {
  buildRequestPath,
  countdownTone,
  formatCountdown,
  formatLogTime,
  mockAvailabilityNotice,
  mockIsLive,
  operationKey,
  pathParameters,
  requestOutcomeLabel,
  requestOutcomeTone,
  statusTone,
  type ExportMockOperation,
} from './exportMockTestDrive';
import type { UseExportMockTestDriveResult } from './useExportMockTestDrive';

export interface MockTestDrivePanelProps {
  /** Everything the panel renders and every action it can take. */
  testDrive: UseExportMockTestDriveResult;
  /** The chosen target's emitter key — the capability decision is made against it. */
  targetKey: string | null;
  /** Human label of the chosen target (e.g. `OpenAPI 3.1`). */
  targetLabel: string;
  className?: string;
}

/** The panel's heading — one look for every state. */
function SectionHeading({ targetLabel }: { targetLabel: string }) {
  return (
    <h3 className="xstd-caps">
      <Zap className="h-3.5 w-3.5" aria-hidden />
      Mock server test drive — {targetLabel}
    </h3>
  );
}

/**
 * Copy the mock's base URL, confirming in place.
 *
 * The URL is the whole deliverable of the Start action — it is what goes into `curl`, an HTTP
 * client, or a colleague's chat window — so it gets a first-class control rather than being
 * something the user has to select by hand out of a monospace run.
 */
function CopyBaseUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      data-testid="mock-copy-url"
      aria-label="Copy the mock base URL"
      onClick={() => {
        // Confirm only what actually happened: `navigator.clipboard` is absent in an insecure
        // context, and a button that says "Copied" over an empty clipboard is worse than one that
        // does nothing — the URL is still selectable in the monospace run beside it.
        const written = navigator.clipboard?.writeText(url);
        if (!written) return;
        void written.then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? 'Copied' : 'Copy URL'}
    </Button>
  );
}

/** One operation row in the try-it list: its path parameters, then Send. */
function OperationRow({
  operation,
  scenario,
  disabled,
  sending,
  onSend,
}: {
  operation: ExportMockOperation;
  scenario: string | null;
  disabled: boolean;
  sending: boolean;
  onSend: (operation: ExportMockOperation, values: Record<string, string>) => void;
}) {
  const params = useMemo(() => pathParameters(operation.path), [operation.path]);
  const [values, setValues] = useState<Record<string, string>>({});
  const key = operationKey(operation);

  return (
    <li className="xstd-mock__op" data-testid={`mock-operation-${key}`}>
      <Badge variant="neutral" className="xstd-mock__op-method">
        {operation.method}
      </Badge>
      <code className="xstd-mock__op-path">{operation.path}</code>
      {params.map((name) => (
        <label key={name} className="xstd-mock__param">
          <span className="xstd-mock__param-name">{name}</span>
          <input
            className="xstd-mock__param-input"
            value={values[name] ?? ''}
            placeholder="1"
            onChange={(event) =>
              setValues((current) => ({ ...current, [name]: event.target.value }))
            }
          />
        </label>
      ))}
      <span className="xstd-mock__op-spacer" />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        data-testid={`mock-send-${key}`}
        aria-label={`Send ${operation.method} ${buildRequestPath(operation.path, values)} to the mock`}
        onClick={() => onSend(operation, values)}
      >
        {sending ? (
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
        ) : (
          <Send className="h-3.5 w-3.5" aria-hidden />
        )}
        Send
      </Button>
      {scenario && <span className="sr-only">as the {scenario} scenario</span>}
    </li>
  );
}

export function MockTestDrivePanel({
  testDrive,
  targetKey,
  targetLabel,
  className,
}: MockTestDrivePanelProps) {
  const {
    capability,
    capabilityLoading,
    instance,
    reattached,
    busy,
    error,
    log,
    lastResult,
    sending,
    start,
    stop,
    restart,
    send,
    clearResult,
  } = testDrive;

  const [scenario, setScenario] = useState<string | null>(null);
  const availability = mockAvailabilityNotice(capability, targetKey, capabilityLoading);

  // A target the engine cannot serve gets no panel at all — there is nothing to explain about a
  // proto bundle not being an HTTP API. Only a *server* without infrastructure gets a disabled one.
  if (availability.kind === 'hidden') return null;

  if (availability.kind === 'pending') {
    return (
      <section className={cn('space-y-2', className)} data-testid="mock-test-drive-panel">
        <SectionHeading targetLabel={targetLabel} />
        <p className="xstd-loading-row" data-testid="mock-capability-loading">
          <Loader2 className="motion-safe:animate-spin" aria-hidden />
          Checking whether this server can mock the export…
        </p>
      </section>
    );
  }

  if (availability.kind === 'disabled') {
    return (
      <section className={cn('space-y-2', className)} data-testid="mock-test-drive-panel">
        <SectionHeading targetLabel={targetLabel} />
        <div className="xstd-mock__prompt" data-testid="mock-unavailable">
          <p className="xstd-quiet">{availability.reason}</p>
          <Button size="sm" variant="outline" disabled data-testid="mock-start">
            <Play className="h-3.5 w-3.5" aria-hidden />
            Start mock
          </Button>
        </div>
      </section>
    );
  }

  const live = mockIsLive(instance);

  return (
    <section className={cn('space-y-3', className)} data-testid="mock-test-drive-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading targetLabel={targetLabel} />
        {instance && (
          <div className="flex items-center gap-2">
            {reattached && (
              <span className="xstd-chip" data-testid="mock-reattached">
                already running
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void restart()}
              data-testid="mock-restart"
            >
              <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
              Restart
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void stop()}
              data-testid="mock-stop"
            >
              <Square className="h-3.5 w-3.5" aria-hidden />
              Stop mock
            </Button>
          </div>
        )}
      </div>

      {/* A failed start/stop/send never gates the export — the artifact is unaffected. */}
      {error && (
        <p className="xstd-notice" data-tone="warn" role="status" data-testid="mock-error">
          <AlertTriangle aria-hidden />
          <span className="xstd-notice__grow">{error}</span>
        </p>
      )}

      {!instance ? (
        <div className="xstd-mock__prompt" data-testid="mock-start-prompt">
          <p className="xstd-quiet">
            Serve this artifact as a live API for{' '}
            <strong>{capability?.defaultTtlMinutes ?? 30} minutes</strong> and send it real
            requests. Responses are generated from the document&rsquo;s own response schemas, so a
            reply that does not fit the schema is a finding. The mock stops itself when the time is
            up.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void start()}
            data-testid="mock-start"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" aria-hidden />
            )}
            Start mock
          </Button>
        </div>
      ) : (
        <>
          {/* The live instance: the URL, the countdown, and what it is serving. */}
          <div className="xstd-mock__live" data-live={live ? '' : undefined} data-testid="mock-live">
            <div className="xstd-mock__url-row">
              <code className="xstd-mock__url" data-testid="mock-base-url">
                {instance.baseUrl}
              </code>
              <CopyBaseUrl url={instance.baseUrl} />
            </div>
            <div className="xstd-mock__meta">
              <Badge variant={live ? countdownTone(instance.expiresInSeconds) : 'danger'}>
                {live ? `Expires in ${formatCountdown(instance.expiresInSeconds)}` : 'Expired'}
              </Badge>
              <span className="xstd-quiet" data-testid="mock-operation-count">
                {instance.operationCount} operation{instance.operationCount === 1 ? '' : 's'}
              </span>
              <span className="xstd-quiet">{instance.requestCount} served</span>
              <span className="xstd-quiet">{instance.rateLimitPerMinute}/min limit</span>
            </div>
            {!live && (
              <p className="xstd-quiet" data-testid="mock-expired-note">
                This mock has reached its time limit and no longer answers. Start another to keep
                testing.
              </p>
            )}
          </div>

          {live && instance.scenarios.length > 0 && (
            <label className="xstd-mock__scenario">
              <span className="xstd-mock__param-name">Scenario</span>
              <select
                className="xstd-mock__param-input"
                data-testid="mock-scenario"
                value={scenario ?? instance.activeScenario}
                onChange={(event) => setScenario(event.target.value)}
              >
                {instance.scenarios.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* Try it: one row per operation the frozen document declares. */}
          {live && (
            <div data-testid="mock-try">
              <h4 className="xstd-caps">Try an operation</h4>
              {instance.operations.length === 0 ? (
                <p className="xstd-empty">This document declares no operations to call.</p>
              ) : (
                <ul className="xstd-mock__ops">
                  {instance.operations.map((operation) => (
                    <OperationRow
                      key={operationKey(operation)}
                      operation={operation}
                      scenario={scenario ?? instance.activeScenario}
                      disabled={sending || busy}
                      sending={sending}
                      onSend={(op, values) =>
                        void send(op, values, scenario ?? instance.activeScenario)
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* The last response, verbatim, with the mock's own evidence headers. */}
          {lastResult && (
            <div data-testid="mock-result">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="xstd-caps">
                  Response — {lastResult.request.method} {lastResult.request.path}
                </h4>
                <div className="flex items-center gap-2">
                  <Badge variant={statusTone(lastResult.status)} data-testid="mock-result-status">
                    HTTP {lastResult.status}
                  </Badge>
                  <span className="xstd-quiet">{lastResult.durationMs} ms</span>
                  <Button size="sm" variant="ghost" onClick={clearResult} data-testid="mock-result-clear">
                    Clear
                  </Button>
                </div>
              </div>
              {lastResult.headers['x-mock-schema-valid'] === 'false' && (
                <p className="xstd-notice" data-tone="danger" data-testid="mock-result-schema-warning">
                  <AlertTriangle aria-hidden />
                  <span className="xstd-notice__grow">
                    The mock could not produce a body matching this operation&rsquo;s response
                    schema — the emitted document describes a response it cannot satisfy.
                  </span>
                </p>
              )}
              <pre className="xstd-mock__body" data-testid="mock-result-body">
                {lastResult.body || '(empty body)'}
              </pre>
              {lastResult.truncated && (
                <p className="xstd-quiet">Body clipped for display.</p>
              )}
            </div>
          )}

          {/* The request log: everything the mock served, newest first. */}
          <div data-testid="mock-log">
            <h4 className="xstd-caps">Request log</h4>
            {!log || log.entries.length === 0 ? (
              <p className="xstd-empty" data-testid="mock-log-empty">
                No requests yet. Send one above, or call the base URL from your own client.
              </p>
            ) : (
              <>
                <ul className="xstd-mock__log">
                  {log.entries.map((entry, index) => (
                    <li
                      key={`${entry.at}:${index}`}
                      className="xstd-mock__log-row"
                      data-testid="mock-log-row"
                    >
                      <span className="xstd-mock__log-time">{formatLogTime(entry.at)}</span>
                      <Badge variant="neutral">{entry.method}</Badge>
                      <code className="xstd-mock__op-path">{entry.path}</code>
                      <Badge variant={statusTone(entry.status)}>{entry.status}</Badge>
                      <Badge variant={requestOutcomeTone(entry)}>
                        {requestOutcomeLabel(entry)}
                      </Badge>
                      <span className="xstd-mock__op-spacer" />
                      <span className="xstd-quiet">{entry.scenario}</span>
                      <span className="xstd-quiet">{entry.durationMs} ms</span>
                    </li>
                  ))}
                </ul>
                {log.truncated && (
                  <p className="xstd-quiet" data-testid="mock-log-truncated">
                    Showing the most recent {log.capacity} requests; older traffic has rolled off.
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
