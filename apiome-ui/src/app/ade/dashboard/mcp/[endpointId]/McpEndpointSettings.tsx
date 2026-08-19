"use client";

/**
 * Endpoint-detail "Settings" tab (V2-MCP-24.9 / MCAT-10.9; re-skinned by HIVE-7.8, #5325).
 *
 * Lets the owner edit an endpoint's identity & connection (name, URL, transport, visibility,
 * discovery cadence) and manage its lifecycle (enable/disable, delete). Identity edits persist via
 * `PATCH /api/mcp/endpoints/{id}`; delete — behind a confirmation that has to be typed — calls
 * `DELETE` and surfaces the returned teardown summary. Inline validation reuses the import-source
 * URL/transport rules.
 *
 * The component is self-contained: it owns the form state and the network calls, and lifts results
 * to the parent through `onSaved` (an updated endpoint) and `onDeleted` (the teardown summary).
 *
 * ### What HIVE-7.8 changed
 *
 * Authority: `docs/mockups/sources/mcp-endpoint.html`'s Settings panel, whose three
 * `.settings-grid` sections this is.
 *
 * 1. **Each section was a `lg:grid-cols-3` with a heading in column one.** It is
 *    `.mcp-settings-grid` — the mockup's `minmax(0,1fr) minmax(0,2fr)` — so the explanation
 *    column keeps a readable measure instead of a third of whatever is left.
 * 2. **Every field was a hand-rolled `Label` + control + `<p class="text-xs text-gray-500">`.**
 *    They are `ui/FormField`, which is what wires the hint to the control's `aria-describedby`
 *    and turns a validation failure into something a screen reader is told about.
 * 3. **Forty-five palette classes.** `text-red-500` requirement stars, a `text-amber-600`
 *    unsaved-changes dot, `bg-emerald-500` / `bg-gray-400` lifecycle dots, a
 *    `border-red-200 bg-red-50/60 dark:bg-red-950/20` danger panel and a
 *    `bg-red-600 hover:bg-red-700` delete button that re-stated what `Button`'s `destructive`
 *    variant already draws. All tokens now, so the tab follows all nine themes.
 *
 * The typed-DELETE confirmation is untouched: the dialog still names the cascade, still requires
 * the word to be typed exactly, and still stays mounted while the request runs.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Power, PowerOff, Save, Server, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useDialog } from "@/app/components/providers/DialogProvider";
import { Button } from "@/app/components/ui/Button";
import { Card, CardBody } from "@/app/components/ui/Card";
import { FormField } from "@/app/components/ui/FormField";
import { Input } from "@/app/components/ui/Input";
import { Label } from "@/app/components/ui/Label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/Select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/app/components/ui/AlertDialog";
import {
  MCP_TRANSPORT_OPTIONS,
  type McpTransport,
} from "@/app/components/ade/dashboard/mcp/mcpImportFlow";
import {
  mcpEndpointDetailFromPayload,
  type McpEndpointDetail,
} from "@/app/components/ade/dashboard/mcp/mcpBrowseUi";
import {
  MCP_DELETE_CONFIRM_WORD,
  MCP_CADENCE_DEFAULT_SELECT_VALUE,
  MCP_SUB_DAILY_CADENCE_CONFIRM_MESSAGE,
  MCP_VISIBILITY_OPTIONS,
  buildSettingsPatchBody,
  cadenceSelectValueFromForm,
  hasSettingsChanges,
  isDeleteConfirmed,
  mcpCadenceOptions,
  mcpSettingsFormFromEndpoint,
  mcpTeardownSummaryFromPayload,
  normalizeCadenceSelectValue,
  settingsPatchNeedsSubDailyCadenceConfirm,
  validateMcpSettingsForm,
  type McpSettingsForm,
  type McpTeardownSummary,
  type McpVisibility,
} from "@/app/components/ade/dashboard/mcp/mcpSettingsForm";

export interface McpEndpointSettingsProps {
  endpoint: McpEndpointDetail;
  /** Called with the updated record after an identity edit or an enable/disable toggle persists. */
  onSaved: (updated: McpEndpointDetail) => void;
  /** Called after the endpoint is deleted, with the cascade teardown summary. */
  onDeleted: (summary: McpTeardownSummary) => void;
}

/** The dot that says whether the endpoint is in the sweep. Never alone — the words are beside it. */
const LIFECYCLE_DOT_CLASS = "inline-block size-2.5 shrink-0 rounded-full";

/** Read an error message out of a `{ error }` JSON body, falling back to a status line. */
function errorFromResponse(data: unknown, statusText: string): string {
  if (data && typeof data === "object" && "error" in data) {
    const err = (data as { error: unknown }).error;
    if (typeof err === "string" && err.trim()) return err;
  }
  return statusText || "Request failed.";
}

export default function McpEndpointSettings({
  endpoint,
  onSaved,
  onDeleted,
}: McpEndpointSettingsProps) {
  const { confirm: confirmDialog } = useDialog();
  const [form, setForm] = useState<McpSettingsForm>(() => mcpSettingsFormFromEndpoint(endpoint));
  /** Which mutation is in flight ("save" | "enabled" | "delete"), or null when idle. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Inline validation error for the identity form (shown above the Save button). */
  const [formError, setFormError] = useState<string | null>(null);
  /** Whether the destructive delete dialog is open. */
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** The user's typed confirmation in the delete dialog. */
  const [deleteConfirm, setDeleteConfirm] = useState("");

  // Re-seed the form whenever the endpoint's editable fields change by value (e.g. after a save
  // re-fetches the record). Keyed on those fields only, so a header publish/enable toggle — which
  // does not touch them — never discards in-progress edits.
  const editableSignature = [
    endpoint.name,
    endpoint.endpoint_url,
    endpoint.transport,
    endpoint.visibility,
    endpoint.discovery_cadence_seconds ?? "",
  ].join(" ");
  useEffect(() => {
    setForm(mcpSettingsFormFromEndpoint(endpoint));
    setFormError(null);
    // editableSignature captures every endpoint field the form reads; endpoint is read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editableSignature]);

  const set = <K extends keyof McpSettingsForm>(key: K, value: McpSettingsForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const cadenceOptions = useMemo(
    () => mcpCadenceOptions(endpoint.discovery_cadence_seconds),
    [endpoint.discovery_cadence_seconds],
  );

  const patchBody = useMemo(() => buildSettingsPatchBody(form, endpoint), [form, endpoint]);
  const dirty = hasSettingsChanges(patchBody);

  /** PATCH the endpoint with `body`, returning the parsed updated record or throwing on error. */
  async function patchEndpoint(body: Record<string, unknown>): Promise<McpEndpointDetail> {
    const res = await fetch(`/api/mcp/endpoints/${endpoint.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorFromResponse(data, res.statusText));
    const updated = mcpEndpointDetailFromPayload(data);
    if (!updated) throw new Error("The server returned an unexpected response.");
    return updated;
  }

  /** Validate and persist the identity/connection form. */
  async function handleSave() {
    const validation = validateMcpSettingsForm(form);
    if (validation) {
      setFormError(validation);
      return;
    }
    setFormError(null);
    if (!hasSettingsChanges(patchBody)) {
      toast.info("No changes to save.");
      return;
    }
    if (settingsPatchNeedsSubDailyCadenceConfirm(patchBody)) {
      const confirmed = await confirmDialog({
        title: "Are you sure?",
        message: MCP_SUB_DAILY_CADENCE_CONFIRM_MESSAGE,
        variant: "warning",
        confirmLabel: "Save changes",
        cancelLabel: "Cancel",
      });
      if (!confirmed) return;
    }
    setBusy("save");
    try {
      const updated = await patchEndpoint(patchBody as Record<string, unknown>);
      onSaved(updated);
      toast.success("Endpoint settings saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save settings.");
    } finally {
      setBusy(null);
    }
  }

  /** Toggle the endpoint's enabled state (removing/restoring it from the discovery sweep). */
  async function handleToggleEnabled() {
    const next = !endpoint.enabled;
    setBusy("enabled");
    try {
      const updated = await patchEndpoint({ enabled: next });
      onSaved(updated);
      toast.success(next ? "Endpoint enabled." : "Endpoint disabled.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the endpoint.");
    } finally {
      setBusy(null);
    }
  }

  /** Delete the endpoint (typed-confirm gated) and surface the teardown summary. */
  async function handleDelete() {
    if (!isDeleteConfirmed(deleteConfirm)) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/mcp/endpoints/${endpoint.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorFromResponse(data, res.statusText));
      setDeleteOpen(false);
      onDeleted(mcpTeardownSummaryFromPayload(data));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete the endpoint.");
    } finally {
      setBusy(null);
    }
  }

  const saving = busy === "save";
  const togglingEnabled = busy === "enabled";
  const deleting = busy === "delete";
  const anyBusy = busy !== null;

  return (
    <div className="flex flex-col gap-6">
      {/* Identity & connection ------------------------------------------------------------- */}
      <section className="mcp-settings-grid">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-fg">
            <Server aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
            Identity &amp; connection
          </h3>
          <p className="mt-1 text-sm text-fg-muted">
            How this endpoint appears in your catalog and how discovery connects to it. Changing
            the URL or transport takes effect on the next discovery run.
          </p>
        </div>
        <Card>
          <CardBody>
            <div className="mcp-settings-fields">
              <FormField
                label="Name"
                required
                htmlFor="mcp-settings-name"
                className="mcp-settings-fields__wide"
              >
                <Input
                  id="mcp-settings-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </FormField>

              <FormField
                label="Endpoint URL"
                required
                htmlFor="mcp-settings-url"
                helperText="The MCP server's connection URL."
                className="mcp-settings-fields__wide"
              >
                <Input
                  id="mcp-settings-url"
                  type="text"
                  inputMode="url"
                  placeholder="https://mcp.example.com/sse"
                  value={form.endpointUrl}
                  onChange={(e) => set("endpointUrl", e.target.value)}
                />
              </FormField>

              <FormField label="Transport" htmlFor="mcp-settings-transport">
                <Select
                  value={form.transport}
                  onValueChange={(v) => set("transport", v as McpTransport)}
                >
                  <SelectTrigger id="mcp-settings-transport">
                    <SelectValue placeholder="Select transport" />
                  </SelectTrigger>
                  <SelectContent>
                    {MCP_TRANSPORT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField label="Visibility" htmlFor="mcp-settings-visibility">
                <Select
                  value={form.visibility}
                  onValueChange={(v) => set("visibility", v as McpVisibility)}
                >
                  <SelectTrigger id="mcp-settings-visibility">
                    <SelectValue placeholder="Select visibility" />
                  </SelectTrigger>
                  <SelectContent>
                    {MCP_VISIBILITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField
                label="Discovery cadence"
                htmlFor="mcp-settings-cadence"
                helperText="How often this endpoint is re-discovered automatically. Sub-daily cadences ask for confirmation."
                className="mcp-settings-fields__wide"
              >
                <Select
                  value={cadenceSelectValueFromForm(form.cadence)}
                  onValueChange={(v) => set("cadence", normalizeCadenceSelectValue(v))}
                >
                  <SelectTrigger id="mcp-settings-cadence">
                    <SelectValue placeholder="Default cadence" />
                  </SelectTrigger>
                  <SelectContent>
                    {cadenceOptions.map((opt) => (
                      <SelectItem
                        key={opt.value || MCP_CADENCE_DEFAULT_SELECT_VALUE}
                        value={opt.value || MCP_CADENCE_DEFAULT_SELECT_VALUE}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            {formError ? (
              // The words are the message and the glyph is emphasis: no red in the token
              // layer reads as text on a plain surface in all nine themes (see
              // `.mcp-tone-figure` in globals.css), and `.prm-error` made the same call.
              <p
                role="alert"
                className="mt-4 flex items-center gap-1.5 text-sm text-fg"
                data-testid="mcp-settings-error"
              >
                <TriangleAlert aria-hidden className="size-4 shrink-0 text-danger" />
                {formError}
              </p>
            ) : null}

            <div className="mcp-settings-actions">
              {dirty && !saving ? (
                <span
                  className="mcp-settings-actions__dirty"
                  data-testid="mcp-settings-dirty"
                >
                  <span className={`${LIFECYCLE_DOT_CLASS} bg-warn`} aria-hidden />
                  Unsaved changes
                </span>
              ) : null}
              <Button
                type="button"
                onClick={() => void handleSave()}
                disabled={anyBusy || !dirty}
                title={dirty ? "Save changes" : "No changes to save"}
              >
                {saving ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Save aria-hidden />
                )}
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </CardBody>
        </Card>
      </section>

      {/* Lifecycle ------------------------------------------------------------------------- */}
      <section className="mcp-settings-grid">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-fg">
            <Power aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
            Lifecycle
          </h3>
          <p className="mt-1 text-sm text-fg-muted">
            A disabled endpoint stays in the catalog with its versions intact but is skipped by
            scheduled discovery.
          </p>
        </div>
        <Card>
          <CardBody className="mcp-ep-row">
            <div className="flex items-center gap-3">
              <span
                className={`${LIFECYCLE_DOT_CLASS} ${endpoint.enabled ? "bg-ok" : "bg-fg-subtle"}`}
                aria-hidden
              />
              <div>
                <div className="text-sm font-medium text-fg">
                  {endpoint.enabled ? "Endpoint is enabled" : "Endpoint is disabled"}
                </div>
                <p className="text-xs text-fg-muted">
                  {endpoint.enabled
                    ? "It is included in the scheduled discovery sweep."
                    : "It is skipped by the scheduled discovery sweep."}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleToggleEnabled()}
              disabled={anyBusy}
            >
              {togglingEnabled ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : endpoint.enabled ? (
                <PowerOff aria-hidden />
              ) : (
                <Power aria-hidden />
              )}
              {endpoint.enabled ? "Disable" : "Enable"}
            </Button>
          </CardBody>
        </Card>
      </section>

      {/* Danger zone ----------------------------------------------------------------------- */}
      <section className="mcp-settings-grid">
        <div>
          <h3 className="mcp-ep-danger__title flex items-center gap-2 text-base font-semibold">
            <TriangleAlert aria-hidden className="size-[var(--fs-md)] shrink-0" />
            Danger zone
          </h3>
          <p className="mt-1 text-sm text-fg-muted">
            Destructive actions that cannot be undone.
          </p>
        </div>
        {/* The frame is emphasis, never the only signal: the heading beside it says "Danger
            zone" in words, the button is `destructive`, and deleting still needs the word
            DELETE typed into the dialog below. */}
        <Card className="mcp-ep-danger" data-testid="mcp-settings-danger">
          <CardBody className="mcp-ep-row">
            <div>
              <div className="text-sm font-medium text-fg">Delete this endpoint</div>
              <p className="text-xs text-fg-muted">
                Permanently removes the endpoint and purges its versions, discovery jobs, and
                stored credentials. This cannot be undone.
              </p>
            </div>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setDeleteConfirm("");
                setDeleteOpen(true);
              }}
              disabled={anyBusy}
            >
              <Trash2 aria-hidden />
              Delete endpoint
            </Button>
          </CardBody>
        </Card>
      </section>

      <AlertDialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{endpoint.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the endpoint and cascades to its{" "}
              <strong>versions</strong>, <strong>discovery jobs</strong>, and stored{" "}
              <strong>credentials</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div>
            <Label htmlFor="mcp-delete-confirm" className="mb-1.5 block text-sm font-medium text-fg">
              Type <span className="mono font-semibold">{MCP_DELETE_CONFIRM_WORD}</span> to confirm
            </Label>
            <Input
              id="mcp-delete-confirm"
              type="text"
              autoComplete="off"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={MCP_DELETE_CONFIRM_WORD}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!isDeleteConfirmed(deleteConfirm) || deleting}
              onClick={(e) => {
                // Keep the dialog mounted while the request runs; close it ourselves on success.
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Trash2 aria-hidden />
              )}
              {deleting ? "Deleting…" : "Delete endpoint"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
