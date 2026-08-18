'use client';

/**
 * The three-step primitive import wizard (restyled by HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Overlays → *Import primitives (3-step)* —
 * the source-kind cards, the File / URL / Paste intake, the detected-types and `$ref` panels
 * with their exact unresolved-refs copy, the review rows with their four classifications, and
 * the result buckets with the import record id.
 *
 * ### What changed
 *
 * The parse, the review call, the conflict resolutions and the import request are untouched;
 * this is the skin. It borrows the `.imp-wizard` frame the catalog's import wizard already uses
 * (HIVE-6.4, #5315) rather than restating it — the two wizards are the same shape, and the
 * reason the class exists is that a `dialog--full` whose middle is the only scrolling part is a
 * four-part contract that should be written once. Its own step row is {@link Stepper}, the
 * shared component, in place of three hand-tinted `rounded-full` chips.
 *
 * What went with the palette: the source picker's `border-indigo-500 bg-indigo-50 ring-1`
 * selected card, the `border-dashed border-gray-300` drop zone and its `border-indigo-500`
 * drag state, `text-emerald-600` / `text-amber-600` / `text-red-600` inline status text in
 * eleven places, a `bg-gray-100 dark:bg-gray-800` schema preview per review row, and Monaco's
 * `vs-dark`, which was a black box on a paper page in six of the nine themes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Boxes,
  CheckCircle,
  FileCode,
  FileJson,
  FileText,
  ScanSearch,
  Upload,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import { Alert, AlertTitle } from '@/app/components/ui/Alert';
import { Badge, type BadgeTone } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { Checkbox } from '@/app/components/ui/Checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Stepper, type StepperStep } from '@/app/components/ui/Stepper';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/app/components/ui/Tabs';
import { useHiveMonacoTheme } from '@/app/components/ui/code/monacoHiveTheme';
import dynamic from 'next/dynamic';
import {
  type SourceKind,
  type SourceMethod,
  type ReviewResponse,
  type ReviewType,
  type ReviewStatus,
  type ResolutionAction,
  type ResolutionMap,
  type ImportOptions,
  type ImportResultSummary,
  parseSchemaContent,
  extractDefinitions,
  determineCategoryFromSchema,
  buildImportRequestBody,
  defaultResolutions,
  defaultSelectedNames,
  validateSelection,
  summarizeImportResult,
  describeImportResult,
  sourceKindLabel,
  extractTargetNamespace,
  describeDetectedTypes,
  countCautionedTypes,
  type DetectedType,
} from './primitiveImportModel';
import {
  applyRefRewrites,
  buildKnownTargets,
  refRewriteMap,
  resolveImportRefs,
  summarizeRefResolutions,
  type RefResolution,
} from './primitiveRefResolution';
import {
  persistPrimitiveImportPreferences,
  readPrimitiveImportPreferences,
} from '@/app/utils/primitive-import-preferences';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface Props {
  onClose: () => void;
  onComplete: () => void;
  onMessage: (type: 'success' | 'error', message: string) => void;
  initialSource?: PrimitiveImportInitialSource | null;
}

type WizardStep = 'source' | 'review' | 'result';

export interface PrimitiveImportInitialSource {
  sourceKind?: SourceKind;
  sourceMethod?: SourceMethod;
  text?: string;
  document?: Record<string, unknown> | null;
  label?: string | null;
}

/** Source-kind cards offered in the source step. */
const SOURCE_KIND_CARDS: Array<{ kind: SourceKind; title: string; description: string; icon: typeof FileJson }> = [
  {
    kind: 'json-schema',
    title: 'JSON Schema',
    description: 'A draft 2020-12 document with $defs or definitions, or a standalone type.',
    icon: FileJson,
  },
  {
    kind: 'type-def-bundle',
    title: 'Type-def bundle',
    description: 'An Apiome bundle of interlinked types under a types container.',
    icon: Boxes,
  },
  {
    kind: 'openapi',
    title: 'OpenAPI',
    description: 'Reuse component schemas from an OpenAPI document’s $defs / definitions.',
    icon: FileText,
  },
];

/**
 * Badge tone + label for a review classification.
 *
 * A conflict is `danger` rather than the amber it used to be: the mockup paints it red, and it
 * is the one row state that *blocks* — the import cannot proceed until the reader chooses keep,
 * overwrite or rename. Amber is left to the advisories, which do not.
 */
const STATUS_BADGE: Record<ReviewStatus, { variant: BadgeTone; label: string }> = {
  new: { variant: 'ok', label: 'New' },
  identical: { variant: 'outline', label: 'Identical' },
  conflict: { variant: 'danger', label: 'Conflict' },
  invalid: { variant: 'danger', label: 'Invalid' },
};

/** The wizard's three steps, as the shared {@link Stepper} draws them. */
const WIZARD_STEPS: readonly StepperStep[] = [
  { id: 'source', label: 'Source' },
  { id: 'review', label: 'Review' },
  { id: 'result', label: 'Result' },
];

export default function PrimitiveImportDialog({ onClose, onComplete, onMessage, initialSource }: Props) {
  const [step, setStep] = useState<WizardStep>('source');

  // Source selection + options.
  const [sourceKind, setSourceKind] = useState<SourceKind>(initialSource?.sourceKind ?? 'json-schema');
  const [sourceMethod, setSourceMethod] = useState<SourceMethod>(initialSource?.sourceMethod ?? 'file');
  const [targetNamespace, setTargetNamespace] = useState('');
  const [mapCoreFormats, setMapCoreFormats] = useState(true);
  const [dedupe, setDedupe] = useState(true);

  // Parsed source document + provenance label.
  const [parsedDoc, setParsedDoc] = useState<Record<string, unknown> | null>(
    initialSource?.document ?? (initialSource?.text ? parseSchemaContent(initialSource.text) : null)
  );
  const [sourceLabel, setSourceLabel] = useState<string | null>(initialSource?.label ?? null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Source intake state (file / url / paste).
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [schemaText, setSchemaText] = useState(initialSource?.text ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Review + commit state.
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [resolutions, setResolutions] = useState<ResolutionMap>({});
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResultSummary | null>(null);

  // What "Extract from Target" reported last time it ran, shown under the field.
  const [namespaceNotice, setNamespaceNotice] = useState<string | null>(null);
  /** Standing preference: run the extraction on every document instead of on demand. */
  const [autoExtractNamespace, setAutoExtractNamespace] = useState(false);

  // Read on mount rather than in the initial state so the server render and the first client render
  // agree (localStorage is unreadable during SSR).
  useEffect(() => {
    setAutoExtractNamespace(readPrimitiveImportPreferences().autoExtractNamespace);
  }, []);

  const handleAutoExtractChange = useCallback((value: boolean) => {
    setAutoExtractNamespace(value);
    persistPrimitiveImportPreferences({ autoExtractNamespace: value });
  }, []);

  const options: ImportOptions = useMemo(
    () => ({ sourceKind, targetNamespace, mapCoreFormats, dedupe }),
    [sourceKind, targetNamespace, mapCoreFormats, dedupe]
  );

  /**
   * Fill the target namespace from the loaded document's `$id`s. Nothing is overwritten silently:
   * when the document declares no namespace the field is left as-is and the reason is shown.
   */
  const handleExtractNamespace = useCallback(() => {
    const extraction = extractTargetNamespace(parsedDoc, sourceKind, sourceLabel ?? undefined);
    if (extraction.namespace) {
      setTargetNamespace(extraction.namespace);
    }
    setNamespaceNotice(extraction.detail);
  }, [parsedDoc, sourceKind, sourceLabel]);

  /**
   * With the preference on, extract as each document arrives (and the moment the preference itself
   * is switched on with one already loaded).
   *
   * Deliberately keyed on the document and source kind rather than on the field: a namespace typed
   * by hand afterwards stands until a *different* document is loaded, so "automatic" never means
   * "overwrites what you just typed".
   */
  useEffect(() => {
    if (!autoExtractNamespace || !parsedDoc) return;
    const extraction = extractTargetNamespace(parsedDoc, sourceKind, sourceLabel ?? undefined);
    if (extraction.namespace) {
      setTargetNamespace(extraction.namespace);
    }
    setNamespaceNotice(extraction.detail);
  }, [autoExtractNamespace, parsedDoc, sourceKind, sourceLabel]);

  // Client-side preview of detected definitions (the server review is authoritative).
  const previewDefinitions = useMemo(() => {
    if (!parsedDoc) return {};
    return extractDefinitions(parsedDoc, sourceKind, sourceLabel ?? undefined);
  }, [parsedDoc, sourceKind, sourceLabel]);

  /**
   * The tenant's existing types, used to tell a `$ref` that points at something real from one that
   * points nowhere. Loaded once when the wizard opens; a failure leaves the list empty, which
   * degrades resolution to "matches only types in this document" rather than breaking the step.
   */
  const [registryTypes, setRegistryTypes] = useState<
    Array<{ schema_id?: string | null; namespace?: string | null; name?: string | null }>
  >([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/primitives');
        const data = await response.json();
        if (!cancelled && response.ok && data?.success !== false) {
          setRegistryTypes(Array.isArray(data.primitives) ? data.primitives : []);
        }
      } catch {
        // Offline / unauthorized — resolution still runs against this document's own types.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Where every `$ref` in the detected types points, and what had to be rewritten to get it there.
   * Recomputed as the target namespace changes, since that is what relative refs resolve against.
   */
  const refResolutions = useMemo(() => {
    const names = Object.keys(previewDefinitions);
    if (names.length === 0) return [];
    const knownTargets = buildKnownTargets(registryTypes, names, targetNamespace);
    return resolveImportRefs(previewDefinitions, { targetNamespace, knownTargets });
  }, [previewDefinitions, registryTypes, targetNamespace]);

  const refSummary = useMemo(() => summarizeRefResolutions(refResolutions), [refResolutions]);

  /**
   * The document actually sent for review and commit: the reader's source with every repaired
   * `$ref` replaced by one that resolves. The parsed source itself is left alone so detection
   * always re-runs from what was supplied.
   */
  const documentForImport = useCallback(
    (doc: Record<string, unknown>) => applyRefRewrites(doc, refRewriteMap(refResolutions)),
    [refResolutions]
  );

  /** Store a successfully parsed source document and reset downstream review state. */
  const acceptDocument = useCallback((doc: Record<string, unknown>, label: string | null) => {
    setParsedDoc(doc);
    setSourceLabel(label);
    setParseError(null);
    setReview(null);
    setResult(null);
    // The previous extraction described a document that is no longer loaded.
    setNamespaceNotice(null);
  }, []);

  const clearDocument = useCallback(() => {
    setParsedDoc(null);
    setSourceLabel(null);
    setReview(null);
    setResult(null);
    setNamespaceNotice(null);
  }, []);

  const handleFileSelect = useCallback(
    async (selectedFile: File) => {
      const fileName = selectedFile.name.toLowerCase();
      if (!fileName.endsWith('.json') && !fileName.endsWith('.yaml') && !fileName.endsWith('.yml')) {
        setParseError('Please select a JSON or YAML file');
        return;
      }

      setFile(selectedFile);
      setIsLoadingFile(true);
      setParseError(null);

      try {
        const content = await selectedFile.text();
        const parsed = parseSchemaContent(content);
        if (!parsed) {
          setParseError('Failed to parse file. Please ensure it contains valid JSON or YAML.');
          setFile(null);
          return;
        }
        setSchemaText(JSON.stringify(parsed, null, 2));
        acceptDocument(parsed, selectedFile.name);
      } catch (err) {
        setParseError(`Error reading file: ${(err as Error).message}`);
        setFile(null);
      } finally {
        setIsLoadingFile(false);
      }
    },
    [acceptDocument]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        void handleFileSelect(files[0]);
      }
    },
    [handleFileSelect]
  );

  const clearFile = useCallback(() => {
    setFile(null);
    setSchemaText('');
    clearDocument();
    setParseError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [clearDocument]);

  const handleUrlFetch = useCallback(async () => {
    if (!urlInput.trim()) {
      setParseError('Please enter a URL');
      return;
    }
    try {
      new URL(urlInput);
    } catch {
      setParseError('Please enter a valid URL');
      return;
    }

    setIsLoadingUrl(true);
    setParseError(null);

    try {
      const response = await fetch(urlInput);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const content = await response.text();
      const parsed = parseSchemaContent(content);
      if (!parsed) {
        setParseError('Failed to parse response. Please ensure the URL returns valid JSON or YAML.');
        return;
      }
      setSchemaText(JSON.stringify(parsed, null, 2));
      const urlFilename = new URL(urlInput).pathname.split('/').pop() || urlInput;
      acceptDocument(parsed, urlFilename);
    } catch (err) {
      setParseError(`Failed to fetch from URL: ${(err as Error).message}`);
    } finally {
      setIsLoadingUrl(false);
    }
  }, [urlInput, acceptDocument]);

  const handleParsePasted = useCallback(() => {
    const parsed = parseSchemaContent(schemaText);
    if (!parsed) {
      setParseError('Invalid document. Please paste valid JSON or YAML.');
      return false;
    }
    acceptDocument(parsed, 'Pasted document');
    return true;
  }, [schemaText, acceptDocument]);

  const handleSchemaTextChange = useCallback(
    (value: string | undefined) => {
      setSchemaText(value || '');
      setParseError(null);
      // A new paste invalidates a previously parsed document until re-parsed.
      if (sourceMethod === 'paste') {
        clearDocument();
      }
    },
    [sourceMethod, clearDocument]
  );

  /** Run the dry-run review and advance to the review step. */
  const handleReview = useCallback(async () => {
    let doc = parsedDoc;
    if (!doc && sourceMethod === 'paste') {
      const parsed = parseSchemaContent(schemaText);
      if (!parsed) {
        setParseError('Invalid document. Please paste valid JSON or YAML.');
        return;
      }
      doc = parsed;
      acceptDocument(parsed, 'Pasted document');
    }
    if (!doc) {
      setParseError('Provide a source document first');
      return;
    }

    setReviewing(true);
    setReviewError(null);

    try {
      const body = buildImportRequestBody(documentForImport(doc), options, sourceLabel);
      const response = await fetch('/api/primitives/import/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        setReviewError(data.error || 'Failed to review import');
        return;
      }

      const reviewResult = data.review as ReviewResponse;
      setReview(reviewResult);
      setSelectedNames(new Set(defaultSelectedNames(reviewResult.types)));
      setResolutions(defaultResolutions(reviewResult.types));
      setStep('review');
    } catch (err) {
      setReviewError(`Failed to review import: ${(err as Error).message}`);
    } finally {
      setReviewing(false);
    }
  }, [parsedDoc, sourceMethod, schemaText, options, sourceLabel, acceptDocument, documentForImport]);

  const toggleSelected = useCallback((name: string) => {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const setResolutionAction = useCallback((name: string, action: ResolutionAction) => {
    setResolutions((current) => ({
      ...current,
      [name]: { action, new_name: action === 'rename' ? current[name]?.new_name ?? '' : undefined },
    }));
  }, []);

  const setResolutionNewName = useCallback((name: string, newName: string) => {
    setResolutions((current) => ({
      ...current,
      [name]: { action: 'rename', new_name: newName },
    }));
  }, []);

  /** Commit the selected types with their conflict resolutions and advance to the result step. */
  const handleImport = useCallback(async () => {
    if (!parsedDoc || !review) return;

    const names = Array.from(selectedNames);
    const validationError = validateSelection(names, review.types, resolutions);
    if (validationError) {
      setReviewError(validationError);
      return;
    }

    setImporting(true);
    setReviewError(null);

    try {
      const body = buildImportRequestBody(documentForImport(parsedDoc), options, sourceLabel, {
        selectedNames: names,
        resolutions,
      });
      const response = await fetch('/api/primitives/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        setReviewError(data.error || 'Failed to import primitives');
        return;
      }

      const summary = summarizeImportResult(data);
      setResult(summary);
      setStep('result');
      onMessage('success', describeImportResult(summary));
    } catch (err) {
      setReviewError(`Failed to import primitives: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  }, [parsedDoc, review, selectedNames, resolutions, options, sourceLabel, onMessage, documentForImport]);

  // Memoized on the definitions: the draft 2020-12 check compiles a metaschema validator, which is
  // not work to repeat on every keystroke elsewhere in the step.
  const detectedTypes = useMemo(() => describeDetectedTypes(previewDefinitions), [previewDefinitions]);
  const canReview = Boolean(parsedDoc) || (sourceMethod === 'paste' && schemaText.trim().length > 0);


  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent size="full" className="imp-wizard" aria-describedby={undefined}>
        <DialogHeader className="imp-wizard__head">
          <span className="tnt-icon-tile" data-tone="accent" aria-hidden>
            <Upload />
          </span>
          <div className="imp-wizard__heading">
            <DialogTitle>Import primitives</DialogTitle>
            <p className="prm-quiet">
              Review detected types, resolve refs and conflicts, then import.
            </p>
          </div>
        </DialogHeader>

        <div className="imp-wizard__steps">
          <Stepper steps={WIZARD_STEPS} current={step} aria-label="Import progress" />
        </div>

        <div className="imp-wizard__body prm-dialog__body">
          {step === 'source' && (
            <SourceStep
              sourceKind={sourceKind}
              onSourceKindChange={(kind) => {
                setSourceKind(kind);
                setReview(null);
              }}
              sourceMethod={sourceMethod}
              onSourceMethodChange={(method) => {
                setSourceMethod(method);
                setParseError(null);
              }}
              targetNamespace={targetNamespace}
              onTargetNamespaceChange={setTargetNamespace}
              onExtractNamespace={handleExtractNamespace}
              namespaceNotice={namespaceNotice}
              autoExtractNamespace={autoExtractNamespace}
              onAutoExtractNamespaceChange={handleAutoExtractChange}
              mapCoreFormats={mapCoreFormats}
              onMapCoreFormatsChange={setMapCoreFormats}
              dedupe={dedupe}
              onDedupeChange={setDedupe}
              file={file}
              isDragging={isDragging}
              isLoadingFile={isLoadingFile}
              fileInputRef={fileInputRef}
              onFileSelect={handleFileSelect}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClearFile={clearFile}
              urlInput={urlInput}
              onUrlInputChange={setUrlInput}
              isLoadingUrl={isLoadingUrl}
              onUrlFetch={handleUrlFetch}
              schemaText={schemaText}
              onSchemaTextChange={handleSchemaTextChange}
              onParsePasted={handleParsePasted}
              parseError={parseError}
              reviewError={reviewError}
              detectedTypes={detectedTypes}
              refResolutions={refResolutions}
              refSummary={refSummary}
              hasDocument={Boolean(parsedDoc)}
            />
          )}

          {step === 'review' && review && (
            <ReviewStep
              review={review}
              previewDefinitions={previewDefinitions}
              selectedNames={selectedNames}
              resolutions={resolutions}
              onToggleSelected={toggleSelected}
              onResolutionAction={setResolutionAction}
              onResolutionNewName={setResolutionNewName}
              reviewError={reviewError}
            />
          )}

          {step === 'result' && result && <ResultStep result={result} />}
        </div>

        <DialogFooter className="imp-wizard__foot">
          <span className="imp-wizard__foot-lead">
            {step === 'review' && review ? (
              <Button variant="ghost" onClick={() => setStep('source')} disabled={importing}>
                <ArrowLeft aria-hidden />
                Back
              </Button>
            ) : null}
          </span>
          <span className="imp-wizard__foot-trail">
            {step === 'source' && (
              <>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button onClick={() => void handleReview()} disabled={!canReview || reviewing}>
                  {reviewing ? 'Reviewing…' : 'Continue to review'}
                  {!reviewing && <ArrowRight aria-hidden />}
                </Button>
              </>
            )}

            {step === 'review' && review && (
              <>
                <Button variant="outline" onClick={onClose} disabled={importing}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void handleImport()}
                  disabled={importing || selectedNames.size === 0}
                >
                  {importing ? 'Importing…' : `Import ${selectedNames.size} selected`}
                </Button>
              </>
            )}

            {step === 'result' && <Button onClick={() => onComplete()}>Done</Button>}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * How many detected types are listed by name before the panel summarizes the remainder. An OpenAPI
 * document can carry hundreds of component schemas, and the source step is not the review table.
 */
const DETECTED_TYPES_LIST_CAP = 12;

/**
 * The detected-types panel under the source input: every type found, by name, each marked valid or
 * invalid against draft 2020-12.
 *
 * The verdict is the local metaschema check (see `describeDetectedTypes`) — it says whether the
 * fragment is a well-formed schema, which is knowable here. Conflicts and scope are the review
 * step's answer, so nothing in this panel claims the import will succeed.
 */
function DetectedTypesPanel({
  types,
  sourceKind,
  refResolutions,
  refSummary,
}: {
  types: DetectedType[];
  sourceKind: SourceKind;
  refResolutions: RefResolution[];
  refSummary: { resolved: number; repaired: number; unresolved: number; external: number };
}) {
  const invalidCount = types.filter((type) => !type.valid).length;
  const warningCount = types.filter((type) => type.warning).length;
  const shown = types.slice(0, DETECTED_TYPES_LIST_CAP);
  const remaining = types.length - shown.length;

  return (
    <Card data-testid="detected-types" className="prm-detected">
      <div className="prm-detected__head">
        <span className="prm-detected__title">
          <ScanSearch aria-hidden />
          Detected {types.length} {sourceKindLabel(sourceKind)} type{types.length === 1 ? '' : 's'}
        </span>
        <span className="prm-detected__counts">
          {/* An advisory is not a verdict: a type can be valid *and* worth a second look, so the
              warning count sits beside the valid/invalid state rather than replacing it. */}
          {warningCount > 0 ? (
            <Badge variant="warn" data-testid="detected-warning-count">
              {warningCount} without a declared type
            </Badge>
          ) : null}
          {invalidCount > 0 ? (
            <Badge variant="danger" data-testid="detected-invalid-count">
              {invalidCount} invalid
            </Badge>
          ) : (
            <Badge variant="ok">All valid</Badge>
          )}
        </span>
      </div>
      <ul className="prm-detected__list">
        {shown.map((type) => (
          <li
            key={type.name}
            data-testid={`detected-type-${type.name}`}
            data-valid={String(type.valid)}
            className="prm-detected__row"
          >
            {type.valid ? (
              <CheckCircle className="prm-detected__mark prm-detected__mark--ok" aria-hidden />
            ) : (
              <XCircle className="prm-detected__mark prm-detected__mark--bad" aria-hidden />
            )}
            <span className="prm-detected__text">
              <span className="mono">{type.name}</span>
              <span className="sr-only">{type.valid ? ' — valid' : ' — invalid'}</span>
              {type.error ? <span className="prm-error">{type.error}</span> : null}
              {type.warning ? (
                <span className="prm-caution" data-testid={`detected-type-warning-${type.name}`}>
                  <AlertTriangle aria-hidden />
                  {type.warning}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {remaining > 0 ? (
        <p className="prm-detected__more" data-testid="detected-types-truncated">
          +{remaining} more not listed here — all {types.length} are imported and reviewed.
        </p>
      ) : null}
      <RefResolutionSection resolutions={refResolutions} summary={refSummary} />
    </Card>
  );
}

/** How many `$ref` rows of each kind are listed before the rest are summarized. */
const REF_LIST_CAP = 8;

/**
 * The `$ref` resolution report, under the detected types.
 *
 * Says where each reference landed: how many resolved (and how many of those had to be rewritten to
 * get there), and — as a warning — every reference that names a type nothing can satisfy.
 */
function RefResolutionSection({
  resolutions,
  summary,
}: {
  resolutions: RefResolution[];
  summary: { resolved: number; repaired: number; unresolved: number; external: number };
}) {
  // Nothing to say about a document with no cross-type references at all.
  if (summary.resolved === 0 && summary.unresolved === 0) return null;

  const resolved = resolutions.filter(
    (entry) => entry.status === 'resolved' || entry.status === 'repaired'
  );
  const unresolved = resolutions.filter((entry) => entry.status === 'unresolved');

  return (
    <div data-testid="ref-resolution" className="prm-refs">
      <div className="prm-refs__head">
        <span className="prm-refs__title" data-testid="ref-resolved-summary">
          Resolved {summary.resolved} $ref{summary.resolved === 1 ? '' : 's'}
        </span>
        {summary.repaired > 0 ? (
          <Badge variant="warn" data-testid="ref-repaired-summary">
            {summary.repaired} rewritten to resolve
          </Badge>
        ) : null}
      </div>

      {resolved.length > 0 ? (
        <ul className="prm-refs__list" data-testid="ref-resolved-list">
          {resolved.map((entry, index) =>
            index < REF_LIST_CAP ? (
              <li
                key={`${entry.typeName}-${entry.ref}`}
                data-testid={`ref-resolved-${entry.ref}`}
                data-status={entry.status}
                className="prm-refs__row"
              >
                <CheckCircle className="prm-detected__mark prm-detected__mark--ok" aria-hidden />
                <span className="mono">{entry.ref}</span>
                <span className="prm-quiet">→</span>
                <span className="mono prm-refs__target">{entry.target}</span>
                {entry.origin === 'import' ? (
                  <span className="prm-quiet">(in this import)</span>
                ) : null}
                {entry.rewrittenTo ? (
                  <span className="prm-caution">
                    rewritten to <span className="mono">{entry.rewrittenTo}</span>
                  </span>
                ) : null}
              </li>
            ) : null
          )}
          {resolved.length > REF_LIST_CAP ? (
            <li className="prm-quiet" data-testid="ref-resolved-truncated">
              +{resolved.length - REF_LIST_CAP} more resolved
            </li>
          ) : null}
        </ul>
      ) : null}

      {/* `Alert` renders the variant's own icon, so passing one as a child would show it twice. */}
      {unresolved.length > 0 ? (
        <Alert variant="warn" data-testid="ref-unresolved">
          <div className="prm-refs__unresolved">
            <AlertTitle>Unresolved $ref{unresolved.length === 1 ? '' : 's'}</AlertTitle>
            <p>
              {unresolved.length} $ref{unresolved.length === 1 ? '' : 's'} could not be resolved. The
              referenced schemas were looked up in the registry and in this document — they either do
              not exist, or their names did not resolve.
            </p>
            {/* Each row is just the ref and where it came from. The per-edge diagnosis said the same
                thing on every line, so what it means for the import is stated once, under the list. */}
            <ul>
              {unresolved.map((entry, index) =>
                index < REF_LIST_CAP ? (
                  <li key={`${entry.typeName}-${entry.ref}`} data-testid={`ref-unresolved-${entry.ref}`}>
                    <span className="mono">{entry.ref}</span> in{' '}
                    <span className="mono">{entry.typeName}</span>
                  </li>
                ) : null
              )}
              {unresolved.length > REF_LIST_CAP ? (
                <li data-testid="ref-unresolved-truncated">
                  +{unresolved.length - REF_LIST_CAP} more unresolved
                </li>
              ) : null}
            </ul>
            {/* The consequence first, then the remedy. */}
            <p data-testid="ref-unresolved-consequence">
              Importing these schemas will leave these references dangling until the schema is found
              or imported.
            </p>
            <p data-testid="ref-unresolved-recommendation">
              <strong>
                Recommendation: import these refs into the namespace before importing this schema.
              </strong>
            </p>
          </div>
        </Alert>
      ) : null}
    </div>
  );
}

interface SourceStepProps {
  sourceKind: SourceKind;
  onSourceKindChange: (kind: SourceKind) => void;
  sourceMethod: SourceMethod;
  onSourceMethodChange: (method: SourceMethod) => void;
  targetNamespace: string;
  onTargetNamespaceChange: (value: string) => void;
  onExtractNamespace: () => void;
  namespaceNotice: string | null;
  autoExtractNamespace: boolean;
  onAutoExtractNamespaceChange: (value: boolean) => void;
  mapCoreFormats: boolean;
  onMapCoreFormatsChange: (value: boolean) => void;
  dedupe: boolean;
  onDedupeChange: (value: boolean) => void;
  file: File | null;
  isDragging: boolean;
  isLoadingFile: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (file: File) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onClearFile: () => void;
  urlInput: string;
  onUrlInputChange: (value: string) => void;
  isLoadingUrl: boolean;
  onUrlFetch: () => void;
  schemaText: string;
  onSchemaTextChange: (value: string | undefined) => void;
  onParsePasted: () => boolean;
  parseError: string | null;
  reviewError: string | null;
  detectedTypes: DetectedType[];
  refResolutions: RefResolution[];
  refSummary: { resolved: number; repaired: number; unresolved: number; external: number };
  hasDocument: boolean;
}

/** Step 1: choose the source kind / method, set options, and provide the document. */
function SourceStep(props: SourceStepProps) {
  const {
    sourceKind,
    onSourceKindChange,
    targetNamespace,
    onTargetNamespaceChange,
    onExtractNamespace,
    namespaceNotice,
    autoExtractNamespace,
    onAutoExtractNamespaceChange,
    mapCoreFormats,
    onMapCoreFormatsChange,
    dedupe,
    onDedupeChange,
    parseError,
    reviewError,
    detectedTypes,
    refResolutions,
    refSummary,
    hasDocument,
  } = props;

  return (
    <>
      <section className="prm-form-section">
        <h3 className="prm-form-section__title">Source type</h3>
        <div className="prm-source-cards">
          {SOURCE_KIND_CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.kind}
                type="button"
                className="prm-source-card"
                aria-pressed={sourceKind === card.kind}
                onClick={() => onSourceKindChange(card.kind)}
              >
                <span className="prm-source-card__head">
                  <Icon aria-hidden />
                  {card.title}
                </span>
                <span className="prm-source-card__desc">{card.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <SourceMethodInput {...props} />

      {detectedTypes.length > 0 && (
        <DetectedTypesPanel
          types={detectedTypes}
          sourceKind={sourceKind}
          refResolutions={refResolutions}
          refSummary={refSummary}
        />
      )}

      {!hasDocument && parseError && (
        <Alert variant="danger">
          <span>{parseError}</span>
        </Alert>
      )}

      <section className="prm-form-section">
        <h3 className="prm-form-section__title">Options</h3>
        <div className="prm-field">
          <Label htmlFor="target-namespace">Target namespace (optional)</Label>
          <div className="prm-bound">
            <Input
              id="target-namespace"
              className="mono"
              placeholder="e.g. acme/v1/types"
              value={targetNamespace}
              onChange={(e) => onTargetNamespaceChange(e.target.value)}
            />
            {/* Documents exported from a registry already state their namespace in each `$id`;
                this reads it back so the reader does not retype it. Disabled until a document is
                loaded, since there is nothing to read from before then. */}
            <Button
              type="button"
              variant="outline"
              data-testid="extract-target-namespace"
              onClick={onExtractNamespace}
              disabled={!hasDocument}
              title={
                hasDocument
                  ? 'Read the namespace from the $id declared in this document'
                  : 'Load a document first'
              }
            >
              <Wand2 aria-hidden />
              Extract from target
            </Button>
          </div>
          {namespaceNotice ? (
            <p className="prm-hint" data-testid="target-namespace-notice">
              {namespaceNotice}
            </p>
          ) : null}
        </div>

        <div className="prm-checks">
          <span className="prm-check">
            <Checkbox
              id="auto-extract-target-namespace"
              data-testid="auto-extract-target-namespace"
              checked={autoExtractNamespace}
              onCheckedChange={(checked) => onAutoExtractNamespaceChange(checked === true)}
            />
            <Label htmlFor="auto-extract-target-namespace">
              Always extract namespace automatically
            </Label>
          </span>
          <span className="prm-check">
            <Checkbox
              id="map-core-formats"
              checked={mapCoreFormats}
              onCheckedChange={(checked) => onMapCoreFormatsChange(checked === true)}
            />
            <Label htmlFor="map-core-formats">
              Map recognized formats to core JSON System types ($ref rewrite if absent)
            </Label>
          </span>
          <span className="prm-check">
            <Checkbox
              id="dedupe-identical"
              checked={dedupe}
              onCheckedChange={(checked) => onDedupeChange(checked === true)}
            />
            <Label htmlFor="dedupe-identical">Skip definitions identical to an existing type</Label>
          </span>
        </div>
      </section>

      {reviewError && (
        <Alert variant="danger">
          <span>{reviewError}</span>
        </Alert>
      )}
    </>
  );
}

/** The file / URL / paste intake tabs for the source step. */
function SourceMethodInput(props: SourceStepProps) {
  const {
    sourceMethod,
    onSourceMethodChange,
    file,
    isDragging,
    isLoadingFile,
    fileInputRef,
    onFileSelect,
    onDragOver,
    onDragLeave,
    onDrop,
    onClearFile,
    urlInput,
    onUrlInputChange,
    isLoadingUrl,
    onUrlFetch,
    schemaText,
    onSchemaTextChange,
    onParsePasted,
    hasDocument,
    parseError,
  } = props;
  const monacoTheme = useHiveMonacoTheme();

  return (
    <Tabs value={sourceMethod} onValueChange={(v) => onSourceMethodChange(v as SourceMethod)}>
      <TabsList className="mb-4">
        <TabsTrigger value="file">
          <Upload aria-hidden />
          File
        </TabsTrigger>
        <TabsTrigger value="url">
          <FileCode aria-hidden />
          URL
        </TabsTrigger>
        <TabsTrigger value="paste">
          <FileText aria-hidden />
          Paste
        </TabsTrigger>
      </TabsList>

      <TabsContent value="file" className="mt-0">
        {!file ? (
          // A `<label>` over a visually-hidden `<input type="file">`, not a `<button>` wrapping
          // one: a button with a focusable descendant is `nested-interactive`, a *serious* axe
          // violation, and the definition of done asks for none. This way the file input is the
          // control — one tab stop, its own accessible name, the browser's own picker — and the
          // zone shows the focus ring with `:focus-within`.
          <div
            className="prm-drop"
            data-dragging={isDragging || undefined}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <label className="prm-drop__label" htmlFor="primitive-import-file">
              <Upload className="prm-drop__glyph" aria-hidden />
              <span className="prm-drop__title">Drag &amp; drop or click to select</span>
              <span className="prm-drop__hint">Schema or bundle file (.json, .yaml, .yml)</span>
            </label>
            <input
              id="primitive-import-file"
              ref={fileInputRef}
              type="file"
              accept=".json,.yaml,.yml"
              aria-label="Schema or bundle file"
              className="sr-only"
              onChange={(e) => {
                const selectedFile = e.target.files?.[0];
                if (selectedFile) {
                  onFileSelect(selectedFile);
                }
              }}
            />
          </div>
        ) : (
          <Card className="prm-file">
            <span className="prm-file__identity">
              <FileJson className="prm-file__glyph" aria-hidden />
              <span className="prm-file__text">
                <span className="prm-file__name">{file.name}</span>
                <span className="prm-quiet">{(file.size / 1024).toFixed(1)} KB</span>
              </span>
            </span>
            {isLoadingFile ? <span className="prm-quiet">Processing file…</span> : null}
            <Button variant="ghost" size="sm" onClick={onClearFile} aria-label="Clear file">
              <X aria-hidden />
            </Button>
          </Card>
        )}
      </TabsContent>

      <TabsContent value="url" className="mt-0">
        <div className="prm-field">
          <Label htmlFor="schema-url">Fetch from URL</Label>
          <div className="prm-bound">
            <Input
              id="schema-url"
              type="url"
              placeholder="https://example.com/schema.json"
              value={urlInput}
              onChange={(e) => onUrlInputChange(e.target.value)}
              disabled={isLoadingUrl}
            />
            <Button onClick={onUrlFetch} disabled={!urlInput.trim() || isLoadingUrl}>
              {isLoadingUrl ? 'Fetching…' : 'Fetch'}
            </Button>
          </div>
          {hasDocument && <p className="prm-hint">Document fetched.</p>}
        </div>
      </TabsContent>

      <TabsContent value="paste" className="mt-0">
        <div className="prm-field">
          <Label htmlFor="paste-schema">Paste JSON or YAML</Label>
          <div className="prm-editor" id="paste-schema">
            <MonacoEditor
              height="20rem"
              language="json"
              theme={monacoTheme.theme}
              beforeMount={monacoTheme.beforeMount}
              value={schemaText}
              onChange={onSchemaTextChange}
              options={{
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: CODE_EDITOR_FONT_SIZE,
              }}
            />
          </div>
          <div className="prm-editor__bar">
            {hasDocument ? <p className="prm-hint">Document parsed.</p> : <span />}
            <Button variant="outline" size="sm" onClick={onParsePasted} disabled={!schemaText.trim()}>
              Parse
            </Button>
          </div>
          {!hasDocument && parseError && (
            <Alert variant="danger">
              <span>{parseError}</span>
            </Alert>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}

interface ReviewStepProps {
  review: ReviewResponse;
  previewDefinitions: Record<string, Record<string, unknown>>;
  selectedNames: Set<string>;
  resolutions: ResolutionMap;
  onToggleSelected: (name: string) => void;
  onResolutionAction: (name: string, action: ResolutionAction) => void;
  onResolutionNewName: (name: string, newName: string) => void;
  reviewError: string | null;
}

/** Step 2: render the classification report and let the user resolve conflicts. */
function ReviewStep(props: ReviewStepProps) {
  const {
    review,
    previewDefinitions,
    selectedNames,
    resolutions,
    onToggleSelected,
    onResolutionAction,
    onResolutionNewName,
    reviewError,
  } = props;

  const { summary } = review;
  // Prefer the server's count; derive it when the response predates the field, so the badge can
  // never disagree with the cautions rendered on the rows below.
  const cautioned = summary.warnings ?? countCautionedTypes(review.types);

  return (
    <>
      <p className="prm-review__summary">
        <Badge variant="ok">{summary.new} new</Badge>
        <Badge variant="danger">{summary.conflict} conflict</Badge>
        {/* Always shown, zero included: a count that only appears when it is non-zero leaves a
            reader unsure whether the review checks for this at all. The icon marks which badge is
            the warnings one; the colour is what carries urgency, so at zero it drops to neutral
            rather than crying wolf in amber. */}
        <Badge variant={cautioned > 0 ? 'warn' : 'neutral'} data-testid="review-warning-count">
          <AlertTriangle aria-hidden />
          {cautioned} warning{cautioned === 1 ? '' : 's'}
        </Badge>
        <Badge variant="outline">{summary.identical} identical</Badge>
        {summary.invalid > 0 && <Badge variant="danger">{summary.invalid} invalid</Badge>}
        <span className="prm-quiet">· {summary.total} total</span>
      </p>

      {review.warnings.length > 0 && (
        <Alert variant="warn">
          <span>{review.warnings.join('; ')}</span>
        </Alert>
      )}

      <div className="prm-review__list">
        {review.types.map((type) => (
          <ReviewTypeRow
            key={type.name}
            type={type}
            schema={previewDefinitions[type.name]}
            selected={selectedNames.has(type.name)}
            resolution={resolutions[type.name]}
            onToggleSelected={onToggleSelected}
            onResolutionAction={onResolutionAction}
            onResolutionNewName={onResolutionNewName}
          />
        ))}
      </div>

      {reviewError && (
        <Alert variant="danger">
          <span>{reviewError}</span>
        </Alert>
      )}
    </>
  );
}

interface ReviewTypeRowProps {
  type: ReviewType;
  schema?: Record<string, unknown>;
  selected: boolean;
  resolution?: { action: ResolutionAction; new_name?: string };
  onToggleSelected: (name: string) => void;
  onResolutionAction: (name: string, action: ResolutionAction) => void;
  onResolutionNewName: (name: string, newName: string) => void;
}

/** One reviewed type: classification, validation, and (for conflicts) resolution controls. */
function ReviewTypeRow(props: ReviewTypeRowProps) {
  const {
    type,
    schema,
    selected,
    resolution,
    onToggleSelected,
    onResolutionAction,
    onResolutionNewName,
  } = props;
  const badge = STATUS_BADGE[type.status];
  const isInvalid = type.status === 'invalid';
  const category = schema ? determineCategoryFromSchema(schema) : null;
  const checkboxId = `review-select-${type.name}`;

  return (
    <Card className="prm-review-row" data-status={type.status}>
      <div className="prm-review-row__head">
        <Checkbox
          id={checkboxId}
          checked={selected}
          disabled={isInvalid}
          onCheckedChange={() => onToggleSelected(type.name)}
          aria-label={`Import ${type.name}`}
        />
        <FileCode className="prm-type-glyph" aria-hidden />
        <Label htmlFor={checkboxId} className="mono prm-review-row__name">
          {type.name}
        </Label>
        {category && <span className="prm-quiet">({category})</span>}
        <Badge variant={badge.variant}>{badge.label}</Badge>
        {type.unresolved_refs.length > 0 && (
          <Badge variant="warn">
            {type.unresolved_refs.length} unresolved $ref
            {type.unresolved_refs.length === 1 ? '' : 's'}
          </Badge>
        )}
      </div>

      {isInvalid && (
        <div className="prm-review-row__error">
          <p className="prm-error">
            {type.error?.error === 'scope_violation'
              ? 'Scope violation — cannot be imported into this scope.'
              : 'Not a valid draft 2020-12 schema — cannot be imported.'}
          </p>
          {type.validation_errors.length > 0 && (
            <ul className="prm-review-row__errors">
              {type.validation_errors.slice(0, 5).map((err, index) => (
                <li key={index} className="prm-error">
                  {(err.field ? `${err.field}: ` : '') + (err.message || JSON.stringify(err))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Advisories, not errors: the type imports either way, so this reads as a caution
          beside the row rather than blocking its checkbox. */}
      {(type.warnings ?? []).map((warning) => (
        <p
          key={warning}
          data-testid={`review-type-warning-${type.name}`}
          className="prm-caution"
        >
          <AlertTriangle aria-hidden />
          {warning}
        </p>
      ))}

      {type.status === 'conflict' && (
        <div className="prm-review-row__resolve">
          <span className="prm-quiet">A different type already exists. Resolve:</span>
          <select
            value={resolution?.action ?? 'keep'}
            onChange={(e) => onResolutionAction(type.name, e.target.value as ResolutionAction)}
            aria-label={`Conflict resolution for ${type.name}`}
            className="hive-control prm-select prm-select--inline"
          >
            <option value="keep">Keep existing</option>
            <option value="overwrite">Overwrite</option>
            <option value="rename">Import as new name</option>
          </select>
          {resolution?.action === 'rename' && (
            <Input
              className="mono prm-review-row__rename"
              placeholder="new_name"
              aria-label={`New name for ${type.name}`}
              value={resolution.new_name ?? ''}
              onChange={(e) => onResolutionNewName(type.name, e.target.value)}
            />
          )}
        </div>
      )}

      {schema && <pre className="prm-code prm-code--clip">{JSON.stringify(schema, null, 2)}</pre>}
    </Card>
  );
}

/** Step 3: the committed outcome, bucketed by what the import did. */
function ResultStep({ result }: { result: ImportResultSummary }) {
  const buckets: Array<{ label: string; items: string[]; variant: BadgeTone }> = [
    { label: 'Imported', items: result.imported, variant: 'ok' },
    { label: 'Overwritten', items: result.overwritten, variant: 'warn' },
    {
      label: 'Renamed',
      items: result.renamed.map((r) => (typeof r === 'string' ? r : `${r.name} → ${r.new_name ?? ''}`)),
      variant: 'accent',
    },
    { label: 'Identical (skipped)', items: result.identical, variant: 'outline' },
    {
      label: 'Skipped',
      items: result.skipped.map((s) => (typeof s === 'string' ? s : `${s.name}${s.reason ? ` — ${s.reason}` : ''}`)),
      variant: 'neutral',
    },
    {
      label: 'Errors',
      items: result.errors.map((e) => (typeof e === 'string' ? e : `${e.name}${e.error ? ` — ${e.error}` : ''}`)),
      variant: 'danger',
    },
  ];

  const hasErrors = result.errors.length > 0;

  return (
    <>
      <Alert variant={hasErrors ? 'warn' : 'ok'}>
        <span>{describeImportResult(result)}</span>
      </Alert>

      {result.warnings.length > 0 && (
        <Alert variant="warn">
          <span>{result.warnings.join('; ')}</span>
        </Alert>
      )}

      <div className="prm-result">
        {buckets
          .filter((bucket) => bucket.items.length > 0)
          .map((bucket) => (
            <p key={bucket.label} className="prm-result__row">
              <Badge variant={bucket.variant}>
                {bucket.label} {bucket.items.length}
              </Badge>
              <span className="mono prm-result__items">{bucket.items.join(' · ')}</span>
            </p>
          ))}
      </div>

      {result.importId && (
        <p className="prm-hint">
          Import record: <span className="mono">{result.importId}</span>
        </p>
      )}
    </>
  );
}
