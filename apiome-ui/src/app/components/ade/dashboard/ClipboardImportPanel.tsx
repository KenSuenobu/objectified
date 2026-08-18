'use client';

import { useState, useEffect, useCallback } from 'react';
import { FileText, CheckCircle2, AlertTriangle, FileCode, Copy, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { extractFileMetadata, FileMetadataPreview } from '../../../utils/openapi-analyzer';
import dynamic from 'next/dynamic';
import { TAB_LIST_CLASS, tabTriggerClass } from '../../ui/tabStyles';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';
import { SpecMetaTiles } from '../import/SpecMetaTiles';

// Dynamic import for Monaco Editor to avoid SSR issues
const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="h-[300px] flex items-center justify-center bg-inset rounded-lg">
      <div className="text-fg-faint">Loading editor...</div>
    </div>
  ),
});

interface ClipboardImportPanelProps {
  onSpecificationReady: (content: string, filename: string) => void;
}

type SyntaxType = 'json' | 'yaml' | 'unknown';

// Detect syntax type from content
function detectSyntax(text: string): SyntaxType {
  const trimmed = text.trim();

  if (!trimmed) return 'unknown';

  // JSON starts with { or [
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }

  // YAML detection - look for common patterns
  if (
    trimmed.includes(':') &&
    (trimmed.startsWith('openapi') ||
     trimmed.startsWith('swagger') ||
     trimmed.startsWith('asyncapi') ||
     trimmed.startsWith('info') ||
     trimmed.startsWith('paths') ||
     trimmed.startsWith('components') ||
     trimmed.startsWith('definitions') ||
     /^[a-zA-Z_][a-zA-Z0-9_]*:/m.test(trimmed))
  ) {
    return 'yaml';
  }

  return 'unknown';
}

export const ClipboardImportPanel: React.FC<ClipboardImportPanelProps> = ({
  onSpecificationReady
}) => {
  // Form state
  const [content, setContent] = useState('');
  const [detectedSyntax, setDetectedSyntax] = useState<SyntaxType>('unknown');
  const [fileMetadata, setFileMetadata] = useState<FileMetadataPreview | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [editorMounted, setEditorMounted] = useState(false);

  // Detect syntax and extract metadata when content changes
  const analyzeContent = useCallback(async (text: string) => {
    if (!text.trim()) {
      setDetectedSyntax('unknown');
      setFileMetadata(null);
      setParseError(null);
      // Clear parent state when content is empty
      onSpecificationReady('', '');
      return;
    }

    setIsAnalyzing(true);
    setParseError(null);

    try {
      // Detect syntax type
      const syntax = detectSyntax(text);
      setDetectedSyntax(syntax);

      // Extract metadata for preview
      const metadata = extractFileMetadata(text);
      setFileMetadata(metadata);

      if (!metadata.syntaxValid) {
        setParseError(metadata.parseError || 'Unable to parse content');
        // Clear parent state on parse error
        onSpecificationReady('', '');
      } else {
        // Notify parent that content is ready
        const extension = syntax === 'json' ? 'json' : 'yaml';
        const filename = `pasted-spec.${extension}`;
        onSpecificationReady(text, filename);
      }
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'Failed to analyze content');
      // Clear parent state on error
      onSpecificationReady('', '');
    } finally {
      setIsAnalyzing(false);
    }
  }, [onSpecificationReady]);

  // Debounced content analysis
  useEffect(() => {
    const timer = setTimeout(() => {
      analyzeContent(content);
    }, 300);

    return () => clearTimeout(timer);
  }, [content, analyzeContent]);

  // Handle paste from clipboard
  const handlePasteFromClipboard = async () => {
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (clipboardText) {
        setContent(clipboardText);
      }
    } catch (error) {
      console.error('Failed to read from clipboard:', error);
      // Browser may not support clipboard API or permission denied
    }
  };

  // Handle clear
  const handleClear = () => {
    setContent('');
    setFileMetadata(null);
    setParseError(null);
    setDetectedSyntax('unknown');
    // Notify parent that content is cleared
    onSpecificationReady('', '');
  };

  // Handle editor content change
  const handleEditorChange = (value: string | undefined) => {
    setContent(value || '');
  };

  // Handle editor mount
  const handleEditorMount = () => {
    setEditorMounted(true);
  };

  // Check if content is ready for import
  const isReadyForImport = content.trim() && fileMetadata?.syntaxValid && fileMetadata?.formatSupported;

  // Get Monaco language based on detected syntax
  const getEditorLanguage = (): string => {
    if (detectedSyntax === 'json') return 'json';
    if (detectedSyntax === 'yaml') return 'yaml';
    // Default to yaml for unknown since OpenAPI specs are commonly YAML
    return content.trim().startsWith('{') || content.trim().startsWith('[') ? 'json' : 'yaml';
  };

  return (
    <div className="space-y-6">
      {/* Source Tabs */}
      <div role="tablist" aria-label="Import source" className={TAB_LIST_CLASS}>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          className={tabTriggerClass({ disabled: true })}
        >
          📁 File
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          className={tabTriggerClass({ disabled: true })}
        >
          🔗 URL
        </button>
        <button type="button" role="tab" aria-selected className={tabTriggerClass({ active: true })}>
          📋 Clipboard
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          className={tabTriggerClass({ disabled: true })}
          title="Coming soon"
        >
          🐙 Git
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          className={tabTriggerClass({ disabled: true })}
          title="Coming soon"
        >
          ☁️ SwaggerHub
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          className={tabTriggerClass({ disabled: true })}
          title="Coming soon"
        >
          📦 Registry
        </button>
      </div>

      {/* Instructions */}
      <div className="bg-accent-soft rounded-lg p-4 border border-accent">
        <div className="flex items-start gap-3">
          <FileText className="h-5 w-5 text-accent shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-accent-fg">
              Paste Your Specification
            </div>
            <div className="text-sm text-accent mt-1">
              Paste JSON or YAML content directly into the editor below. The format will be auto-detected with syntax highlighting.
            </div>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handlePasteFromClipboard}
            className="flex items-center gap-2"
          >
            <Copy className="h-4 w-4" />
            Paste from Clipboard
          </Button>
          {content && (
            <Button
              variant="outline"
              onClick={handleClear}
              className="flex items-center gap-2 text-danger hover:bg-danger-soft"
            >
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
          )}
        </div>
        {detectedSyntax !== 'unknown' && (
          <span className={`text-xs px-3 py-1.5 rounded-full font-medium ${
            detectedSyntax === 'json' 
              ? 'bg-accent-soft text-accent-fg' 
              : 'bg-ok-soft text-ok-fg'
          }`}>
            {detectedSyntax.toUpperCase()} Detected
          </span>
        )}
      </div>

      {/* Monaco Editor */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-fg">
          Specification Content
        </label>
        <div className="rounded-lg overflow-hidden border border-border-strong">
          <Editor
            height="300px"
            language={getEditorLanguage()}
            value={content}
            onChange={handleEditorChange}
            onMount={handleEditorMount}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: CODE_EDITOR_FONT_SIZE,
              lineNumbers: 'on',
              folding: true,
              wordWrap: 'on',
              wrappingIndent: 'indent',
              automaticLayout: true,
              tabSize: 2,
              insertSpaces: true,
              formatOnPaste: true,
              renderWhitespace: 'selection',
              scrollbar: {
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
              },
              padding: {
                top: 8,
                bottom: 8,
              },
              placeholder: 'Paste your OpenAPI, Swagger, or JSON Schema content here...',
            }}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-fg-muted">
          <span>{content.length.toLocaleString()} characters</span>
          <span>{content.split('\n').length.toLocaleString()} lines</span>
        </div>
      </div>

      {/* Parse Error */}
      {parseError && (
        <div className="p-4 rounded-lg bg-danger-soft">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-danger shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-danger">
                Parse Error
              </div>
              <div className="text-sm text-danger mt-1">
                {parseError}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Metadata Preview */}
      {content && fileMetadata && !parseError && (
        <div className="bg-surface rounded-xl border border-border p-6">
          <h3 className="text-lg font-semibold text-fg mb-4 flex items-center gap-2">
            <FileCode className="h-5 w-5 text-accent" />
            Content Preview
          </h3>

          {isAnalyzing ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
              <span className="ml-3 text-fg-muted">Analyzing content...</span>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Unsupported Format Warning */}
              {!fileMetadata.formatSupported && fileMetadata.format !== 'unknown' && (
                <div className="p-4 rounded-lg bg-warn-soft">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-warn shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium text-warn">
                        Format Not Available for Import
                      </div>
                      <div className="text-sm text-warn mt-1">
                        The detected format <span className="font-semibold">{fileMetadata.formatDisplayName}</span> is not yet supported for import.
                        Currently supported formats: OpenAPI 3.x, Swagger 2.x, JSON Schema, Arazzo, RAML, AsyncAPI, GraphQL, Protobuf, Thrift, Avro, and Postman.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Format · Version · Syntax — the wizard's own tiles (HIVE-6.4, #5315), so the
                  same three facts read the same way on File, URL, Clipboard and Git. */}
              <SpecMetaTiles metadata={fileMetadata} />

              {/* Title */}
              {fileMetadata.title && (
                <div className="pt-4 border-t border-border">
                  <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">
                    Title
                  </span>
                  <div className="text-base font-semibold text-fg mt-1">
                    {fileMetadata.title}
                  </div>
                </div>
              )}

              {/* Description */}
              {fileMetadata.description && (
                <div className="pt-4 border-t border-border">
                  <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">
                    Description
                  </span>
                  <div className="text-sm text-fg mt-1 leading-relaxed line-clamp-3">
                    {fileMetadata.description}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Ready indicator */}
      {isReadyForImport && (
        <div className="p-4 rounded-lg bg-ok-soft">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-ok" />
            <div className="font-medium text-ok-fg">
              Ready for Import
            </div>
          </div>
          <div className="text-sm text-ok mt-1 ml-8">
            Click &quot;Analyze&quot; to proceed with the import.
          </div>
        </div>
      )}
    </div>
  );
};

export default ClipboardImportPanel;

