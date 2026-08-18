'use client';

import { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Link2, Eye, EyeOff, CheckCircle2, AlertTriangle, FileCode, Globe } from 'lucide-react';
import { fetchSpecificationFromUrl, validateImportUrl, UrlImportOptions, UrlImportResult } from '../../../utils/url-import';
import { extractFileMetadata, FileMetadataPreview } from '../../../utils/openapi-analyzer';
import { ImportSourceTabBar, type ImportSourceTabId } from './ImportSourceTabBar';

export interface UrlImportFooterState {
  canTestUrl: boolean;
  isTesting: boolean;
  urlTestedSuccessfully: boolean;
}

export interface UrlImportPanelHandle {
  testUrl: () => Promise<void>;
}

interface UrlImportPanelProps {
  onSpecificationFetched: (content: string, filename: string, metadata?: FileMetadataPreview) => void;
  /** Switch import source (same step, different panel). */
  onSelectSource?: (source: ImportSourceTabId) => void;
  onFooterStateChange?: (state: UrlImportFooterState) => void;
  /** Extra tabs to disable (e.g. SwaggerHub in class import). */
  tabDisabledIds?: ImportSourceTabId[];
}

type AuthType = 'none' | 'bearer' | 'apiKey' | 'basic';

const UrlImportPanel = forwardRef<UrlImportPanelHandle, UrlImportPanelProps>(function UrlImportPanel(
  { onSpecificationFetched, onSelectSource, onFooterStateChange, tabDisabledIds },
  ref
) {
  // Form state
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<AuthType>('none');
  const [token, setToken] = useState('');
  const [apiKeyHeader, setApiKeyHeader] = useState('X-API-Key');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [followRedirects, setFollowRedirects] = useState(true);
  const [resolveExternalRefs, setResolveExternalRefs] = useState(true);
  const [cacheFetched, setCacheFetched] = useState(false);
  const [saveCredentials, setSaveCredentials] = useState(false);

  // UI state
  const [urlError, setUrlError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<UrlImportResult | null>(null);
  const [fileMetadata, setFileMetadata] = useState<FileMetadataPreview | null>(null);
  const [urlTested, setUrlTested] = useState(false);

  // Validate URL on change
  useEffect(() => {
    if (!url) {
      setUrlError(null);
      return;
    }

    const validation = validateImportUrl(url);
    if (!validation.valid) {
      setUrlError(validation.error || 'Invalid URL');
    } else {
      setUrlError(null);
    }
  }, [url]);

  // Test URL - fetches and validates but doesn't proceed to analysis
  const handleTestUrl = useCallback(async () => {
    if (!url.trim() || urlError) return;

    const options: UrlImportOptions = {
      url: url.trim(),
      authType,
      authToken: authType === 'bearer' || authType === 'apiKey' ? token : undefined,
      apiKeyHeader: authType === 'apiKey' ? apiKeyHeader : undefined,
      username: authType === 'basic' ? username : undefined,
      password: authType === 'basic' ? password : undefined,
      followRedirects,
      resolveExternalRefs,
      useCache: cacheFetched,
      timeout: 30000
    };

    setIsFetching(true);
    setFetchResult(null);
    setFileMetadata(null);
    setUrlTested(false);

    try {
      const result = await fetchSpecificationFromUrl(options);
      setFetchResult(result);

      if (result.success && result.content) {
        const metadata = extractFileMetadata(result.content);
        setFileMetadata(metadata);

        setUrlTested(true);

        onSpecificationFetched(result.content, result.filename || 'openapi-spec.yaml', metadata);
      }
    } catch (error) {
      setFetchResult({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch specification'
      });
    } finally {
      setIsFetching(false);
    }
  }, [
    url,
    urlError,
    authType,
    token,
    apiKeyHeader,
    username,
    password,
    followRedirects,
    resolveExternalRefs,
    cacheFetched,
    onSpecificationFetched
  ]);

  useImperativeHandle(ref, () => ({
    testUrl: () => handleTestUrl(),
  }), [handleTestUrl]);

  useEffect(() => {
    onFooterStateChange?.({
      canTestUrl: Boolean(url.trim()) && !urlError,
      isTesting: isFetching,
      urlTestedSuccessfully: Boolean(urlTested && fetchResult?.success),
    });
  }, [url, urlError, isFetching, urlTested, fetchResult?.success, onFooterStateChange]);

  // Reset tested state when URL or auth changes
  useEffect(() => {
    setUrlTested(false);
    setFetchResult(null);
    setFileMetadata(null);
  }, [url, authType, token, apiKeyHeader, username, password]);

  return (
    <div className="space-y-6">
      <ImportSourceTabBar
        active="url"
        onSelect={(id) => onSelectSource?.(id)}
        disabledIds={tabDisabledIds}
      />

      {/* URL Input */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-fg">
          Specification URL
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Globe className="h-5 w-5 text-fg-faint" />
          </div>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/openapi.yaml"
            className={`block w-full pl-10 pr-4 py-3 text-sm rounded-lg border ${
              urlError
                ? 'border-danger focus:ring-danger focus:border-danger'
                : 'border-border-strong focus:ring-accent focus:border-accent'
            } bg-surface text-fg placeholder:text-fg-faint`}
          />
        </div>
        {urlError && (
          <p className="text-sm text-danger">{urlError}</p>
        )}
      </div>

      {/* Authentication Section */}
      <div className="rounded-xl border border-border p-4 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <Link2 className="h-4 w-4" />
          Authentication (optional)
        </div>

        {/* Auth Type Selection */}
        <div className="flex flex-wrap gap-4">
          {(['none', 'bearer', 'apiKey', 'basic'] as AuthType[]).map((type) => (
            <label key={type} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="authType"
                value={type}
                checked={authType === type}
                onChange={(e) => setAuthType(e.target.value as AuthType)}
                className="text-accent focus:ring-accent"
              />
              <span className="text-sm text-fg">
                {type === 'none' ? 'None' :
                 type === 'bearer' ? 'Bearer Token' :
                 type === 'apiKey' ? 'API Key' : 'Basic Auth'}
              </span>
            </label>
          ))}
        </div>

        {/* Bearer Token Input */}
        {authType === 'bearer' && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-fg">
              Token
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter your bearer token"
                className="block w-full pr-10 py-2 text-sm rounded-lg border border-border-strong bg-surface text-fg"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4 text-fg-faint" />
                ) : (
                  <Eye className="h-4 w-4 text-fg-faint" />
                )}
              </button>
            </div>
          </div>
        )}

        {/* API Key Input */}
        {authType === 'apiKey' && (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-fg">
                Header Name
              </label>
              <input
                type="text"
                value={apiKeyHeader}
                onChange={(e) => setApiKeyHeader(e.target.value)}
                placeholder="X-API-Key"
                className="block w-full py-2 text-sm rounded-lg border border-border-strong bg-surface text-fg"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-fg">
                API Key
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Enter your API key"
                  className="block w-full pr-10 py-2 text-sm rounded-lg border border-border-strong bg-surface text-fg"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4 text-fg-faint" />
                  ) : (
                    <Eye className="h-4 w-4 text-fg-faint" />
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Basic Auth Input */}
        {authType === 'basic' && (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-fg">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                className="block w-full py-2 text-sm rounded-lg border border-border-strong bg-surface text-fg"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-fg">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className="block w-full pr-10 py-2 text-sm rounded-lg border border-border-strong bg-surface text-fg"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4 text-fg-faint" />
                  ) : (
                    <Eye className="h-4 w-4 text-fg-faint" />
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Save credentials checkbox */}
        {authType !== 'none' && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={saveCredentials}
              onChange={(e) => setSaveCredentials(e.target.checked)}
              className="rounded text-accent focus:ring-accent"
            />
            <span className="text-sm text-fg-muted">
              Save credentials for future imports
            </span>
          </label>
        )}
      </div>

      {/* URL Options */}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="text-sm font-medium text-fg">
          URL Options
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={followRedirects}
              onChange={(e) => setFollowRedirects(e.target.checked)}
              className="rounded text-accent focus:ring-accent"
            />
            <span className="text-sm text-fg-muted">
              Follow redirects
            </span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={resolveExternalRefs}
              onChange={(e) => setResolveExternalRefs(e.target.checked)}
              className="rounded text-accent focus:ring-accent"
            />
            <span className="text-sm text-fg-muted">
              Resolve external $ref URLs
            </span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={cacheFetched}
              onChange={(e) => setCacheFetched(e.target.checked)}
              className="rounded text-accent focus:ring-accent"
            />
            <span className="text-sm text-fg-muted">
              Cache fetched content
            </span>
          </label>
        </div>
      </div>

      {/* Fetch Result */}
      {fetchResult && !fetchResult.success && (
        <div className="rounded-lg bg-danger-soft p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-danger shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-danger">
                Failed to Fetch Specification
              </div>
              <div className="text-sm text-danger mt-1">
                {fetchResult.error}
                {fetchResult.statusCode && ` (HTTP ${fetchResult.statusCode})`}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Fetched Metadata Preview */}
      {fetchResult?.success && fileMetadata && (
        <div className="bg-surface rounded-xl border border-border p-6">
          <h3 className="text-lg font-semibold text-fg mb-4 flex items-center gap-2">
            <FileCode className="h-5 w-5 text-accent" />
            Specification Preview
          </h3>

          <div className="space-y-4">
            {/* Metadata Grid */}
            <div className="grid grid-cols-3 gap-4">
              {/* Format */}
              <div className={`rounded-lg p-4 border ${
                fileMetadata.formatSupported 
                  ? 'bg-ok-soft border-ok' 
                  : 'bg-warn-soft border-warn'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  {fileMetadata.formatSupported ? (
                    <CheckCircle2 className="h-5 w-5 text-ok" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-warn" />
                  )}
                  <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">
                    Detected Format
                  </span>
                </div>
                <div className="text-sm font-semibold text-fg">
                  {fileMetadata.formatDisplayName}
                </div>
              </div>

              {/* Version */}
              <div className="rounded-lg p-4 border bg-subtle border-border">
                <div className="text-xs font-medium text-fg-muted uppercase tracking-wider mb-2">
                  Version
                </div>
                <div className="text-sm font-semibold text-fg">
                  {fileMetadata.specVersion || fileMetadata.version || 'N/A'}
                </div>
              </div>

              {/* Syntax */}
              <div className={`rounded-lg p-4 border ${
                fileMetadata.syntaxValid 
                  ? 'bg-ok-soft border-ok' 
                  : 'bg-danger-soft border-danger'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  {fileMetadata.syntaxValid ? (
                    <CheckCircle2 className="h-5 w-5 text-ok" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-danger" />
                  )}
                  <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">
                    Syntax
                  </span>
                </div>
                <div className="text-sm font-semibold text-fg">
                  {fileMetadata.syntaxValid ? `Valid ${fileMetadata.syntax.toUpperCase()}` : 'Invalid'}
                </div>
              </div>
            </div>

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
        </div>
      )}

      {/* Help text for next steps */}
      {urlTested && fetchResult?.success && fileMetadata?.formatSupported && (
        <div className="p-4 rounded-lg bg-ok-soft">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-ok" />
            <div>
              <div className="font-medium text-ok-fg">
                URL verified successfully
              </div>
              <div className="text-sm text-ok mt-1">
                Use the button in the dialog footer to continue to analysis.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default UrlImportPanel;

