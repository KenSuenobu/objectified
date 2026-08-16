'use client';

import { useState, useEffect, useCallback } from 'react';
import { FileText, CheckCircle2, AlertTriangle, FileCode, Copy, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { extractFileMetadata, FileMetadataPreview } from '../../../utils/openapi-analyzer';
import dynamic from 'next/dynamic';
import { TAB_LIST_CLASS, tabTriggerClass } from '../../ui/tabStyles';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

// Dynamic import for Monaco Editor to avoid SSR issues
const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="h-[300px] flex items-center justify-center bg-gray-900 rounded-lg">
      <div className="text-gray-400">Loading editor...</div>
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
      <div className="bg-indigo-50 dark:bg-indigo-950/30 rounded-lg p-4 border border-indigo-200 dark:border-indigo-800">
        <div className="flex items-start gap-3">
          <FileText className="h-5 w-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-indigo-900 dark:text-indigo-200">
              Paste Your Specification
            </div>
            <div className="text-sm text-indigo-700 dark:text-indigo-300 mt-1">
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
              className="flex items-center gap-2 text-red-600 dark:text-red-400 border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
          )}
        </div>
        {detectedSyntax !== 'unknown' && (
          <span className={`text-xs px-3 py-1.5 rounded-full font-medium ${
            detectedSyntax === 'json' 
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' 
              : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
          }`}>
            {detectedSyntax.toUpperCase()} Detected
          </span>
        )}
      </div>

      {/* Monaco Editor */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Specification Content
        </label>
        <div className="rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600">
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
        <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>{content.length.toLocaleString()} characters</span>
          <span>{content.split('\n').length.toLocaleString()} lines</span>
        </div>
      </div>

      {/* Parse Error */}
      {parseError && (
        <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-red-900 dark:text-red-200">
                Parse Error
              </div>
              <div className="text-sm text-red-700 dark:text-red-300 mt-1">
                {parseError}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Metadata Preview */}
      {content && fileMetadata && !parseError && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <FileCode className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            Content Preview
          </h3>

          {isAnalyzing ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 dark:border-indigo-400"></div>
              <span className="ml-3 text-gray-600 dark:text-gray-400">Analyzing content...</span>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Unsupported Format Warning */}
              {!fileMetadata.formatSupported && fileMetadata.format !== 'unknown' && (
                <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium text-amber-900 dark:text-amber-200">
                        Format Not Available for Import
                      </div>
                      <div className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                        The detected format <span className="font-semibold">{fileMetadata.formatDisplayName}</span> is not yet supported for import.
                        Currently supported formats: OpenAPI 3.x, Swagger 2.x, JSON Schema, Arazzo, RAML, AsyncAPI, GraphQL, Protobuf, Thrift, Avro, and Postman.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Metadata Grid */}
              <div className="grid grid-cols-3 gap-4">
                {/* Format */}
                <div className={`rounded-lg p-4 border ${fileMetadata.formatSupported ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    {fileMetadata.formatSupported ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                    )}
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Detected Format
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-gray-900 dark:text-white">
                    {fileMetadata.formatDisplayName}
                  </div>
                </div>

                {/* Spec Version */}
                <div className="rounded-lg p-4 border bg-gray-50 dark:bg-gray-900/30 border-gray-200 dark:border-gray-700">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Version
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-gray-900 dark:text-white">
                    {fileMetadata.specVersion || fileMetadata.version || 'N/A'}
                  </div>
                </div>

                {/* Syntax */}
                <div className="rounded-lg p-4 border bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Syntax
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-gray-900 dark:text-white">
                    Valid {fileMetadata.syntax.toUpperCase()}
                  </div>
                </div>
              </div>

              {/* Title */}
              {fileMetadata.title && (
                <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Title
                  </span>
                  <div className="text-base font-semibold text-gray-900 dark:text-white mt-1">
                    {fileMetadata.title}
                  </div>
                </div>
              )}

              {/* Description */}
              {fileMetadata.description && (
                <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Description
                  </span>
                  <div className="text-sm text-gray-700 dark:text-gray-300 mt-1 leading-relaxed line-clamp-3">
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
        <div className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
            <div className="font-medium text-green-900 dark:text-green-200">
              Ready for Import
            </div>
          </div>
          <div className="text-sm text-green-700 dark:text-green-300 mt-1 ml-8">
            Click &quot;Analyze&quot; to proceed with the import.
          </div>
        </div>
      )}
    </div>
  );
};

export default ClipboardImportPanel;

