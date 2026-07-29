'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload,
  AlertCircle,
  CheckCircle,
  FileCode,
  FileJson,
  X,
  Boxes,
  FileText,
  ArrowRight,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/app/components/ui/Button';
import { Label } from '@/app/components/ui/Label';
import { Input } from '@/app/components/ui/Input';
import { Alert, AlertTitle } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/Dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/app/components/ui/Tabs';
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

/** Badge variant + label for a review classification. */
const STATUS_BADGE: Record<ReviewStatus, { variant: 'success' | 'secondary' | 'warning' | 'error'; label: string }> = {
  new: { variant: 'success', label: 'New' },
  identical: { variant: 'secondary', label: 'Identical' },
  conflict: { variant: 'warning', label: 'Conflict' },
  invalid: { variant: 'error', label: 'Invalid' },
};

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
      <DialogContent className="max-w-5xl h-[78vh] min-h-[78vh] flex flex-col overflow-hidden" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            Import Primitives
          </DialogTitle>
        </DialogHeader>

        <WizardSteps step={step} />

        <div className="space-y-4 py-4 flex-1 min-h-0 overflow-y-auto">
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

        <DialogFooter>
          {step === 'source' && (
            <>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleReview} disabled={!canReview || reviewing}>
                {reviewing ? 'Reviewing…' : 'Continue to Review'}
                {!reviewing && <ArrowRight className="w-4 h-4 ml-2" />}
              </Button>
            </>
          )}

          {step === 'review' && review && (
            <>
              <Button variant="secondary" onClick={() => setStep('source')} disabled={importing}>
                Back
              </Button>
              <Button variant="secondary" onClick={onClose} disabled={importing}>
                Cancel
              </Button>
              <Button onClick={handleImport} disabled={importing || selectedNames.size === 0}>
                {importing ? 'Importing…' : `Import ${selectedNames.size} Selected`}
              </Button>
            </>
          )}

          {step === 'result' && (
            <Button
              onClick={() => {
                onComplete();
              }}
            >
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Step indicator across the top of the wizard. */
function WizardSteps({ step }: { step: WizardStep }) {
  const steps: Array<{ key: WizardStep; label: string }> = [
    { key: 'source', label: '1 · Source' },
    { key: 'review', label: '2 · Review' },
    { key: 'result', label: '3 · Result' },
  ];
  const activeIndex = steps.findIndex((s) => s.key === step);

  return (
    <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700 pb-3">
      {steps.map((s, index) => {
        const isActive = index === activeIndex;
        const isDone = index < activeIndex;
        return (
          <div
            key={s.key}
            className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm font-medium ${
              isActive
                ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                : isDone
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-gray-400 dark:text-gray-500'
            }`}
          >
            {isDone ? <CheckCircle className="w-4 h-4" /> : null}
            {s.label}
          </div>
        );
      })}
    </div>
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
  const shown = types.slice(0, DETECTED_TYPES_LIST_CAP);
  const remaining = types.length - shown.length;

  return (
    <div
      data-testid="detected-types"
      className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
          Detected {types.length} {sourceKindLabel(sourceKind)} type{types.length === 1 ? '' : 's'}
        </span>
        {invalidCount > 0 ? (
          <span className="text-xs font-medium text-red-600 dark:text-red-400" data-testid="detected-invalid-count">
            {invalidCount} invalid
          </span>
        ) : (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">All valid</span>
        )}
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700/60">
        {shown.map((type) => (
          <li
            key={type.name}
            data-testid={`detected-type-${type.name}`}
            data-valid={String(type.valid)}
            className="flex items-start gap-2 px-3 py-2"
          >
            {type.valid ? (
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
            )}
            <div className="min-w-0">
              <span className="font-mono text-sm text-gray-900 dark:text-gray-100 break-all">{type.name}</span>
              <span className="sr-only">{type.valid ? ' — valid' : ' — invalid'}</span>
              {type.error ? (
                <p className="text-xs text-red-600 dark:text-red-400 break-words">{type.error}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {remaining > 0 ? (
        <p
          className="border-t border-gray-100 dark:border-gray-700/60 px-3 py-2 text-xs text-gray-500 dark:text-gray-400"
          data-testid="detected-types-truncated"
        >
          +{remaining} more not listed here — all {types.length} are imported and reviewed.
        </p>
      ) : null}
      <RefResolutionSection resolutions={refResolutions} summary={refSummary} />
    </div>
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

  const resolved = resolutions.filter((entry) => entry.status === 'resolved' || entry.status === 'repaired');
  const unresolved = resolutions.filter((entry) => entry.status === 'unresolved');

  return (
    <div
      data-testid="ref-resolution"
      className="border-t border-gray-200 dark:border-gray-700 px-3 py-2 space-y-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300" data-testid="ref-resolved-summary">
          Resolved {summary.resolved} $ref{summary.resolved === 1 ? '' : 's'}
        </span>
        {summary.repaired > 0 ? (
          <span
            className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
            data-testid="ref-repaired-summary"
          >
            {summary.repaired} rewritten to resolve
          </span>
        ) : null}
      </div>

      {resolved.length > 0 ? (
        <ul className="space-y-1" data-testid="ref-resolved-list">
          {resolved.slice(0, REF_LIST_CAP).map((entry) => (
            <li
              key={`${entry.typeName}-${entry.ref}`}
              data-testid={`ref-resolved-${entry.ref}`}
              data-status={entry.status}
              className="flex flex-wrap items-baseline gap-x-1.5 text-[11px]"
            >
              <CheckCircle className="h-3 w-3 shrink-0 translate-y-0.5 text-emerald-500" aria-hidden />
              <span className="font-mono text-gray-700 dark:text-gray-300 break-all">{entry.ref}</span>
              <span className="text-gray-400">→</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-300 break-all">{entry.target}</span>
              {entry.origin === 'import' ? (
                <span className="text-gray-500 dark:text-gray-400">(in this import)</span>
              ) : null}
              {entry.rewrittenTo ? (
                <span className="text-amber-700 dark:text-amber-300 break-all">
                  rewritten to <span className="font-mono">{entry.rewrittenTo}</span>
                </span>
              ) : null}
            </li>
          ))}
          {resolved.length > REF_LIST_CAP ? (
            <li className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="ref-resolved-truncated">
              +{resolved.length - REF_LIST_CAP} more resolved
            </li>
          ) : null}
        </ul>
      ) : null}

      {/* `Alert` renders the variant's own icon, so passing one as a child would show it twice. */}
      {unresolved.length > 0 ? (
        <Alert variant="warning" data-testid="ref-unresolved">
          <div className="space-y-1">
            <AlertTitle className="text-sm">
              Unresolved $ref{unresolved.length === 1 ? '' : 's'}
            </AlertTitle>
            <p className="text-xs">
              {unresolved.length} $ref{unresolved.length === 1 ? '' : 's'} could not be resolved. The
              referenced schemas were looked up in the registry and in this document — they either do not
              exist, or their names did not resolve. Importing will leave these references dangling.
            </p>
            <ul className="space-y-0.5">
              {unresolved.slice(0, REF_LIST_CAP).map((entry) => (
                <li
                  key={`${entry.typeName}-${entry.ref}`}
                  data-testid={`ref-unresolved-${entry.ref}`}
                  className="text-[11px]"
                >
                  <span className="font-mono break-all">{entry.ref}</span>
                  <span className="text-gray-500 dark:text-gray-400"> in </span>
                  <span className="font-mono">{entry.typeName}</span>
                  {entry.reason ? <span className="block text-gray-600 dark:text-gray-400">{entry.reason}</span> : null}
                </li>
              ))}
              {unresolved.length > REF_LIST_CAP ? (
                <li className="text-[11px]" data-testid="ref-unresolved-truncated">
                  +{unresolved.length - REF_LIST_CAP} more unresolved
                </li>
              ) : null}
            </ul>
            <p className="text-xs font-medium" data-testid="ref-unresolved-recommendation">
              Recommendation: import these refs into the namespace before importing this schema.
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
    <div className="space-y-6">
      <div className="space-y-3">
        <Label className="text-base">Source type</Label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {SOURCE_KIND_CARDS.map((card) => {
            const Icon = card.icon;
            const isActive = sourceKind === card.kind;
            return (
              <button
                key={card.kind}
                type="button"
                onClick={() => onSourceKindChange(card.kind)}
                className={`text-left rounded-lg border p-4 transition-colors ${
                  isActive
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20 ring-1 ring-indigo-500'
                    : 'border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-600'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Icon className={`w-5 h-5 ${isActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400'}`} />
                  <span className="font-medium text-gray-900 dark:text-white">{card.title}</span>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{card.description}</p>
              </button>
            );
          })}
        </div>
      </div>

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
        <Alert variant="error">
          <AlertCircle className="h-4 w-4" />
          <span>{parseError}</span>
        </Alert>
      )}

      <div className="space-y-3 border-t border-gray-200 dark:border-gray-700 pt-4">
        <Label className="text-base">Options</Label>
        <div className="space-y-2">
          <Label htmlFor="target-namespace">Target namespace (optional)</Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id="target-namespace"
              placeholder="e.g. acme/v1/types"
              value={targetNamespace}
              onChange={(e) => onTargetNamespaceChange(e.target.value)}
            />
            {/* Documents exported from a registry already state their namespace in each `$id`;
                this reads it back so the reader does not retype it. Disabled until a document is
                loaded, since there is nothing to read from before then. */}
            <Button
              type="button"
              variant="secondary"
              data-testid="extract-target-namespace"
              onClick={onExtractNamespace}
              disabled={!hasDocument}
              title={
                hasDocument
                  ? 'Read the namespace from the $id declared in this document'
                  : 'Load a document first'
              }
              className="shrink-0 gap-1.5"
            >
              <Wand2 className="h-4 w-4" aria-hidden />
              Extract from Target
            </Button>
          </div>
          {namespaceNotice ? (
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="target-namespace-notice">
              {namespaceNotice}
            </p>
          ) : null}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              data-testid="auto-extract-target-namespace"
              checked={autoExtractNamespace}
              onChange={(e) => onAutoExtractNamespaceChange(e.target.checked)}
              className="w-4 h-4 text-indigo-600 rounded"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Always extract namespace automatically
            </span>
          </label>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={mapCoreFormats}
            onChange={(e) => onMapCoreFormatsChange(e.target.checked)}
            className="w-4 h-4 text-indigo-600 rounded"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            Map recognized formats to core types ($ref rewrite)
          </span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={dedupe}
            onChange={(e) => onDedupeChange(e.target.checked)}
            className="w-4 h-4 text-indigo-600 rounded"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">Skip definitions identical to an existing type</span>
        </label>
      </div>

      {reviewError && (
        <Alert variant="error">
          <AlertCircle className="h-4 w-4" />
          <span>{reviewError}</span>
        </Alert>
      )}
    </div>
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

  const tabClass =
    'flex items-center gap-2 rounded-none border-b-2 border-transparent bg-transparent px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-600 dark:data-[state=active]:text-indigo-400 data-[state=active]:bg-transparent data-[state=active]:shadow-none -mb-px';

  return (
    <Tabs value={sourceMethod} onValueChange={(v) => onSourceMethodChange(v as SourceMethod)}>
      <TabsList className="w-full h-auto p-0 rounded-none bg-transparent border-b border-gray-200 dark:border-gray-700 justify-start gap-0 mb-4">
        <TabsTrigger value="file" className={tabClass}>
          <Upload className="w-4 h-4" />
          File
        </TabsTrigger>
        <TabsTrigger value="url" className={tabClass}>
          <FileCode className="w-4 h-4" />
          URL
        </TabsTrigger>
        <TabsTrigger value="paste" className={tabClass}>
          <FileText className="w-4 h-4" />
          Paste
        </TabsTrigger>
      </TabsList>

      <TabsContent value="file" className="mt-0">
        {!file ? (
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors duration-200 ${
              isDragging
                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20'
                : 'border-gray-300 dark:border-gray-600 hover:border-indigo-400 dark:hover:border-indigo-500'
            }`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-12 h-12 mx-auto mb-4 text-gray-400 dark:text-gray-500" />
            <p className="text-lg font-medium text-gray-900 dark:text-white mb-2">Drag &amp; Drop or Click to Select</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">Schema or bundle file (.json, .yaml, .yml)</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.yaml,.yml"
              className="hidden"
              onChange={(e) => {
                const selectedFile = e.target.files?.[0];
                if (selectedFile) {
                  onFileSelect(selectedFile);
                }
              }}
            />
          </div>
        ) : (
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <FileJson className="w-8 h-8 text-green-500" />
                <div>
                  <p className="font-medium text-gray-900 dark:text-white">{file.name}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{(file.size / 1024).toFixed(1)} KB</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={onClearFile}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            {isLoadingFile && <p className="mt-2 text-sm text-indigo-600 dark:text-indigo-400">Processing file…</p>}
          </div>
        )}
      </TabsContent>

      <TabsContent value="url" className="mt-0">
        <div className="space-y-2">
          <Label htmlFor="schema-url">Fetch from URL</Label>
          <div className="flex gap-2">
            <Input
              id="schema-url"
              type="url"
              placeholder="https://example.com/schema.json"
              value={urlInput}
              onChange={(e) => onUrlInputChange(e.target.value)}
              className="flex-1"
              disabled={isLoadingUrl}
            />
            <Button onClick={onUrlFetch} disabled={!urlInput.trim() || isLoadingUrl}>
              {isLoadingUrl ? 'Fetching…' : 'Fetch'}
            </Button>
          </div>
          {hasDocument && <p className="text-sm text-emerald-600 dark:text-emerald-400">Document fetched.</p>}
        </div>
      </TabsContent>

      <TabsContent value="paste" className="mt-0">
        <div className="space-y-2">
          <Label>Paste JSON or YAML</Label>
          <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
            <MonacoEditor
              height="320px"
              language="json"
              theme="vs-dark"
              value={schemaText}
              onChange={onSchemaTextChange}
              options={{ minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13 }}
            />
          </div>
          <div className="flex items-center justify-between">
            {hasDocument ? (
              <p className="text-sm text-emerald-600 dark:text-emerald-400">Document parsed.</p>
            ) : (
              <span />
            )}
            <Button variant="secondary" size="sm" onClick={onParsePasted} disabled={!schemaText.trim()}>
              Parse
            </Button>
          </div>
          {!hasDocument && parseError && (
            <Alert variant="error">
              <AlertCircle className="h-4 w-4" />
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">{summary.new} new</Badge>
        <Badge variant="warning">{summary.conflict} conflict</Badge>
        <Badge variant="secondary">{summary.identical} identical</Badge>
        {summary.invalid > 0 && <Badge variant="error">{summary.invalid} invalid</Badge>}
        <span className="text-sm text-gray-500 dark:text-gray-400">· {summary.total} total</span>
      </div>

      {review.warnings.length > 0 && (
        <Alert variant="warning">
          <AlertCircle className="h-4 w-4" />
          <span>{review.warnings.join('; ')}</span>
        </Alert>
      )}

      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <div className="max-h-[40vh] overflow-y-auto divide-y divide-gray-200 dark:divide-gray-700">
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
      </div>

      {reviewError && (
        <Alert variant="error">
          <AlertCircle className="h-4 w-4" />
          <span>{reviewError}</span>
        </Alert>
      )}
    </div>
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
  const { type, schema, selected, resolution, onToggleSelected, onResolutionAction, onResolutionNewName } = props;
  const badge = STATUS_BADGE[type.status];
  const isInvalid = type.status === 'invalid';
  const category = schema ? determineCategoryFromSchema(schema) : null;

  return (
    <div className="p-4 hover:bg-gray-50 dark:hover:bg-gray-900/50">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          disabled={isInvalid}
          onChange={() => onToggleSelected(type.name)}
          className="mt-1 w-4 h-4 text-indigo-600 rounded disabled:opacity-40"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <FileCode className="w-4 h-4 text-indigo-600" />
            <span className="font-medium text-gray-900 dark:text-white">{type.name}</span>
            {category && <span className="text-xs text-gray-500 dark:text-gray-400">({category})</span>}
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {type.unresolved_refs.length > 0 && (
              <Badge variant="warning">
                {type.unresolved_refs.length} unresolved $ref{type.unresolved_refs.length === 1 ? '' : 's'}
              </Badge>
            )}
          </div>

          {isInvalid && (
            <div className="text-sm text-red-600 dark:text-red-400 mb-2">
              {type.error?.error === 'scope_violation'
                ? 'Scope violation — cannot be imported into this scope.'
                : 'Not a valid draft 2020-12 schema — cannot be imported.'}
              {type.validation_errors.length > 0 && (
                <ul className="list-disc list-inside mt-1">
                  {type.validation_errors.slice(0, 5).map((err, index) => (
                    <li key={index}>
                      {(err.field ? `${err.field}: ` : '') + (err.message || JSON.stringify(err))}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {type.status === 'conflict' && (
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <span className="text-sm text-gray-600 dark:text-gray-400">A different type already exists. Resolve:</span>
              <select
                value={resolution?.action ?? 'keep'}
                onChange={(e) => onResolutionAction(type.name, e.target.value as ResolutionAction)}
                className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              >
                <option value="keep">Keep existing</option>
                <option value="overwrite">Overwrite</option>
                <option value="rename">Import as new name</option>
              </select>
              {resolution?.action === 'rename' && (
                <Input
                  placeholder="new_name"
                  value={resolution.new_name ?? ''}
                  onChange={(e) => onResolutionNewName(type.name, e.target.value)}
                  className="w-48"
                />
              )}
            </div>
          )}

          {schema && (
            <pre className="mt-2 text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto">
              {JSON.stringify(schema, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** Step 3: the committed outcome, bucketed by what the import did. */
function ResultStep({ result }: { result: ImportResultSummary }) {
  const buckets: Array<{ label: string; items: string[]; variant: 'success' | 'warning' | 'secondary' | 'error' }> = [
    { label: 'Imported', items: result.imported, variant: 'success' },
    {
      label: 'Overwritten',
      items: result.overwritten,
      variant: 'warning',
    },
    {
      label: 'Renamed',
      items: result.renamed.map((r) => (typeof r === 'string' ? r : `${r.name} → ${r.new_name ?? ''}`)),
      variant: 'warning',
    },
    { label: 'Identical (skipped)', items: result.identical, variant: 'secondary' },
    {
      label: 'Skipped',
      items: result.skipped.map((s) => (typeof s === 'string' ? s : `${s.name}${s.reason ? ` — ${s.reason}` : ''}`)),
      variant: 'secondary',
    },
    {
      label: 'Errors',
      items: result.errors.map((e) => (typeof e === 'string' ? e : `${e.name}${e.error ? ` — ${e.error}` : ''}`)),
      variant: 'error',
    },
  ];

  const hasErrors = result.errors.length > 0;

  return (
    <div className="space-y-4">
      <Alert variant={hasErrors ? 'warning' : 'default'}>
        {hasErrors ? <AlertCircle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
        <span>{describeImportResult(result)}</span>
      </Alert>

      {result.warnings.length > 0 && (
        <Alert variant="warning">
          <AlertCircle className="h-4 w-4" />
          <span>{result.warnings.join('; ')}</span>
        </Alert>
      )}

      <div className="space-y-3">
        {buckets
          .filter((bucket) => bucket.items.length > 0)
          .map((bucket) => (
            <div key={bucket.label} className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant={bucket.variant}>{bucket.items.length}</Badge>
                <span className="text-sm font-medium text-gray-900 dark:text-white">{bucket.label}</span>
              </div>
              <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                {bucket.items.map((item, index) => (
                  <li key={index} className="font-mono text-xs">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>

      {result.importId && (
        <p className="text-xs text-gray-400 dark:text-gray-500">Import record: {result.importId}</p>
      )}
    </div>
  );
}
