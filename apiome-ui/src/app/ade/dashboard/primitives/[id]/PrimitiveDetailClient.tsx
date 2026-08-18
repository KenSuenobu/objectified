'use client';

/**
 * One registry type, beyond the edit dialog (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria, and `docs/mockups/DESIGN.md` §5.3 (page header), §7
 * (component vocabulary) and §8 (the list pattern).
 *
 * ### What this file is now
 *
 * One read and two writes, and nothing else. Every surface it draws lives in
 * `components/ade/primitives/detail`: the schema pane, the test form, the reference and dependent
 * tables, the example, the metadata aside, the usage tiles and the base chain; every rule they
 * share lives in `primitiveDetailView.ts`. What that removed from here was 400 lines of markup —
 * a white `<header>` with an indigo library glyph, two hand-built `<table>`s with `px-5 py-3`
 * cells, six pill palettes, a `bg-gray-900` example block and a local `SchemaActionButton` that
 * re-derived the `Button` outline variant.
 *
 * ### The one card the mockup draws that this page does not
 *
 * The mockup opens the main column with a description card *and* a `page-desc` line under the
 * title, because its author wrote two different sentences. A stored type has **one**
 * `description`, and printing the same sentence twice, 24 px apart, is worse than either — so it
 * goes in the slot DESIGN.md §5.3 provides for exactly this, the header's own description line,
 * and the card is gone. Everything else on the Keeps (1:1) list is here.
 *
 * ### The dead deep-link
 *
 * The mockup's Keeps list flags it: Edit used to point at `/ade/dashboard/primitives?edit=<id>`,
 * and **nothing on the registry screen read that parameter** — the one affordance offered for
 * "edit this type" landed on an unfiltered list. `PrimitivesManagementClient` reads `?edit=` now
 * (`primitiveIdFromEditParam`), the same fix HIVE-6.5 made for its sibling `?focus=`, so the link
 * opens the editor on the type the reader was looking at.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Archive, Library, Pencil, Upload } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Badge } from '@/app/components/ui/Badge';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { downloadBlob } from '@/app/components/ade/dashboard/export/exportDownload';
import {
  BaseChainCard,
  COPY_ACK_MS,
  DEPRECATE_REASON,
  DependentsCard,
  ExampleInstanceCard,
  LOADING_MESSAGE,
  PrimitiveMetadataCard,
  PrimitiveSchemaCard,
  PrimitiveTestForm,
  PrimitiveUsageCard,
  ReferenceResolutionCard,
  detailBreadcrumb,
  editAffordance,
  headerBadges,
  type PrimitiveDetail,
} from '@/app/components/ade/primitives/detail';
import {
  buildBaseChain,
  buildExampleInstance,
  deriveOwner,
  deriveVersionRoot,
  effectiveNamespace,
  exportFileName,
  serializeSchemaExport,
  summarizeUsage,
} from '../primitiveDetailModel';

/**
 * The type-detail screen.
 *
 * @returns The page: header, main column and aside — or the loading region / failure in place of
 *   both.
 */
export default function PrimitiveDetailClient() {
  const params = useParams<{ id: string }>();
  const [primitive, setPrimitive] = useState<PrimitiveDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Transient "Copied" / "Copy failed" acknowledgement on the schema card's Copy button. */
  const [schemaCopied, setSchemaCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const loadPrimitive = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/primitives/${params.id}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.error || 'Failed to load primitive');
        setPrimitive(null);
        return;
      }
      setPrimitive(data.primitive as PrimitiveDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load primitive');
      setPrimitive(null);
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    if (params.id) {
      void loadPrimitive();
    }
  }, [params.id, loadPrimitive]);

  // Let the copy acknowledgement fall back to the idle label after a beat.
  useEffect(() => {
    if (!schemaCopied && !copyFailed) return undefined;
    const timer = setTimeout(() => {
      setSchemaCopied(false);
      setCopyFailed(false);
    }, COPY_ACK_MS);
    return () => clearTimeout(timer);
  }, [schemaCopied, copyFailed]);

  // The header's Export action and the schema card's Download button are the same operation, so
  // both go through here — one filename and one serialization for the file the user ends up with.
  const handleExport = useCallback(() => {
    if (!primitive) return;
    const blob = new Blob([serializeSchemaExport(primitive.schema)], { type: 'application/json' });
    downloadBlob(blob, exportFileName(primitive.name));
  }, [primitive]);

  const handleCopySchema = useCallback(async () => {
    if (!primitive) return;
    try {
      await navigator.clipboard.writeText(serializeSchemaExport(primitive.schema));
      setSchemaCopied(true);
    } catch {
      // Clipboard unavailable (insecure context / denied permission) — say so rather than
      // flashing "Copied" for a write that never landed.
      setCopyFailed(true);
    }
  }, [primitive]);

  const baseChain = useMemo(
    () => (primitive ? buildBaseChain(primitive.name, primitive.refs) : []),
    [primitive]
  );
  const usage = useMemo(
    () => (primitive ? summarizeUsage(primitive.dependents, primitive.usage_count) : null),
    [primitive]
  );
  const exampleInstance = useMemo(
    () => (primitive ? buildExampleInstance(primitive.schema) : null),
    [primitive]
  );
  const schemaJson = useMemo(
    () => (primitive ? serializeSchemaExport(primitive.schema) : ''),
    [primitive]
  );

  // The schema's own `$id` is the authority for where the type lives, so the namespace is read back
  // out of it; the stored column only stands in when the id carries no recoverable namespace (an
  // explicit `base_uri`, or an author-declared `$id` outside the registry mount). Preferring the
  // document's `$id` over the `schema_id` column keeps the display tied to the schema on screen.
  const schemaIdentity =
    (typeof primitive?.schema?.$id === 'string' ? primitive.schema.$id : null) ??
    primitive?.schema_id ??
    null;
  const namespacePath = primitive ? effectiveNamespace(schemaIdentity, primitive.namespace) : null;
  const versionRoot = primitive ? deriveVersionRoot(namespacePath, primitive.base_uri) : null;
  const edit = primitive ? editAffordance(primitive) : null;

  return (
    <Page>
      <PageHeader
        breadcrumb={detailBreadcrumb(namespacePath)}
        title={
          <>
            <Library aria-hidden className="pd-title-glyph" />
            {loading ? 'Loading type…' : primitive?.name ?? 'Type detail'}
          </>
        }
        badge={
          primitive ? (
            <span className="pd-badges">
              {headerBadges(primitive).map((badge) => (
                <Badge
                  key={badge.id}
                  variant={badge.tone}
                  mono={badge.mono}
                  data-testid={`primitive-detail-badge-${badge.id}`}
                >
                  {badge.label}
                </Badge>
              ))}
            </span>
          ) : null
        }
        description={primitive?.description ?? undefined}
        actions={
          primitive && edit ? (
            <>
              {edit.href ? (
                <Button variant="outline" asChild title={edit.title}>
                  <Link href={edit.href} data-testid="primitive-detail-edit">
                    <Pencil aria-hidden />
                    Edit
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" disabled title={edit.title} data-testid="primitive-detail-edit">
                  <Pencil aria-hidden />
                  Edit
                </Button>
              )}
              <Button variant="outline" onClick={handleExport} data-testid="primitive-detail-export">
                <Upload aria-hidden />
                Export
              </Button>
              <Button
                variant="danger-soft"
                disabled
                title={DEPRECATE_REASON}
                data-testid="primitive-detail-deprecate"
              >
                <Archive aria-hidden />
                Deprecate
              </Button>
            </>
          ) : undefined
        }
      />

      <PageBody>
        {loading ? (
          <LoadingState minHeightClassName="min-h-[15rem]" message={LOADING_MESSAGE} />
        ) : error ? (
          <ErrorState
            title="This type could not be loaded"
            description={error}
            onRetry={() => void loadPrimitive()}
            data-testid="primitive-detail-error"
          />
        ) : primitive ? (
          <div className="pd-grid">
            <div className="pd-col">
              <PrimitiveSchemaCard
                name={primitive.name}
                draft={primitive.draft}
                json={schemaJson}
                copied={schemaCopied}
                copyFailed={copyFailed}
                onCopy={() => void handleCopySchema()}
                onDownload={handleExport}
              />

              <PrimitiveTestForm schema={primitive.schema} name={primitive.name} />

              <ReferenceResolutionCard refs={primitive.refs ?? []} baseUri={primitive.base_uri} />

              {exampleInstance !== null ? (
                <ExampleInstanceCard instance={exampleInstance} />
              ) : null}

              <DependentsCard
                dependents={primitive.dependents ?? []}
                identity={primitive.schema_id ?? primitive.name}
              />
            </div>

            <aside className="pd-col">
              <PrimitiveMetadataCard
                isSystem={primitive.is_system}
                schemaId={primitive.schema_id}
                namespace={namespacePath}
                versionRoot={versionRoot}
                owner={deriveOwner(primitive.is_system, namespacePath)}
                source={primitive.source}
                createdAt={primitive.created_at}
              />

              {usage ? <PrimitiveUsageCard usage={usage} /> : null}

              <BaseChainCard chain={baseChain} category={primitive.category} />
            </aside>
          </div>
        ) : null}
      </PageBody>
    </Page>
  );
}
