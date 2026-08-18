'use client';

/**
 * The project form — Basic information beside API metadata (HIVE-6.1, #5312).
 *
 * Authority: `docs/mockups/build/projects.html` §"New project" dialog, `manual` tab: the
 * starting-template row as a `.card--soft`, then a two-column grid of two `.form-section`s,
 * every control a `.field` with its `.hint` under it.
 *
 * Shared by three surfaces — the Projects create dialog, the Projects edit dialog and the
 * repository import mapping (`RepositoryFileImportMapping`, which hides the template row) —
 * which is why the fields live here rather than inside a dialog. Its props are unchanged by
 * this ticket; only the skin is.
 *
 * ### What the re-skin fixes
 *
 * Thirty-one colour literals: `border-gray-200 bg-gray-50/80`, `text-indigo-600
 * dark:text-indigo-400` on the template glyph, and a `text-gray-500 dark:text-gray-400` hint
 * under nine separate fields — the hint the {@link FormField} primitive already draws, in the
 * one ink DESIGN.md §3.2 clears for 12 px text. The two columns were divided by
 * `divide-x divide-gray-200`, which draws the rule *between grid tracks that have collapsed*
 * on a narrow viewport, i.e. a vertical hairline through the middle of a one-column form.
 * `.prj-form` is a real grid with a real gap, so it collapses cleanly.
 */

import * as React from 'react';
import { ExternalLink, Layers } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { Textarea } from '@/app/components/ui/Textarea';
import {
  PROJECT_DOMAIN_CATEGORIES,
  PROJECT_DOMAIN_CATEGORY_NONE,
  getProjectDomainCategory,
} from '@/app/utils/project-domain-categories';
import {
  PROJECT_START_TEMPLATES,
  applyProjectStartTemplate,
  getProjectStartTemplate,
  BLANK_TEMPLATE_ID,
} from '@/app/utils/project-templates';
import { filterSlugInput, generateSlug } from '@/app/utils/slug';
import { SPDX_LICENSES, getLicenseUrl, type SPDXLicense } from '@/app/utils/spdx-licenses';

export type CreateProjectManualFormModel = {
  projectName: string;
  projectSlug: string;
  projectDescription: string;
  selectedStartTemplateId: string;
  projectDomainCategoryId: string;
  metadataSummary: string;
  metadataTermsOfService: string;
  metadataContactName: string;
  metadataContactUrl: string;
  metadataContactEmail: string;
  metadataLicenseName: string;
  metadataLicenseIdentifier: string;
  metadataLicenseUrl: string;
};

export const EMPTY_CREATE_PROJECT_MANUAL_FORM: CreateProjectManualFormModel = {
  projectName: '',
  projectSlug: '',
  projectDescription: '',
  selectedStartTemplateId: BLANK_TEMPLATE_ID,
  projectDomainCategoryId: PROJECT_DOMAIN_CATEGORY_NONE,
  metadataSummary: '',
  metadataTermsOfService: '',
  metadataContactName: '',
  metadataContactUrl: '',
  metadataContactEmail: '',
  metadataLicenseName: '',
  metadataLicenseIdentifier: '',
  metadataLicenseUrl: '',
};

/**
 * Whether a typed URL is one the "open" button can actually open.
 *
 * @param value The field's current text.
 * @returns True for an `http(s)` URL with something after the scheme.
 */
function isOpenableUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^https?:\/\/\S/i.test(trimmed);
}

/** Props for {@link UrlField} — a URL input with the "open in a new tab" button beside it. */
interface UrlFieldProps {
  /** The control's id, so the label points at it. */
  id: string;
  /** The field's name. */
  label: string;
  /** The current value. */
  value: string;
  /** Report a change. */
  onChange: (next: string) => void;
  /** True while a write is in flight. */
  disabled?: boolean;
  /** Placeholder text. */
  placeholder?: string;
  /** A sentence under the control. */
  helperText?: string;
}

/**
 * A URL field and its open button.
 *
 * Written once because the form has three of them — terms of service, contact and licence —
 * and each carried its own eleven-line `disabled` expression re-deriving "is this an http
 * URL?" from scratch. One helper means one answer.
 *
 * @param props See {@link UrlFieldProps}.
 * @returns The field.
 */
function UrlField({
  id,
  label,
  value,
  onChange,
  disabled = false,
  placeholder,
  helperText,
}: UrlFieldProps) {
  const openable = isOpenableUrl(value);
  return (
    <FormField label={label} helperText={helperText} htmlFor={id}>
      <div className="prj-form__url">
        <Input
          id={id}
          type="url"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={disabled || !openable}
          onClick={() => window.open(value.trim(), '_blank', 'noopener,noreferrer')}
          title="Open URL in a new tab"
          aria-label={`Open ${label} in a new tab`}
        >
          <ExternalLink aria-hidden />
        </Button>
      </div>
    </FormField>
  );
}

/**
 * The project form's fields.
 *
 * @param props The model, the change handler, and the two flags that vary by surface.
 * @returns The template row (optionally) and the two-column field grid.
 */
export function CreateProjectManualFormFields({
  model,
  onChange,
  disabled = false,
  fieldIdPrefix,
  errorMessage,
  showStartTemplatePicker = true,
}: {
  model: CreateProjectManualFormModel;
  onChange: (patch: Partial<CreateProjectManualFormModel>) => void;
  disabled?: boolean;
  /** Prefix for element ids (must be unique per mount). */
  fieldIdPrefix: string;
  errorMessage?: string | null;
  /** Hide the starting-template preset row (e.g. repository import uses spec copy instead). */
  showStartTemplatePicker?: boolean;
}) {
  const selectedStartTemplateHint = showStartTemplatePicker
    ? getProjectStartTemplate(model.selectedStartTemplateId)?.hint
    : undefined;
  const selectedProjectDomainCategory = React.useMemo(
    () => getProjectDomainCategory(model.projectDomainCategoryId),
    [model.projectDomainCategoryId]
  );

  const applyLicenseByIdentifier = (identifier: string) => {
    const license = SPDX_LICENSES.find((entry: SPDXLicense) => entry.identifier === identifier);
    if (!license) return;
    onChange({
      metadataLicenseIdentifier: license.identifier,
      metadataLicenseName: license.name,
      metadataLicenseUrl: getLicenseUrl(license.identifier) ?? model.metadataLicenseUrl,
    });
  };

  return (
    <>
      {errorMessage ? <Alert variant="error">{errorMessage}</Alert> : null}

      {showStartTemplatePicker ? (
        <div className="prj-template" data-testid="project-start-template">
          <span className="tnt-icon-tile" data-tone="accent">
            <Layers aria-hidden />
          </span>
          <div className="prj-template__text">
            <p className="prj-template__title">Starting template</p>
            <p className="prj-template__desc">
              Presets OpenAPI fields (summary, contact, license, terms). You can edit everything
              before continuing.
            </p>
            {selectedStartTemplateHint ? (
              <p className="prj-template__hint">{selectedStartTemplateHint}</p>
            ) : null}
          </div>
          <Select
            value={model.selectedStartTemplateId}
            onValueChange={(id) => {
              const { metadata, suggestedDescription } = applyProjectStartTemplate(id);
              onChange({
                selectedStartTemplateId: id,
                projectDescription: suggestedDescription,
                metadataSummary: metadata.summary ?? '',
                metadataTermsOfService: metadata.termsOfService ?? '',
                metadataContactName: metadata.contact?.name ?? '',
                metadataContactUrl: metadata.contact?.url ?? '',
                metadataContactEmail: metadata.contact?.email ?? '',
                metadataLicenseName: metadata.license?.name ?? '',
                metadataLicenseIdentifier: metadata.license?.identifier ?? '',
                metadataLicenseUrl: metadata.license?.url ?? '',
                projectDomainCategoryId: metadata.domainCategory ?? PROJECT_DOMAIN_CATEGORY_NONE,
              });
            }}
            disabled={disabled}
          >
            <SelectTrigger
              id={`${fieldIdPrefix}projectStartTemplate`}
              aria-label="Starting template"
              className="prj-template__select"
            >
              <SelectValue placeholder="Select a template" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {PROJECT_START_TEMPLATES.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="prj-form">
        <section className="prj-form__col">
          <h3 className="prj-form__title">Basic information</h3>

          <FormField label="Project name" required htmlFor={`${fieldIdPrefix}projectName`}>
            <Input
              id={`${fieldIdPrefix}projectName`}
              value={model.projectName}
              placeholder="e.g. Payments API"
              onChange={(event) => {
                const next = event.target.value;
                // The slug follows the name only while nobody has taken it over — once it
                // has been edited by hand, renaming the project must not silently rewrite
                // the identifier other systems already reference.
                const nextSlug =
                  !model.projectSlug || model.projectSlug === generateSlug(model.projectName)
                    ? generateSlug(next)
                    : model.projectSlug;
                onChange({ projectName: next, projectSlug: nextSlug });
              }}
              disabled={disabled}
            />
          </FormField>

          <FormField
            label="Slug"
            required
            htmlFor={`${fieldIdPrefix}projectSlug`}
            helperText="URL-friendly identifier — lowercase letters, numbers and dashes. Suggested from the name."
          >
            <Input
              id={`${fieldIdPrefix}projectSlug`}
              value={model.projectSlug}
              onChange={(event) => onChange({ projectSlug: filterSlugInput(event.target.value) })}
              disabled={disabled}
              className="mono"
            />
          </FormField>

          <FormField label="Description" htmlFor={`${fieldIdPrefix}projectDescription`}>
            <Textarea
              id={`${fieldIdPrefix}projectDescription`}
              value={model.projectDescription}
              placeholder="What does this API do, and for whom?"
              onChange={(event) => onChange({ projectDescription: event.target.value })}
              disabled={disabled}
              rows={4}
            />
          </FormField>

          <FormField
            label="Domain category"
            htmlFor={`${fieldIdPrefix}projectDomainCategory`}
            helperText={
              selectedProjectDomainCategory?.hint ??
              'Optional. Classifies the kind of entities and schemas this project models.'
            }
          >
            <Select
              value={model.projectDomainCategoryId}
              onValueChange={(id) => onChange({ projectDomainCategoryId: id })}
              disabled={disabled}
            >
              <SelectTrigger
                id={`${fieldIdPrefix}projectDomainCategory`}
                aria-label="Domain category"
              >
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROJECT_DOMAIN_CATEGORY_NONE}>None</SelectItem>
                {PROJECT_DOMAIN_CATEGORIES.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </section>

        <section className="prj-form__col">
          <h3 className="prj-form__title">
            API metadata <span className="prj-form__title-aside">(OpenAPI info)</span>
          </h3>

          <FormField label="API summary" htmlFor={`${fieldIdPrefix}createSummary`}>
            <Input
              id={`${fieldIdPrefix}createSummary`}
              value={model.metadataSummary}
              placeholder="One line shown in Browse and exports"
              onChange={(event) => onChange({ metadataSummary: event.target.value })}
              disabled={disabled}
            />
          </FormField>

          <UrlField
            id={`${fieldIdPrefix}createTermsOfService`}
            label="Terms of service URL"
            value={model.metadataTermsOfService}
            onChange={(next) => onChange({ metadataTermsOfService: next })}
            disabled={disabled}
            placeholder="https://example.com/terms"
          />

          <div className="prj-form__pair">
            <FormField label="Contact name" htmlFor={`${fieldIdPrefix}createContactName`}>
              <Input
                id={`${fieldIdPrefix}createContactName`}
                value={model.metadataContactName}
                onChange={(event) => onChange({ metadataContactName: event.target.value })}
                disabled={disabled}
              />
            </FormField>
            <FormField label="Contact email" htmlFor={`${fieldIdPrefix}createContactEmail`}>
              <Input
                id={`${fieldIdPrefix}createContactEmail`}
                type="email"
                value={model.metadataContactEmail}
                placeholder="api@acme.dev"
                onChange={(event) => onChange({ metadataContactEmail: event.target.value })}
                disabled={disabled}
              />
            </FormField>
          </div>

          <UrlField
            id={`${fieldIdPrefix}createContactUrl`}
            label="Contact URL"
            value={model.metadataContactUrl}
            onChange={(next) => onChange({ metadataContactUrl: next })}
            disabled={disabled}
            placeholder="https://"
          />

          <FormField
            label="License (SPDX)"
            htmlFor={`${fieldIdPrefix}createLicenseIdentifier`}
            helperText="Auto-fills the license name and URL."
          >
            <Select value={model.metadataLicenseIdentifier} onValueChange={applyLicenseByIdentifier}>
              <SelectTrigger
                id={`${fieldIdPrefix}createLicenseIdentifier`}
                aria-label="License (SPDX)"
              >
                <SelectValue placeholder="Select a license…" />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {SPDX_LICENSES.slice(0, 50).map((license: SPDXLicense) => (
                  <SelectItem key={license.identifier} value={license.identifier}>
                    {license.name} ({license.identifier})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <div className="prj-form__pair">
            <FormField label="License name" htmlFor={`${fieldIdPrefix}createLicenseName`}>
              <Input
                id={`${fieldIdPrefix}createLicenseName`}
                value={model.metadataLicenseName}
                onChange={(event) => onChange({ metadataLicenseName: event.target.value })}
                disabled={disabled}
              />
            </FormField>
            <UrlField
              id={`${fieldIdPrefix}createLicenseUrl`}
              label="License URL"
              value={model.metadataLicenseUrl}
              onChange={(next) => onChange({ metadataLicenseUrl: next })}
              disabled={disabled}
            />
          </div>
        </section>
      </div>
    </>
  );
}
