'use client';

import { useState, useEffect } from 'react';
import { Cloud, Eye, EyeOff, CheckCircle2, AlertTriangle, Loader2, FileCode, Search, ExternalLink } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { fetchFromSwaggerHub, validateSwaggerHubOptions, SwaggerHubImportOptions, SwaggerHubImportResult } from '../../../utils/swaggerhub-import';
import { extractFileMetadata, FileMetadataPreview } from '../../../utils/openapi-analyzer';
import { TAB_LIST_CLASS, tabTriggerClass } from '../../ui/tabStyles';

interface SwaggerHubImportPanelProps {
  onSpecificationFetched: (content: string, filename: string, metadata?: FileMetadataPreview) => void;
}

export const SwaggerHubImportPanel: React.FC<SwaggerHubImportPanelProps> = ({
  onSpecificationFetched
}) => {
  // Form state
  const [owner, setOwner] = useState('');
  const [apiName, setApiName] = useState('');
  const [version, setVersion] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [useLatestVersion, setUseLatestVersion] = useState(true);

  // UI state
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [apiNameError, setApiNameError] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<SwaggerHubImportResult | null>(null);
  const [fileMetadata, setFileMetadata] = useState<FileMetadataPreview | null>(null);
  const [specTested, setSpecTested] = useState(false);

  // Validate inputs
  useEffect(() => {
    if (owner && !/^[a-zA-Z0-9_-]+$/.test(owner)) {
      setOwnerError('Only letters, numbers, hyphens, and underscores allowed');
    } else {
      setOwnerError(null);
    }
  }, [owner]);

  useEffect(() => {
    if (apiName && !/^[a-zA-Z0-9_-]+$/.test(apiName)) {
      setApiNameError('Only letters, numbers, hyphens, and underscores allowed');
    } else {
      setApiNameError(null);
    }
  }, [apiName]);

  useEffect(() => {
    if (version && !useLatestVersion && !/^[a-zA-Z0-9._-]+$/.test(version)) {
      setVersionError('Only letters, numbers, dots, hyphens, and underscores allowed');
    } else {
      setVersionError(null);
    }
  }, [version, useLatestVersion]);

  // Build import options
  const buildOptions = (): SwaggerHubImportOptions => ({
    owner: owner.trim(),
    api: apiName.trim(),
    version: useLatestVersion ? undefined : version.trim() || undefined,
    apiKey: apiKey.trim() || undefined
  });

  // Test connection - fetches and validates but doesn't proceed to analysis
  const handleTestConnection = async () => {
    const options = buildOptions();
    const validation = validateSwaggerHubOptions(options);

    if (!validation.valid) {
      setFetchResult({
        success: false,
        error: validation.error
      });
      return;
    }

    setIsFetching(true);
    setFetchResult(null);
    setFileMetadata(null);
    setSpecTested(false);

    try {
      const result = await fetchFromSwaggerHub(options);
      setFetchResult(result);

      if (result.success && result.content) {
        // Extract metadata for preview
        const metadata = extractFileMetadata(result.content);
        setFileMetadata(metadata);
        setSpecTested(true);

        // Notify parent that content is ready
        onSpecificationFetched(result.content, result.filename || 'swaggerhub-spec.json', metadata);
      }
    } catch (error) {
      setFetchResult({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch specification'
      });
    } finally {
      setIsFetching(false);
    }
  };

  // Reset tested state when inputs change
  useEffect(() => {
    setSpecTested(false);
    setFetchResult(null);
    setFileMetadata(null);
  }, [owner, apiName, version, apiKey, useLatestVersion]);

  const canTest = owner.trim() && apiName.trim() && !ownerError && !apiNameError && !versionError;

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
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          className={tabTriggerClass({ disabled: true })}
        >
          📋 Clipboard
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          disabled
          className={tabTriggerClass({ disabled: true })}
        >
          🐙 Git
        </button>
        <button type="button" role="tab" aria-selected className={tabTriggerClass({ active: true })}>
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

      {/* Info Banner */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Cloud className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-1">
              Import from SwaggerHub
            </h4>
            <p className="text-xs text-blue-700 dark:text-blue-300">
              Import OpenAPI specifications from SwaggerHub. Public APIs can be accessed without authentication.
              Private APIs require an API key from your SwaggerHub account settings.
            </p>
            <a
              href="https://support.smartbear.com/swaggerhub/docs/en/faq.html"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline mt-2"
            >
              Learn how to get an API key
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>

      {/* API Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Owner/Organization */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Owner / Organization <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="e.g., myorg"
            className={`block w-full px-4 py-3 text-sm rounded-lg border ${
              ownerError
                ? 'border-red-500 dark:border-red-400'
                : 'border-gray-300 dark:border-gray-600'
            } bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400`}
          />
          {ownerError && (
            <p className="text-sm text-red-600 dark:text-red-400">{ownerError}</p>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            The owner or organization name in SwaggerHub
          </p>
        </div>

        {/* API Name */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            API Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={apiName}
            onChange={(e) => setApiName(e.target.value)}
            placeholder="e.g., petstore"
            className={`block w-full px-4 py-3 text-sm rounded-lg border ${
              apiNameError
                ? 'border-red-500 dark:border-red-400'
                : 'border-gray-300 dark:border-gray-600'
            } bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400`}
          />
          {apiNameError && (
            <p className="text-sm text-red-600 dark:text-red-400">{apiNameError}</p>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            The API name as it appears in SwaggerHub
          </p>
        </div>
      </div>

      {/* Version Selection */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={useLatestVersion}
            onChange={(e) => setUseLatestVersion(e.target.checked)}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Use latest version
          </span>
        </label>

        {!useLatestVersion && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Specific Version
            </label>
            <input
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="e.g., 1.0.0"
              className={`block w-full px-4 py-3 text-sm rounded-lg border ${
                versionError
                  ? 'border-red-500 dark:border-red-400'
                  : 'border-gray-300 dark:border-gray-600'
              } bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400`}
            />
            {versionError && (
              <p className="text-sm text-red-600 dark:text-red-400">{versionError}</p>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Leave blank to fetch the latest version
            </p>
          </div>
        )}
      </div>

      {/* API Key (Optional) */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          <Cloud className="h-4 w-4" />
          API Key (for private APIs)
        </div>

        <div className="space-y-2">
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your SwaggerHub API key"
              className="block w-full pr-10 px-4 py-3 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center"
            >
              {showApiKey ? (
                <EyeOff className="h-4 w-4 text-gray-400" />
              ) : (
                <Eye className="h-4 w-4 text-gray-400" />
              )}
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Optional. Only required for accessing private APIs.
          </p>
        </div>
      </div>

      {/* Test Connection Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleTestConnection}
          disabled={!canTest || isFetching}
          className="flex items-center gap-2"
        >
          {isFetching ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Fetching...
            </>
          ) : (
            <>
              <Search className="h-4 w-4" />
              Test & Fetch
            </>
          )}
        </Button>
      </div>

      {/* Result Display */}
      {fetchResult && (
        <div className={`rounded-xl border p-4 ${
          fetchResult.success
            ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20'
            : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20'
        }`}>
          <div className="flex items-start gap-3">
            {fetchResult.success ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <h4 className={`text-sm font-medium mb-1 ${
                fetchResult.success
                  ? 'text-green-900 dark:text-green-100'
                  : 'text-red-900 dark:text-red-100'
              }`}>
                {fetchResult.success ? 'Successfully fetched specification' : 'Failed to fetch specification'}
              </h4>
              <p className={`text-xs ${
                fetchResult.success
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-red-700 dark:text-red-300'
              }`}>
                {fetchResult.success
                  ? `Fetched ${fetchResult.filename} (Version: ${fetchResult.version})`
                  : fetchResult.error}
              </p>
              {fetchResult.isPrivate && (
                <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-2">
                  💡 This appears to be a private API. Make sure you have the correct API key.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Metadata Preview */}
      {specTested && fileMetadata && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3 bg-white dark:bg-gray-800">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            <FileCode className="h-4 w-4" />
            Specification Preview
          </div>

          {/* Title */}
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

          {/* Format Info */}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 gap-4">
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Format
              </span>
              <div className="text-sm text-gray-900 dark:text-white mt-1">
                {fileMetadata.format?.toUpperCase() || 'Unknown'}
              </div>
            </div>
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Version
              </span>
              <div className="text-sm text-gray-900 dark:text-white mt-1">
                {fileMetadata.version || 'Unknown'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SwaggerHubImportPanel;

