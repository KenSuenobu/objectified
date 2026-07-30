'use client';

import { useState, useCallback } from 'react';
import { Upload, FileCode, CheckCircle2, AlertTriangle, Loader2, FileJson, ExternalLink } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { convertPostmanJsonToOpenAPIString } from '../../../utils/postman-to-openapi';
import { extractFileMetadata, FileMetadataPreview } from '../../../utils/openapi-analyzer';
import { TAB_LIST_CLASS, tabTriggerClass } from '../../ui/tabStyles';

interface PostmanImportPanelProps {
  onSpecificationFetched: (content: string, filename: string, metadata?: FileMetadataPreview) => void;
}

export const PostmanImportPanel: React.FC<PostmanImportPanelProps> = ({
  onSpecificationFetched
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pasteContent, setPasteContent] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [isConverting, setIsConverting] = useState(false);
  const [convertResult, setConvertResult] = useState<{
    success: boolean;
    error?: string;
    warnings: string[];
  } | null>(null);
  const [fileMetadata, setFileMetadata] = useState<FileMetadataPreview | null>(null);
  const [converted, setConverted] = useState(false);

  const handleFileSelect = useCallback((file: File) => {
    const isJson = file.name.toLowerCase().endsWith('.json');
    if (!isJson) {
      setConvertResult({ success: false, error: 'Please select a Postman Collection JSON file (.json)', warnings: [] });
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setConvertResult(null);
    setFileMetadata(null);
    setConverted(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleConvert = useCallback(async () => {
    let jsonContent: string;
    let sourceName: string;

    if (selectedFile) {
      try {
        jsonContent = await selectedFile.text();
        sourceName = selectedFile.name;
      } catch (e) {
        setConvertResult({
          success: false,
          error: 'Failed to read file',
          warnings: []
        });
        return;
      }
    } else if (pasteContent.trim()) {
      jsonContent = pasteContent.trim();
      sourceName = 'postman-collection.json';
    } else {
      setConvertResult({
        success: false,
        error: 'Upload a Postman Collection file or paste JSON content',
        warnings: []
      });
      return;
    }

    setIsConverting(true);
    setConvertResult(null);
    setFileMetadata(null);
    setConverted(false);

    try {
      const result = convertPostmanJsonToOpenAPIString(jsonContent, {
        baseUrl: baseUrl.trim() || undefined
      });

      if (!result.success) {
        setConvertResult({
          success: false,
          error: result.error,
          warnings: result.warnings || []
        });
        return;
      }

      const openApiString = JSON.stringify(result.document, null, 2);
      const metadata = extractFileMetadata(openApiString);
      setFileMetadata(metadata);
      setConvertResult({
        success: true,
        warnings: result.warnings || []
      });
      setConverted(true);
      onSpecificationFetched(openApiString, sourceName.replace(/\.json$/i, '-openapi.json'), metadata);
    } catch (e) {
      setConvertResult({
        success: false,
        error: e instanceof Error ? e.message : 'Conversion failed',
        warnings: []
      });
    } finally {
      setIsConverting(false);
    }
  }, [selectedFile, pasteContent, baseUrl, onSpecificationFetched]);

  const canConvert = (!!selectedFile || pasteContent.trim().length > 0) && !isConverting;

  return (
    <div className="space-y-6">
      {/* Source Tabs */}
      <div role="tablist" aria-label="Import source" className={TAB_LIST_CLASS}>
        <button type="button" role="tab" aria-selected={false} disabled className={tabTriggerClass({ disabled: true })}>
          📁 File
        </button>
        <button type="button" role="tab" aria-selected={false} disabled className={tabTriggerClass({ disabled: true })}>
          🔗 URL
        </button>
        <button type="button" role="tab" aria-selected={false} disabled className={tabTriggerClass({ disabled: true })}>
          📋 Clipboard
        </button>
        <button type="button" role="tab" aria-selected={false} disabled className={tabTriggerClass({ disabled: true })}>
          🐙 Git
        </button>
        <button type="button" role="tab" aria-selected={false} disabled className={tabTriggerClass({ disabled: true })}>
          ☁️ SwaggerHub
        </button>
        <button type="button" role="tab" aria-selected className={tabTriggerClass({ active: true })}>
          📮 Postman
        </button>
      </div>

      {/* Info Banner */}
      <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <FileJson className="h-5 w-5 text-orange-600 dark:text-orange-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-sm font-medium text-orange-900 dark:text-orange-100 mb-1">
              Import Postman Collection
            </h4>
            <p className="text-xs text-orange-700 dark:text-orange-300">
              Upload a Postman Collection v2.1 JSON file or paste its contents. It will be converted to OpenAPI 3.1 so you can import paths and schemas into Apiome.
            </p>
            <a
              href="https://learning.postman.com/docs/collections/collections-overview/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400 hover:underline mt-2"
            >
              Postman Collection format
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>

      {/* File Upload */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Postman Collection file
        </label>
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-8 text-center hover:border-orange-400 dark:hover:border-orange-600 transition-colors"
        >
          {selectedFile ? (
            <div className="flex flex-col items-center gap-2">
              <FileCode className="h-10 w-10 text-orange-500" />
              <span className="font-medium text-gray-900 dark:text-white">{selectedFile.name}</span>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {(selectedFile.size / 1024).toFixed(2)} KB
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedFile(null);
                  setConvertResult(null);
                  setConverted(false);
                }}
                className="text-sm text-red-600 dark:text-red-400 hover:underline"
              >
                Remove
              </button>
            </div>
          ) : (
            <>
              <Upload className="h-10 w-10 mx-auto text-gray-400 dark:text-gray-500 mb-2" />
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Drop a Postman Collection JSON here or click to browse
              </p>
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileSelect(f);
                  }}
                />
                <span className="inline-flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium rounded-lg transition-colors">
                  <Upload className="h-4 w-4" />
                  Choose file
                </span>
              </label>
            </>
          )}
        </div>
      </div>

      {/* Or paste JSON */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Or paste collection JSON
        </label>
        <textarea
          value={pasteContent}
          onChange={(e) => {
            setPasteContent(e.target.value);
            setConvertResult(null);
            setConverted(false);
          }}
          placeholder='Paste Postman Collection v2.1 JSON here (e.g. from Export → Collection v2.1)'
          rows={6}
          className="block w-full px-4 py-3 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 font-mono"
        />
      </div>

      {/* Optional base URL */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Base URL <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="e.g. https://api.example.com"
          className="block w-full px-4 py-3 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Used as the OpenAPI server URL. Leave empty to use a placeholder.
        </p>
      </div>

      {/* Convert button */}
      <div className="flex justify-end">
        <Button
          onClick={handleConvert}
          disabled={!canConvert}
          className="flex items-center gap-2 bg-orange-600 hover:bg-orange-700"
        >
          {isConverting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Converting...
            </>
          ) : (
            <>
              <FileCode className="h-4 w-4" />
              Convert to OpenAPI & Continue
            </>
          )}
        </Button>
      </div>

      {/* Result */}
      {convertResult && (
        <div
          className={`rounded-xl border p-4 ${
            convertResult.success
              ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20'
              : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20'
          }`}
        >
          <div className="flex items-start gap-3">
            {convertResult.success ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <h4
                className={`text-sm font-medium mb-1 ${
                  convertResult.success
                    ? 'text-green-900 dark:text-green-100'
                    : 'text-red-900 dark:text-red-100'
                }`}
              >
                {convertResult.success
                  ? 'Converted to OpenAPI 3.1'
                  : 'Conversion failed'}
              </h4>
              {!convertResult.success && convertResult.error && (
                <p className="text-sm text-red-700 dark:text-red-300">{convertResult.error}</p>
              )}
              {convertResult.warnings.length > 0 && (
                <ul className="text-xs text-amber-700 dark:text-amber-300 mt-2 list-disc list-inside">
                  {convertResult.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Metadata Preview */}
      {converted && fileMetadata && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3 bg-white dark:bg-gray-800">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            <FileCode className="h-4 w-4" />
            OpenAPI Preview
          </div>
          {fileMetadata.title && (
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Title
              </span>
              <div className="text-sm text-gray-900 dark:text-white font-medium mt-1">
                {fileMetadata.title}
              </div>
            </div>
          )}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Format
            </span>
            <div className="text-sm text-gray-900 dark:text-white mt-1">
              {fileMetadata.formatDisplayName || fileMetadata.format || 'OpenAPI 3.1'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PostmanImportPanel;
