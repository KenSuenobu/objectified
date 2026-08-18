'use client';

/**
 * MCP import source form (V2-MCP-24.1 / MCAT-10.1).
 *
 * Rendered inside the existing Import dialog when the "MCP Server" source is selected. Collects the
 * endpoint URL, transport, an optional display name, and an auth scheme with its secret fields. The
 * dialog owns the form state (so its footer "Discover" button can read it) — this panel is a
 * controlled view that reports edits through `onChange`.
 *
 * Re-skinned by HIVE-6.4 (#5315). The hero's indigo→white→violet gradient is gone — DESIGN.md §2
 * keeps a brand wash for brand moments, and registering a server is not one — and its three
 * stages now share `.imp-stage` with the discovery panel they predict, so the reader meets the
 * same three marks twice rather than two different drawings of the same three steps.
 */

import { CheckCircle2, GaugeCircle, Network, Plug, ScanSearch, ShieldCheck } from 'lucide-react';
import { Card, cardVariants } from '../../../components/ui/Card';
import { FormField } from '../../../components/ui/FormField';
import { Input } from '../../../components/ui/Input';
import { cn } from '@lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select';
import {
  MCP_AUTH_TYPE_OPTIONS,
  MCP_TRANSPORT_OPTIONS,
  type McpAuthType,
  type McpImportForm,
  type McpTransport,
} from './mcp/mcpImportFlow';

export interface McpImportPanelProps {
  form: McpImportForm;
  onChange: (form: McpImportForm) => void;
}

/** What happens after "Discover" — shown in the hero so the flow is predictable up front. */
const IMPORT_STEPS: ReadonlyArray<{ icon: typeof Plug; label: string }> = [
  { icon: Plug, label: 'Connect' },
  { icon: ScanSearch, label: 'Discover capabilities' },
  { icon: GaugeCircle, label: 'Lint & grade' },
];

/** A one-line description per transport, shown on its selector card. */
const TRANSPORT_DESCRIPTIONS: Record<McpTransport, string> = {
  streamable_http: 'The modern MCP HTTP transport — recommended for new servers.',
  sse: 'Legacy HTTP + Server-Sent Events transport.',
  stdio: 'A local command spoken to over standard I/O.',
};

/** A one-line hint per auth scheme, shown under the auth-type select. */
const AUTH_DESCRIPTIONS: Record<McpAuthType, string> = {
  none: 'Connect anonymously — no credential is stored.',
  bearer: 'Sent as an Authorization: Bearer header on every request.',
  header: 'A custom header name/value pair sent on every request.',
  oauth2: 'A pre-issued OAuth 2.1 access token sent as a bearer credential.',
};

export default function McpImportPanel({ form, onChange }: McpImportPanelProps) {
  const set = <K extends keyof McpImportForm>(key: K, value: McpImportForm[K]) =>
    onChange({ ...form, [key]: value });

  const showToken = form.authType === 'bearer' || form.authType === 'oauth2' || form.authType === 'header';
  const showHeaderName = form.authType === 'header';
  const tokenLabel = form.authType === 'header' ? 'Header value' : 'Access token';

  return (
    <div className="flex flex-col gap-6">
      {/* Hero: what this source does, and the three stages the import runs through. */}
      <Card variant="flat" className="overflow-hidden">
        <div className="flex items-start gap-3 p-4">
          <span className="tnt-icon-tile" data-tone="accent" aria-hidden>
            <Network />
          </span>
          <div>
            <h3 className="font-semibold text-fg">Add an MCP server</h3>
            <p className="mt-0.5 text-sm text-fg-muted">
              Point us at a Model Context Protocol endpoint. We&apos;ll connect, discover its tools,
              resources, and prompts, lint the surface for quality, and catalog it as
              version&nbsp;1 with an A–F grade.
            </p>
          </div>
        </div>
        <ol className="imp-stages">
          {IMPORT_STEPS.map((step, index) => (
            <li key={step.label} className="imp-stage">
              <span className="imp-stage__num" aria-hidden>
                {index + 1}
              </span>
              <step.icon className="size-3.5 text-accent" aria-hidden />
              {step.label}
            </li>
          ))}
        </ol>
      </Card>

      {/* Connection ------------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormField
          label="Endpoint URL"
          htmlFor="mcp-endpoint-url"
          required
          helperText="The MCP server's connection URL."
        >
          <Input
            id="mcp-endpoint-url"
            type="text"
            inputMode="url"
            placeholder="https://mcp.example.com/sse"
            value={form.endpointUrl}
            onChange={(e) => set('endpointUrl', e.target.value)}
          />
        </FormField>

        <FormField
          label="Display name"
          htmlFor="mcp-name"
          helperText="Optional — leave blank to use the host name."
        >
          <Input
            id="mcp-name"
            type="text"
            placeholder="Defaults to the URL host"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </FormField>
      </div>

      {/* Transport as selectable cards, so each option can explain itself. */}
      <div className="flex flex-col gap-1.5">
        <div className="text-sm font-medium text-fg">Transport</div>
        <div role="radiogroup" aria-label="Transport" className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {MCP_TRANSPORT_OPTIONS.map((opt) => {
            const selected = form.transport === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set('transport', opt.value)}
                className={cn(
                  cardVariants({ variant: 'flat', hover: !selected, selected }),
                  'relative p-3 text-left'
                )}
              >
                {selected ? (
                  <CheckCircle2
                    className="absolute end-2.5 top-2.5 size-[var(--icon-dense)] text-accent"
                    aria-hidden
                  />
                ) : null}
                <div className="pe-6 text-sm font-medium text-fg">{opt.label}</div>
                <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                  {TRANSPORT_DESCRIPTIONS[opt.value]}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Authentication ---------------------------------------------------------------------- */}
      <Card variant="flat" className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border bg-subtle px-4 py-2.5">
          <ShieldCheck className="size-[var(--icon-dense)] text-accent" aria-hidden />
          <h4 className="text-sm font-semibold text-fg">Authentication</h4>
        </div>

        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
          <FormField
            label="Auth type"
            htmlFor="mcp-auth-type"
            helperText={AUTH_DESCRIPTIONS[form.authType]}
          >
            <Select value={form.authType} onValueChange={(v) => set('authType', v as McpAuthType)}>
              <SelectTrigger id="mcp-auth-type">
                <SelectValue placeholder="Select auth type" />
              </SelectTrigger>
              <SelectContent>
                {MCP_AUTH_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {showHeaderName && (
            <FormField label="Header name" htmlFor="mcp-header-name" required>
              <Input
                id="mcp-header-name"
                type="text"
                placeholder="X-API-Key"
                value={form.authHeaderName}
                onChange={(e) => set('authHeaderName', e.target.value)}
              />
            </FormField>
          )}

          {showToken && (
            <FormField
              label={tokenLabel}
              htmlFor="mcp-auth-token"
              required
              helperText="Stored encrypted; it is never shown again after you save it."
              className={showHeaderName ? 'md:col-span-2' : undefined}
            >
              <Input
                id="mcp-auth-token"
                type="password"
                autoComplete="off"
                placeholder="••••••••"
                value={form.authToken}
                onChange={(e) => set('authToken', e.target.value)}
              />
            </FormField>
          )}
        </div>
      </Card>
    </div>
  );
}
