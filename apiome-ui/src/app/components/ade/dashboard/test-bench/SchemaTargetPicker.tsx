'use client';

/**
 * SchemaTargetPicker (IXH-5.3, #5115).
 *
 * The Test Bench's schema selector: one labelled native `<select>` whose optgroups are the
 * three places a schema can come from — **operation bodies** (request/response bodies that
 * resolve to a named type), **component schemas** (the revision's named types), and **registry
 * types** (tenant-visible type-registry primitives). A native grouped select keeps the picker
 * fully keyboard- and screen-reader-accessible with zero custom wiring.
 *
 * Options are value-addressed by the schema reference itself (`project/petstore/1.0.0/Pet`,
 * `registry/std/v0/primitives/email`), so selection state is exactly the coordinate the
 * validate/synthesize calls take.
 */

import { useId } from 'react';
import {
  describeOperationBody,
  type BenchSchemaSelection,
  type SchemaOperationBodyTarget,
  type SchemaTargetType,
} from '@/app/utils/schema-test-bench';

/** A registry primitive already resolved to a usable reference. */
export interface RegistryTargetOption {
  ref: string;
  label: string;
}

export interface SchemaTargetPickerProps {
  /** Builds the full reference for a type key (`(typeKey) => 'catalog/x/latest/' + typeKey`). */
  refForType: (typeKey: string) => string;
  /** The revision's operation-body targets. */
  operationBodies: SchemaOperationBodyTarget[];
  /** The revision's named types. */
  types: SchemaTargetType[];
  /** Tenant-visible registry types, already resolved to references. */
  registryTypes: RegistryTargetOption[];
  /**
   * The bare revision reference when the revision is XML-grammar-backed (adds a
   * "Whole XML document" entry), else `null`.
   */
  xmlDocumentRef?: string | null;
  /** The selected reference, or `''` when nothing is picked yet. */
  selectedRef: string;
  /** Called with the new selection (or `null` when cleared). */
  onSelect: (selection: BenchSchemaSelection | null) => void;
  /** Disables the control while targets load. */
  disabled?: boolean;
}

/**
 * Render the grouped schema selector.
 *
 * Selection resolution is by reference: the chosen option's `value` *is* the schema reference,
 * and the matching source/label ride along on the emitted {@link BenchSchemaSelection}.
 */
export function SchemaTargetPicker({
  refForType,
  operationBodies,
  types,
  registryTypes,
  xmlDocumentRef = null,
  selectedRef,
  onSelect,
  disabled = false,
}: SchemaTargetPickerProps) {
  const selectId = useId();

  // Reference → selection, so the change handler recovers source + label from the value.
  const byRef = new Map<string, BenchSchemaSelection>();
  for (const body of operationBodies) {
    const ref = refForType(body.type_key);
    if (!byRef.has(`op:${ref}:${body.operation_key}:${body.role}:${body.status_code ?? ''}`)) {
      byRef.set(`op:${ref}:${body.operation_key}:${body.role}:${body.status_code ?? ''}`, {
        ref,
        label: describeOperationBody(body),
        source: 'operation',
      });
    }
  }
  for (const type of types) {
    byRef.set(`type:${refForType(type.key)}`, {
      ref: refForType(type.key),
      label: `${type.name} (${type.kind})`,
      source: 'type',
    });
  }
  for (const registry of registryTypes) {
    byRef.set(`registry:${registry.ref}`, {
      ref: registry.ref,
      label: registry.label,
      source: 'registry',
    });
  }
  if (xmlDocumentRef) {
    byRef.set(`document:${xmlDocumentRef}`, {
      ref: xmlDocumentRef,
      label: 'Whole XML document',
      source: 'document',
      mediaType: 'application/xml',
    });
  }

  // The select's option values are the composite keys above (unique per row even when two
  // operation bodies share a type); the selected key is recovered from the selected ref.
  const selectedKey =
    [...byRef.entries()].find(([, sel]) => sel.ref === selectedRef)?.[0] ?? '';

  const groups: Array<{ label: string; keys: string[] }> = [
    { label: 'Operation bodies', keys: [...byRef.keys()].filter((k) => k.startsWith('op:')) },
    { label: 'Component schemas', keys: [...byRef.keys()].filter((k) => k.startsWith('type:')) },
    { label: 'Registry types', keys: [...byRef.keys()].filter((k) => k.startsWith('registry:')) },
    { label: 'Documents', keys: [...byRef.keys()].filter((k) => k.startsWith('document:')) },
  ];

  return (
    <div className="vdlg-field">
      <label htmlFor={selectId} className="vdlg-caps">
        Schema
      </label>
      <select
        id={selectId}
        data-testid="test-bench-schema-select"
        className="vdlg-select"
        value={selectedKey}
        disabled={disabled}
        onChange={(event) => onSelect(byRef.get(event.target.value) ?? null)}
      >
        <option value="">Select a schema…</option>
        {groups.map((group) =>
          group.keys.length > 0 ? (
            <optgroup key={group.label} label={group.label}>
              {group.keys.map((key) => (
                <option key={key} value={key}>
                  {byRef.get(key)!.label}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>
    </div>
  );
}
