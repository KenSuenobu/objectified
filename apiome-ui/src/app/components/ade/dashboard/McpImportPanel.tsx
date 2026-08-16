'use client';

/**
 * MCP import source form (V2-MCP-24.1 / MCAT-10.1).
 *
 * Rendered inside the existing Import dialog when the "MCP Server" source is selected. Collects the
 * endpoint URL, transport, an optional display name, and an auth scheme with its secret fields. The
 * dialog owns the form state (so its footer "Discover" button can read it) — this panel is a
 * controlled view that reports edits through `onChange`.
 */

import { CheckCircle2, GaugeCircle, Network, Plug, ScanSearch, ShieldCheck } from 'lucide-react';
import { Input } from '../../../components/ui/Input';
import { Label } from '../../../components/ui/Label';
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

const fieldLabelClass = 'mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300';
const helpTextClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

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
      <div className="overflow-hidden rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-violet-50 dark:border-indigo-800 dark:from-indigo-950/40 dark:via-gray-900 dark:to-violet-950/30">
        <div className="flex items-start gap-3 p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-500 text-white shadow-sm">
            <Network className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Add an MCP server</h3>
            <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
              Point us at a Model Context Protocol endpoint. We&apos;ll connect, discover its tools,
              resources, and prompts, lint the surface for quality, and catalog it as
              version&nbsp;1 with an A–F grade.
            </p>
          </div>
        </div>
        <ol className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-indigo-100 px-4 py-2.5 dark:border-indigo-900/60">
          {IMPORT_STEPS.map((step, index) => (
            <li key={step.label} className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-2xs font-semibold text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300">
                {index + 1}
              </span>
              <step.icon className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
              {step.label}
            </li>
          ))}
        </ol>
      </div>

      {/* Connection ------------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor="mcp-endpoint-url" className={fieldLabelClass}>
            Endpoint URL <span className="text-red-500">*</span>
          </Label>
          <Input
            id="mcp-endpoint-url"
            type="text"
            inputMode="url"
            placeholder="https://mcp.example.com/sse"
            value={form.endpointUrl}
            onChange={(e) => set('endpointUrl', e.target.value)}
          />
          <p className={helpTextClass}>The MCP server&apos;s connection URL.</p>
        </div>

        <div>
          <Label htmlFor="mcp-name" className={fieldLabelClass}>
            Display name
          </Label>
          <Input
            id="mcp-name"
            type="text"
            placeholder="Defaults to the URL host"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
          <p className={helpTextClass}>Optional — leave blank to use the host name.</p>
        </div>
      </div>

      {/* Transport as selectable cards, so each option can explain itself. */}
      <div>
        <div className={fieldLabelClass}>Transport</div>
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
                className={`relative rounded-lg border p-3 text-left transition-colors ${
                  selected
                    ? 'border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500 dark:border-indigo-500 dark:bg-indigo-950/30'
                    : 'border-gray-200 bg-white hover:border-indigo-300 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-indigo-700'
                }`}
              >
                {selected ? (
                  <CheckCircle2
                    className="absolute right-2.5 top-2.5 h-4 w-4 text-indigo-500"
                    aria-hidden
                  />
                ) : null}
                <div className="pr-6 text-sm font-medium text-gray-900 dark:text-white">
                  {opt.label}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                  {TRANSPORT_DESCRIPTIONS[opt.value]}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Authentication ---------------------------------------------------------------------- */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2.5 dark:border-gray-700 dark:bg-gray-900/40">
          <ShieldCheck className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden />
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Authentication</h4>
        </div>

        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
          <div>
            <Label htmlFor="mcp-auth-type" className={fieldLabelClass}>
              Auth type
            </Label>
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
            <p className={helpTextClass}>{AUTH_DESCRIPTIONS[form.authType]}</p>
          </div>

          {showHeaderName && (
            <div>
              <Label htmlFor="mcp-header-name" className={fieldLabelClass}>
                Header name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="mcp-header-name"
                type="text"
                placeholder="X-API-Key"
                value={form.authHeaderName}
                onChange={(e) => set('authHeaderName', e.target.value)}
              />
            </div>
          )}

          {showToken && (
            <div className={showHeaderName ? 'md:col-span-2' : ''}>
              <Label htmlFor="mcp-auth-token" className={fieldLabelClass}>
                {tokenLabel} <span className="text-red-500">*</span>
              </Label>
              <Input
                id="mcp-auth-token"
                type="password"
                autoComplete="off"
                placeholder="••••••••"
                value={form.authToken}
                onChange={(e) => set('authToken', e.target.value)}
              />
              <p className={helpTextClass}>
                Stored encrypted; it is never shown again after you save it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
