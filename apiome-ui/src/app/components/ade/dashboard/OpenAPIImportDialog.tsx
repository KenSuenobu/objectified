'use client';

import { useState, useCallback, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { Upload, FileJson, AlertCircle, CheckCircle2, Link2, Globe, FolderOpen, File, ArrowLeft, Lock, Search } from 'lucide-react';
import { SiGithub, SiGitlab, SiGoogle, SiAmazon } from 'react-icons/si';
import { TAB_LIST_CLASS, tabTriggerRadixClass } from '../../ui/tabStyles';
import { cn } from '@lib/utils';

const spacing = (n: number) => (typeof n === 'number' ? n * 8 : 0);
const sxToStyle = (sx: any): React.CSSProperties => {
  if (!sx || typeof sx !== 'object') return {};
  const s: React.CSSProperties = {};
  if (sx.p != null) s.padding = spacing(Number(sx.p)); if (sx.px != null) { s.paddingLeft = spacing(Number(sx.px)); s.paddingRight = spacing(Number(sx.px)); }
  if (sx.py != null) { s.paddingTop = spacing(Number(sx.py)); s.paddingBottom = spacing(Number(sx.py)); }
  if (sx.m != null) s.margin = spacing(Number(sx.m)); if (sx.mb != null) s.marginBottom = spacing(Number(sx.mb)); if (sx.mt != null) s.marginTop = spacing(Number(sx.mt));
  if (sx.ml != null) s.marginLeft = spacing(Number(sx.ml)); if (sx.mr != null) s.marginRight = spacing(Number(sx.mr));
  if (sx.gap != null) s.gap = spacing(Number(sx.gap)); if (sx.display != null) s.display = sx.display; if (sx.flex != null) s.flex = sx.flex;
  if (sx.flexDirection != null) s.flexDirection = sx.flexDirection; if (sx.alignItems != null) s.alignItems = sx.alignItems; if (sx.justifyContent != null) s.justifyContent = sx.justifyContent;
  if (sx.borderRadius != null) s.borderRadius = typeof sx.borderRadius === 'number' ? sx.borderRadius * 8 : sx.borderRadius;
  if (sx.border != null) s.border = sx.border; if (sx.borderBottom != null) s.borderBottom = sx.borderBottom; if (sx.borderColor != null) s.borderColor = sx.borderColor;
  if (sx.borderRight != null) s.borderRight = sx.borderRight; if (sx.bgcolor != null) s.backgroundColor = sx.bgcolor; if (sx.color != null) s.color = sx.color;
  if (sx.fontSize != null) s.fontSize = typeof sx.fontSize === 'number' ? sx.fontSize : sx.fontSize; if (sx.fontWeight != null) s.fontWeight = sx.fontWeight;
  if (sx.overflow != null) s.overflow = sx.overflow; if (sx.overflowY != null) s.overflowY = sx.overflowY; if (sx.minWidth != null) s.minWidth = sx.minWidth;
  if (sx.maxWidth != null) s.maxWidth = sx.maxWidth; if (sx.width != null) s.width = sx.width; if (sx.height != null) s.height = sx.height;
  if (sx.minHeight != null) s.minHeight = sx.minHeight; if (sx.flexShrink != null) s.flexShrink = sx.flexShrink; if (sx.cursor != null) s.cursor = sx.cursor;
  if (sx.opacity != null) s.opacity = sx.opacity; if (sx.textAlign != null) s.textAlign = sx.textAlign;
  return s;
};
const Box = ({ sx, children, component: C = 'div', ...rest }: any) => <C style={sxToStyle(sx)} {...rest}>{children}</C>;
const Typography = ({ variant, sx, children, component: C = 'span', ...rest }: any) => <C style={sxToStyle(sx)} {...rest}>{children}</C>;
const Alert = ({ severity, sx, children, ...rest }: any) => <div role="alert" style={sxToStyle(sx)} className={`p-3 rounded-lg ${severity === 'error' ? 'bg-red-50 dark:bg-red-900/20 text-red-800' : severity === 'warning' ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-800' : 'bg-blue-50 dark:bg-blue-900/20 text-blue-800'}`} {...rest}>{children}</div>;
const TextField = ({ label, value, onChange, fullWidth, sx, margin, helperText, ...rest }: any) => (
  <div style={{ marginBottom: margin === 'dense' ? 8 : 16, ...sxToStyle(sx) }}>
    {label && <label className="block text-sm font-medium mb-1">{label}</label>}
    <input type="text" value={value ?? ''} onChange={(e) => onChange?.(e)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800" style={sxToStyle(sx)} {...rest} />
    {helperText && <p className="text-xs text-slate-500 mt-1">{helperText}</p>}
  </div>
);
const Button = ({ onClick, children, variant, disabled, startIcon, fullWidth, ...rest }: any) => (
  <button type="button" onClick={onClick} disabled={disabled} className={`px-4 py-2 rounded-lg ${variant === 'contained' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'border border-slate-300 hover:bg-slate-50'} disabled:opacity-50 ${fullWidth ? 'w-full' : ''}`} {...rest}>{startIcon}{children}</button>
);
const IconButton = ({ onClick, size, children, disabled, sx, ...rest }: any) => <button type="button" onClick={onClick} disabled={disabled} style={{ padding: size === 'small' ? 4 : 8, background: 'none', border: 'none', cursor: 'pointer', ...sxToStyle(sx) }} {...rest}>{children}</button>;
const Chip = ({ label, size, icon, variant, sx, ...rest }: any) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 16, fontSize: 12, ...sxToStyle(sx) }} {...rest}>{icon}{label}</span>;
const FormControlLabel = ({ control, label, ...rest }: any) => <label className="flex items-center gap-2 cursor-pointer" {...rest}>{control}{label}</label>;
const Checkbox = ({ checked, onChange, disabled, ...rest }: any) => <input type="checkbox" checked={checked} onChange={(e) => onChange?.(e, e.target.checked)} disabled={disabled} {...rest} />;
const CircularProgress = ({ size }: any) => <span className="animate-spin rounded-full border-2 border-current border-t-transparent" style={{ width: size || 24, height: size || 24 }} />;
import { parseOpenAPISpec, ParsedClass, type ParsedPath, type ParsedSecurityScheme, type ParsedOpenAPIServer } from '../../../utils/openapi-import';
import { importProjectFromOpenAPI, getLinkedAccountsForUser } from '../../../../../lib/db/helper';
import { filterSlugInput, generateSlug } from '../../../utils/slug';

interface OpenAPIImportDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  tenantId: string;
  userId: string;
}

const OpenAPIImportDialog: React.FC<OpenAPIImportDialogProps> = ({
  open,
  onClose,
  onSuccess,
  tenantId,
  userId
}) => {
  const [step, setStep] = useState<'upload' | 'review' | 'summary' | 'details'>('upload');
  const [importMethod, setImportMethod] = useState<'file' | 'url' | 'sso'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [linkedAccounts, setLinkedAccounts] = useState<any[]>([]);
  const [classes, setClasses] = useState<ParsedClass[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [projectName, setProjectName] = useState('');
  const [projectSlug, setProjectSlug] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [versionId, setVersionId] = useState('1.0.0');
  const [versionDescription, setVersionDescription] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [openAPIInfo, setOpenAPIInfo] = useState<any>(null);
  const [parsedPaths, setParsedPaths] = useState<ParsedPath[]>([]);
  const [parsedSecuritySchemes, setParsedSecuritySchemes] = useState<ParsedSecurityScheme[]>([]);
  const [parsedServers, setParsedServers] = useState<ParsedOpenAPIServer[]>([]);

  // SSO Repository Browser state
  const [selectedAccount, setSelectedAccount] = useState<any>(null);
  const [repositories, setRepositories] = useState<any[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<any>(null);
  const [repoFiles, setRepoFiles] = useState<any[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [repoSearchQuery, setRepoSearchQuery] = useState<string>('');


  // Load linked accounts when dialog opens
  useEffect(() => {
    if (open && userId) {
      loadLinkedAccounts();
    }
  }, [open, userId]);

  const loadLinkedAccounts = async () => {
    try {
      const result = await getLinkedAccountsForUser(userId);
      setLinkedAccounts(JSON.parse(result));
    } catch (error) {
      console.error('Failed to load linked accounts:', error);
      setLinkedAccounts([]);
    }
  };

  const resetDialog = () => {
    setStep('upload');
    setImportMethod('file');
    setFile(null);
    setUrlInput('');
    setClasses([]);
    setWarnings([]);
    setProjectName('');
    setProjectSlug('');
    setProjectDescription('');
    setVersionId('1.0.0');
    setVersionDescription('');
    setErrorMessage('');
    setIsLoading(false);
    setIsDragging(false);
    setOpenAPIInfo(null);
    setParsedPaths([]);
    setParsedSecuritySchemes([]);
    setParsedServers([]);
    setSelectedAccount(null);
    setRepositories([]);
    setSelectedRepo(null);
    setRepoFiles([]);
    setCurrentPath('');
    setRepoSearchQuery('');
  };

  const calculateImportStats = () => {
    const supportedClasses = classes.filter(c => c.isSupported);
    const selectedClasses = supportedClasses.filter(c => c.selected);

    // Count unique properties by creating a signature (name + type)
    const propertyMap = new Map<string, number>(); // signature -> count

    selectedClasses.forEach(cls => {
      cls.properties.forEach(prop => {
        const signature = JSON.stringify({ name: prop.name, data: prop.data });
        propertyMap.set(signature, (propertyMap.get(signature) || 0) + 1);
      });
    });

    const totalProperties = propertyMap.size;
    const sharedProperties = Array.from(propertyMap.values()).filter(count => count > 1).length;
    const uniqueProperties = totalProperties - sharedProperties;

    return {
      totalClasses: selectedClasses.length,
      supportedClasses: supportedClasses.length,
      unsupportedClasses: classes.filter(c => !c.isSupported).length,
      totalProperties,
      uniqueProperties,
      sharedProperties
    };
  };

  const processOpenAPIContent = async (content: string, source: string = 'file') => {
    setErrorMessage('');

    try {
      // Parse the OpenAPI spec
      const parseResult = parseOpenAPISpec(content);

      if (!parseResult.success) {
        setErrorMessage(parseResult.error || 'Failed to parse OpenAPI specification');
        return;
      }

      setClasses(parseResult.classes);
      setWarnings(parseResult.warnings || []);
      setParsedPaths(parseResult.paths ?? []);
      setParsedSecuritySchemes(parseResult.securitySchemes ?? []);
      setParsedServers(parseResult.servers ?? []);
      setOpenAPIInfo({
        title: parseResult.title,
        version: parseResult.version,
        description: parseResult.description,
        source
      });

      // Auto-fill project details from OpenAPI info
      if (parseResult.title) {
        setProjectName(parseResult.title);
        setProjectSlug(generateSlug(parseResult.title));
      }
      if (parseResult.description) {
        setProjectDescription(parseResult.description);
      }
      if (parseResult.version) {
        setVersionId(parseResult.version);
      }

      setStep('review');
    } catch (error: any) {
      setErrorMessage(`Error processing OpenAPI spec: ${error.message}`);
    }
  };

  const handleFileSelect = async (selectedFile: File) => {
    const fileName = selectedFile.name.toLowerCase();
    if (!fileName.endsWith('.json') && !fileName.endsWith('.yaml') && !fileName.endsWith('.yml') && !fileName.endsWith('.graphql') && !fileName.endsWith('.gql') && !fileName.endsWith('.raml') && !fileName.endsWith('.proto') && !fileName.endsWith('.avsc') && !fileName.endsWith('.thrift')) {
      setErrorMessage('Please select a JSON, YAML, GraphQL, RAML, Protobuf, Avro (.avsc), or Thrift (.thrift) file');
      return;
    }

    setFile(selectedFile);
    setIsLoading(true);

    try {
      const content = await selectedFile.text();
      await processOpenAPIContent(content, `File: ${selectedFile.name}`);
    } catch (error: any) {
      setErrorMessage(`Error reading file: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUrlImport = async () => {
    if (!urlInput.trim()) {
      setErrorMessage('Please enter a URL');
      return;
    }

    // Basic URL validation
    try {
      new URL(urlInput);
    } catch {
      setErrorMessage('Please enter a valid URL');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      const response = await fetch(urlInput);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();
      await processOpenAPIContent(content, `URL: ${urlInput}`);
    } catch (error: any) {
      setErrorMessage(`Failed to fetch from URL: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectAccount = async (account: any) => {
    setSelectedAccount(account);
    setIsLoading(true);
    setErrorMessage('');

    try {
      // Fetch repositories for the selected account
      const response = await fetch(`/api/sso/${account.provider}/repos?accountId=${account.id}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch repositories: ${response.statusText}`);
      }

      const data = await response.json();
      const sortedRepos = (data.repositories || []).sort((a: any, b: any) => {
        const nameA = (a.name || '').toLowerCase();
        const nameB = (b.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
      setRepositories(sortedRepos);
    } catch (error: any) {
      setErrorMessage(`Failed to load repositories: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectRepo = async (repo: any) => {
    setSelectedRepo(repo);
    setIsLoading(true);
    setErrorMessage('');
    setCurrentPath('');

    try {
      // Fetch files from the repository root
      const response = await fetch(
        `/api/sso/${selectedAccount.provider}/files?accountId=${selectedAccount.id}&repo=${repo.full_name}&path=`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch files: ${response.statusText}`);
      }

      const data = await response.json();
      setRepoFiles(data.files || []);
    } catch (error: any) {
      setErrorMessage(`Failed to load files: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleNavigateToPath = async (path: string) => {
    setIsLoading(true);
    setErrorMessage('');
    setCurrentPath(path);

    try {
      const response = await fetch(
        `/api/sso/${selectedAccount.provider}/files?accountId=${selectedAccount.id}&repo=${selectedRepo.full_name}&path=${path}`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch files: ${response.statusText}`);
      }

      const data = await response.json();
      setRepoFiles(data.files || []);
    } catch (error: any) {
      setErrorMessage(`Failed to load files: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectFile = async (file: any) => {
    if (file.type === 'dir') {
      // Navigate into directory
      handleNavigateToPath(file.path);
      return;
    }

    // Check if it's an OpenAPI file (or RAML / other importable spec)
    const isOpenAPIFile =
      file.name.includes('openapi') ||
      file.name.includes('swagger') ||
      file.name.endsWith('.json') ||
      file.name.endsWith('.yaml') ||
      file.name.endsWith('.yml') ||
      file.name.endsWith('.raml') ||
      file.name.endsWith('.proto') ||
      file.name.endsWith('.avsc') ||
      file.name.endsWith('.thrift');

    if (!isOpenAPIFile) {
      setErrorMessage('Please select an OpenAPI specification file (JSON, YAML, RAML, Protobuf, Avro .avsc, or Thrift .thrift)');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      // Fetch file content
      const response = await fetch(
        `/api/sso/${selectedAccount.provider}/content?accountId=${selectedAccount.id}&repo=${selectedRepo.full_name}&path=${file.path}&branch=${selectedRepo.default_branch}`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch file content: ${response.statusText}`);
      }

      const data = await response.json();
      await processOpenAPIContent(
        data.content,
        `${selectedAccount.provider}:${selectedRepo.full_name}/${file.path}`
      );
    } catch (error: any) {
      setErrorMessage(`Failed to load file: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      handleFileSelect(droppedFile);
    }
  }, []);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      handleFileSelect(selectedFile);
    }
  };

  const toggleClassSelection = (index: number) => {
    const updatedClasses = [...classes];
    const cls = updatedClasses[index];

    // Don't allow selecting unsupported classes
    if (!cls.isSupported) {
      return;
    }

    updatedClasses[index].selected = !updatedClasses[index].selected;
    setClasses(updatedClasses);
  };

  const handleImport = async () => {
    if (!projectName.trim()) {
      setErrorMessage('Project name is required');
      return;
    }

    if (!projectSlug.trim()) {
      setErrorMessage('Project slug is required');
      return;
    }

    if (!versionId.trim()) {
      setErrorMessage('Version ID is required');
      return;
    }

    const selectedClasses = classes.filter(c => c.selected);
    const hasPaths = parsedPaths.length > 0;
    const hasSecuritySchemes = parsedSecuritySchemes.length > 0;

    if (selectedClasses.length === 0 && !hasPaths && !hasSecuritySchemes) {
      setErrorMessage('Select at least one class to import, or ensure the spec has paths or security schemes.');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      const result = await importProjectFromOpenAPI(
        tenantId,
        userId,
        projectName,
        projectSlug,
        projectDescription || null,
        versionId,
        versionDescription || null,
        selectedClasses,
        {
          paths: hasPaths ? parsedPaths : undefined,
          securitySchemes: hasSecuritySchemes ? parsedSecuritySchemes : undefined,
          servers: parsedServers.length > 0 ? parsedServers : undefined,
        }
      );

      const response = JSON.parse(result);

      if (response.success) {
        resetDialog();
        onClose();
        onSuccess();
      } else {
        setErrorMessage(response.error || 'Failed to import project');
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'An error occurred during import');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    if (!isLoading) {
      resetDialog();
      onClose();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-[10001]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[10002] w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col bg-white dark:bg-gray-900 rounded-xl shadow-xl"
        >
          <div className="p-4 border-b border-slate-200 dark:border-slate-700 shrink-0">
            <Dialog.Title className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {step === 'upload' && 'Import from OpenAPI Specification'}
              {step === 'review' && 'Select Classes to Import'}
              {step === 'summary' && 'Review Import Summary'}
              {step === 'details' && 'Project Details'}
            </Dialog.Title>
          </div>

          <div className="p-4 overflow-auto flex-1 min-h-0">
        {errorMessage && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 text-sm">
            {errorMessage}
          </div>
        )}

        {/* Upload Step */}
        {step === 'upload' && (
          <div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              Import an OpenAPI 3.x specification from a file, URL, or your connected SSO accounts.
            </p>

            <Tabs.Root value={importMethod} onValueChange={(v) => { setImportMethod(v as any); setErrorMessage(''); }} className="mb-6">
              <Tabs.List className={cn(TAB_LIST_CLASS, 'mb-4')}>
                <Tabs.Trigger value="file" className={tabTriggerRadixClass()}>
                  <Upload size={20} /> File Upload
                </Tabs.Trigger>
                <Tabs.Trigger value="url" className={tabTriggerRadixClass()}>
                  <Link2 size={20} /> From URL
                </Tabs.Trigger>
                <Tabs.Trigger value="sso" className={tabTriggerRadixClass()} disabled={linkedAccounts.length === 0}>
                  <Globe size={20} /> From SSO
                </Tabs.Trigger>
              </Tabs.List>

            {/* File Upload Tab */}
            {importMethod === 'file' && (
              <Tabs.Content value="file" className="mt-0">
              <div>
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all ${
                    isDragging ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'border-slate-300 dark:border-slate-600 hover:border-indigo-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                  onClick={() => document.getElementById('openapi-file-input')?.click()}
                >
                  {file ? (
                    <div>
                      <FileJson size={48} className="mx-auto mb-4 text-green-600" />
                      <p className="text-lg font-semibold mb-1">{file.name}</p>
                      <p className="text-sm text-slate-500">Click to select a different file</p>
                    </div>
                  ) : (
                    <div>
                      <Upload size={48} className="mx-auto mb-4 text-slate-400" />
                      <p className="text-lg font-semibold mb-1">Drag & Drop or Click to Select</p>
                      <p className="text-sm text-slate-500">OpenAPI 3.x JSON or YAML specification file</p>
                    </div>
                  )}
                </div>

                <input
                  id="openapi-file-input"
                  type="file"
                  accept=".json,.yaml,.yml,.graphql,.gql,.raml,.proto,.avsc,.thrift"
                  className="hidden"
                  onChange={handleFileInputChange}
                />
              </div>
              </Tabs.Content>
            )}

            {/* URL Import Tab */}
            {importMethod === 'url' && (
              <Tabs.Content value="url" className="mt-0">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">OpenAPI Specification URL</label>
                <input
                  type="url"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 mb-2"
                  placeholder="https://example.com/api/openapi.json"
                  value={urlInput}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrlInput(e.target.value)}
                  disabled={isLoading}
                />
                <p className="text-xs text-slate-500 mb-4">Enter the URL of a publicly accessible OpenAPI specification file</p>

                <div className="mb-4 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 text-sm">
                  <p><strong>Examples:</strong></p>
                  <p className="mt-2 text-xs">
                    • GitHub Raw: https://raw.githubusercontent.com/user/repo/main/openapi.json<br />
                    • GitLab Raw: https://gitlab.com/user/repo/-/raw/main/openapi.json<br />
                    • Direct URL: https://api.example.com/openapi.json
                  </p>
                </div>

                <button
                  type="button"
                  className="w-full py-2 px-4 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
                  onClick={handleUrlImport}
                  disabled={!urlInput.trim() || isLoading}
                >
                  {isLoading ? <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Link2 size={20} />}
                  {isLoading ? 'Fetching...' : 'Import from URL'}
                </button>
              </div>
              </Tabs.Content>
            )}

            {/* SSO Import Tab */}
            {importMethod === 'sso' && (
              <Tabs.Content value="sso" className="mt-0">
              <Box>
                {linkedAccounts.length === 0 ? (
                  <Alert severity="info">
                    <Typography variant="body2">
                      No linked accounts found. Please link an account from the{' '}
                      <a href="/ade/dashboard/linked-accounts" target="_blank" rel="noopener noreferrer">
                        Linked Accounts
                      </a>{' '}
                      page to import from SSO sources.
                    </Typography>
                  </Alert>
                ) : (
                  /* macOS Finder Column View - Dark Mode Compatible */
                  <Box sx={{
                    display: 'flex',
                    height: 500,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: '6px',
                    overflow: 'hidden',
                    bgcolor: 'background.paper'
                  }}>
                    {/* Column 1: Accounts */}
                    <Box sx={{
                      width: '33.33%',
                      minWidth: 200,
                      maxWidth: 300,
                      borderRight: 1,
                      borderColor: 'divider',
                      display: 'flex',
                      flexDirection: 'column',
                      minHeight: 0
                    }}>
                      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                        {linkedAccounts.map((account) => {
                          const getProviderIcon = (provider: string) => {
                            switch (provider.toLowerCase()) {
                              case 'github':
                                return <SiGithub size={16} />;
                              case 'gitlab':
                                return <SiGitlab size={16} />;
                              case 'google':
                                return <SiGoogle size={16} />;
                              case 'aws':
                                return <SiAmazon size={16} />;
                              default:
                                return <Globe size={16} />;
                            }
                          };

                          const isSelected = selectedAccount?.id === account.id;

                          return (
                            <Box
                              key={account.id}
                              onClick={() => !isLoading && handleSelectAccount(account)}
                              sx={{
                                px: 1.5,
                                py: 0.75,
                                cursor: isLoading ? 'default' : 'pointer',
                                bgcolor: isSelected ? 'primary.main' : 'transparent',
                                color: isSelected ? 'primary.contrastText' : 'text.primary',
                                borderBottom: 1,
                                borderColor: 'divider',
                                '&:hover': {
                                  bgcolor: isSelected ? 'primary.dark' : 'action.hover'
                                },
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1
                              }}
                            >
                              <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', opacity: isSelected ? 1 : 0.7 }}>
                                {getProviderIcon(account.provider)}
                              </Box>
                              <Box sx={{ flex: 1, minWidth: 0 }}>
                                <Typography variant="body2" sx={{ fontSize: '13px', fontWeight: 400 }} noWrap>
                                  {account.provider.charAt(0).toUpperCase() + account.provider.slice(1)}
                                </Typography>
                                <Typography variant="caption" sx={{ fontSize: '11px', opacity: isSelected ? 0.9 : 0.6 }} noWrap>
                                  {account.provider_username || account.provider_email}
                                </Typography>
                              </Box>
                            </Box>
                          );
                        })}
                      </Box>
                    </Box>

                    {/* Column 2: Repositories */}
                    <Box sx={{
                      width: '33.33%',
                      minWidth: 200,
                      maxWidth: 300,
                      borderRight: 1,
                      borderColor: 'divider',
                      display: 'flex',
                      flexDirection: 'column',
                      minHeight: 0
                    }}>
                      {/* Search Box */}
                      {selectedAccount && repositories.length > 0 && (
                        <Box sx={{
                          p: 1,
                          borderBottom: 1,
                          borderColor: 'divider',
                          flexShrink: 0
                        }}>
                          <TextField
                            size="small"
                            placeholder="Search repositories..."
                            value={repoSearchQuery}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRepoSearchQuery(e.target.value)}
                            fullWidth
                            InputProps={{
                              startAdornment: <Search size={16} style={{ marginRight: 8, opacity: 0.6 }} />,
                            }}
                            sx={{
                              '& .MuiOutlinedInput-root': {
                                fontSize: '13px',
                                '& input': {
                                  py: 0.75,
                                }
                              }
                            }}
                          />
                        </Box>
                      )}

                      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                        {!selectedAccount ? (
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', p: 2 }}>
                            <Typography variant="body2" sx={{ fontSize: '13px', color: 'text.secondary' }} textAlign="center">
                              Select an account
                            </Typography>
                          </Box>
                        ) : isLoading && repositories.length === 0 ? (
                          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                            <CircularProgress size={24} />
                          </Box>
                        ) : repositories.length === 0 ? (
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', p: 2 }}>
                            <Typography variant="body2" sx={{ fontSize: '13px', color: 'text.secondary' }} textAlign="center">
                              No repositories
                            </Typography>
                          </Box>
                        ) : (() => {
                          // Filter repositories based on search query
                          const filteredRepos = repositories.filter((repo: any) =>
                            repo.name.toLowerCase().includes(repoSearchQuery.toLowerCase()) ||
                            (repo.description && repo.description.toLowerCase().includes(repoSearchQuery.toLowerCase()))
                          );

                          if (filteredRepos.length === 0) {
                            return (
                              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', p: 2 }}>
                                <Typography variant="body2" sx={{ fontSize: '13px', color: 'text.secondary' }} textAlign="center">
                                  No repositories match "{repoSearchQuery}"
                                </Typography>
                              </Box>
                            );
                          }

                          return filteredRepos.map((repo: any) => {
                            const isSelected = selectedRepo?.id === repo.id;
                            return (
                              <Box
                                key={repo.id}
                                onClick={() => !isLoading && handleSelectRepo(repo)}
                                sx={{
                                  px: 1.5,
                                  py: 0.75,
                                  cursor: isLoading ? 'default' : 'pointer',
                                  bgcolor: isSelected ? 'primary.main' : 'transparent',
                                  color: isSelected ? 'primary.contrastText' : 'text.primary',
                                  borderBottom: 1,
                                  borderColor: 'divider',
                                  '&:hover': {
                                    bgcolor: isSelected ? 'primary.dark' : 'action.hover'
                                  }
                                }}
                              >
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <Typography variant="body2" sx={{ fontSize: '13px', fontWeight: 400, flex: 1 }} noWrap>
                                    {repo.name}
                                  </Typography>
                                  {repo.private && (
                                    <Lock size={12} style={{ flexShrink: 0, opacity: isSelected ? 0.9 : 0.6 }} />
                                  )}
                                </Box>
                                {repo.description && (
                                  <Typography variant="caption" sx={{ fontSize: '11px', opacity: isSelected ? 0.9 : 0.6, display: 'block' }} noWrap>
                                    {repo.description}
                                  </Typography>
                                )}
                              </Box>
                            );
                          });
                        })()}
                      </Box>
                    </Box>

                    {/* Column 3: Files */}
                    <Box sx={{
                      flex: 1,
                      minWidth: 200,
                      display: 'flex',
                      flexDirection: 'column',
                      minHeight: 0
                    }}>
                      {currentPath && (
                        <Box sx={{
                          px: 1.5,
                          py: 0.5,
                          borderBottom: 1,
                          borderColor: 'divider',
                          bgcolor: 'action.hover',
                          flexShrink: 0,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1
                        }}>
                          <IconButton
                            onClick={() => {
                              const parentPath = currentPath.split('/').slice(0, -1).join('/');
                              handleNavigateToPath(parentPath);
                            }}
                            disabled={isLoading}
                            size="small"
                            sx={{
                              p: 0.25,
                              '&:hover': {
                                bgcolor: 'action.selected'
                              }
                            }}
                          >
                            <ArrowLeft size={14} />
                          </IconButton>
                          <Typography variant="caption" sx={{ fontSize: '11px', color: 'text.secondary' }} noWrap>
                            /{currentPath}
                          </Typography>
                        </Box>
                      )}
                      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                        {!selectedRepo ? (
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', p: 2 }}>
                            <Typography variant="body2" sx={{ fontSize: '13px', color: 'text.secondary' }} textAlign="center">
                              Select a repository
                            </Typography>
                          </Box>
                        ) : isLoading && repoFiles.length === 0 ? (
                          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                            <CircularProgress size={24} />
                          </Box>
                        ) : repoFiles.length === 0 ? (
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', p: 2 }}>
                            <Typography variant="body2" sx={{ fontSize: '13px', color: 'text.secondary' }} textAlign="center">
                              No files
                            </Typography>
                          </Box>
                        ) : (
                          repoFiles.map((file: any, idx: number) => {
                            const isOpenAPIFile =
                              file.name.includes('openapi') ||
                              file.name.includes('swagger') ||
                              file.name.endsWith('.json') ||
                              file.name.endsWith('.yaml') ||
                              file.name.endsWith('.yml') ||
                              file.name.endsWith('.raml') ||
                              file.name.endsWith('.proto') ||
                              file.name.endsWith('.avsc') ||
                              file.name.endsWith('.thrift');

                            return (
                              <Box
                                key={idx}
                                onClick={() => !isLoading && handleSelectFile(file)}
                                sx={{
                                  px: 1.5,
                                  py: 0.75,
                                  cursor: isLoading ? 'default' : 'pointer',
                                  borderBottom: 1,
                                  borderColor: 'divider',
                                  '&:hover': {
                                    bgcolor: 'action.hover'
                                  },
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 1
                                }}
                              >
                                {file.type === 'dir' ? (
                                  <FolderOpen size={16} color="#94a3b8" />
                                ) : (
                                  <File size={16} color={isOpenAPIFile ? '#22c55e' : '#94a3b8'} />
                                )}
                                <Typography variant="body2" sx={{ fontSize: '13px', fontWeight: 400, color: 'text.primary' }} noWrap>
                                  {file.name}
                                </Typography>
                              </Box>
                            );
                          })
                        )}
                      </Box>
                    </Box>
                  </Box>
                )}
              </Box>
              </Tabs.Content>
            )}
            </Tabs.Root>
          </div>
        )}

        {/* Review Step */}
        {step === 'review' && (
          <Box>
            {openAPIInfo && (
              <Box sx={{ mb: 2, p: 2, bgcolor: 'background.default', borderRadius: 1 }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  OpenAPI Specification
                </Typography>
                <Typography variant="body2">
                  <strong>{openAPIInfo.title}</strong> {openAPIInfo.version && `v${openAPIInfo.version}`}
                </Typography>
                {openAPIInfo.description && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    {openAPIInfo.description}
                  </Typography>
                )}
                {openAPIInfo.source && (
                  <Chip
                    label={openAPIInfo.source}
                    size="small"
                    sx={{ mt: 1 }}
                    icon={openAPIInfo.source.startsWith('URL:') ? <Link2 size={14} /> : <FileJson size={14} />}
                  />
                )}
              </Box>
            )}

            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Select the classes you want to import. Unsupported classes (shown in gray below) cannot be imported.
            </Typography>

            <Box sx={{ maxHeight: 400, overflowY: 'auto' }}>
              {classes.map((cls, index) => (
                <Box
                  key={index}
                  sx={{
                    mb: 2,
                    p: 2,
                    border: 1,
                    borderColor: !cls.isSupported ? 'error.main' : (cls.selected ? 'primary.main' : 'grey.300'),
                    borderRadius: 1,
                    backgroundColor: !cls.isSupported ? 'grey.100' : (cls.selected ? 'action.selected' : 'background.paper'),
                    opacity: !cls.isSupported ? 0.6 : 1
                  }}
                >
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={cls.selected}
                        onChange={() => toggleClassSelection(index)}
                        disabled={!cls.isSupported}
                      />
                    }
                    label={
                      <Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="subtitle1" fontWeight="bold" color={!cls.isSupported ? 'text.disabled' : 'text.primary'}>
                            {cls.name}
                          </Typography>
                          {!cls.isSupported && (
                            <Chip
                              label="Not Supported"
                              size="small"
                              color="error"
                              sx={{ height: 20 }}
                            />
                          )}
                        </Box>
                        {cls.description && (
                          <Typography variant="body2" color="text.secondary">
                            {cls.description}
                          </Typography>
                        )}
                      </Box>
                    }
                  />

                  {cls.warnings.length > 0 && (
                    <Box sx={{ mt: 1, ml: 4, p: 1.5, bgcolor: 'warning.lighter', borderRadius: 1 }}>
                      {cls.warnings.map((warning, wIdx) => {
                        // Split warning into main message and suggestions
                        const parts = warning.split('\n\n💡 Suggested fix:\n');
                        const mainMessage = parts[0];
                        const suggestions = parts[1];

                        return (
                          <Box key={wIdx} sx={{ mb: wIdx < cls.warnings.length - 1 ? 1.5 : 0 }}>
                            <Box sx={{ display: 'flex', alignItems: 'start', gap: 0.5, mb: suggestions ? 1 : 0 }}>
                              <AlertCircle size={14} style={{ marginTop: 2, flexShrink: 0, color: '#f59e0b' }} />
                              <Typography variant="caption" color="warning.dark">
                                {mainMessage}
                              </Typography>
                            </Box>
                            {suggestions && (
                              <Box sx={{ ml: 2.5, mt: 1, p: 1, bgcolor: 'background.paper', borderRadius: 0.5, borderLeft: '2px solid #3b82f6' }}>
                                <Typography variant="caption" color="primary.dark" fontWeight="bold" sx={{ display: 'block', mb: 0.5 }}>
                                  💡 Suggested fix:
                                </Typography>
                                <Box component="pre" sx={{
                                  m: 0,
                                  fontFamily: 'monospace',
                                  fontSize: '0.7rem',
                                  color: 'text.secondary',
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word'
                                }}>
                                  {suggestions}
                                </Box>
                              </Box>
                            )}
                          </Box>
                        );
                      })}
                    </Box>
                  )}

                  <Box sx={{ mt: 1, ml: 4 }}>
                    <Typography variant="caption" color="text.secondary">
                      Properties ({cls.properties.length}):
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                      {cls.properties.slice(0, 10).map((prop, propIndex) => (
                        <Chip
                          key={propIndex}
                          label={prop.name}
                          size="small"
                          variant="outlined"
                        />
                      ))}
                      {cls.properties.length > 10 && (
                        <Chip
                          label={`+${cls.properties.length - 10} more`}
                          size="small"
                          variant="outlined"
                        />
                      )}
                    </Box>
                  </Box>
                </Box>
              ))}
            </Box>

          </Box>
        )}

        {/* Summary Step */}
        {step === 'summary' && (
          <Box>
            {(() => {
              const stats = calculateImportStats();
              const selectedClasses = classes.filter(c => c.isSupported && c.selected);

              return (
                <>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    Review the summary of what will be imported from your OpenAPI specification.
                  </Typography>

                  {/* Main Statistics Card */}
                  <Box sx={{ mb: 3, p: 3, bgcolor: 'success.lighter', borderRadius: 2, border: '1px solid', borderColor: 'success.light' }}>
                    <Typography variant="h6" fontWeight="bold" color="success.dark" gutterBottom>
                      📊 Import Summary
                    </Typography>
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 3, mt: 2 }}>
                      <Box>
                        <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
                          Classes to Import
                        </Typography>
                        <Typography variant="h4" color="success.dark">
                          {stats.totalClasses}
                        </Typography>
                        {stats.unsupportedClasses > 0 && (
                          <Typography variant="caption" color="text.secondary">
                            ({stats.supportedClasses} available, {stats.unsupportedClasses} unsupported)
                          </Typography>
                        )}
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
                          Total Properties
                        </Typography>
                        <Typography variant="h4" color="success.dark">
                          {stats.totalProperties}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          ({stats.uniqueProperties} unique, {stats.sharedProperties} shared)
                        </Typography>
                      </Box>
                      {(parsedPaths.length > 0 || parsedSecuritySchemes.length > 0) && (
                        <>
                          {parsedPaths.length > 0 && (
                            <Box>
                              <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
                                Paths
                              </Typography>
                              <Typography variant="h4" color="success.dark">
                                {parsedPaths.length}
                              </Typography>
                            </Box>
                          )}
                          {parsedSecuritySchemes.length > 0 && (
                            <Box>
                              <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
                                Security Schemes
                              </Typography>
                              <Typography variant="h4" color="success.dark">
                                {parsedSecuritySchemes.length}
                              </Typography>
                            </Box>
                          )}
                        </>
                      )}
                    </Box>
                    {stats.sharedProperties > 0 && (
                      <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'success.main' }}>
                        <Typography variant="body2" color="success.dark">
                          💡 <strong>{stats.sharedProperties}</strong> propert{stats.sharedProperties !== 1 ? 'ies' : 'y'} will be reused across multiple classes, reducing duplication and maintaining consistency.
                        </Typography>
                      </Box>
                    )}
                  </Box>

                  {/* Selected Classes List */}
                  <Box sx={{ mb: 3 }}>
                    <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
                      Selected Classes ({selectedClasses.length})
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                      {selectedClasses.map((cls, idx) => (
                        <Chip
                          key={idx}
                          label={`${cls.name} (${cls.properties.length})`}
                          color="primary"
                          variant="outlined"
                        />
                      ))}
                    </Box>
                  </Box>

                  {/* Warnings Section */}
                  {warnings.length > 0 && (
                    <Alert severity="warning">
                      <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
                        ⚠️ {warnings.length} class{warnings.length !== 1 ? 'es' : ''} cannot be imported
                      </Typography>
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        The following classes have issues that prevent them from being imported:
                      </Typography>
                      <Box sx={{ maxHeight: 150, overflowY: 'auto', mt: 1 }}>
                        {warnings.map((warning, idx) => {
                          const className = warning.split(':')[0];
                          const reason = warning.substring(warning.indexOf(':') + 1).trim();
                          const shortReason = reason.split('.')[0] + '.';

                          return (
                            <Box key={idx} sx={{
                              mb: 1,
                              p: 1,
                              bgcolor: 'background.paper',
                              borderRadius: 1,
                              borderLeft: '3px solid',
                              borderLeftColor: 'warning.main'
                            }}>
                              <Typography variant="body2" fontWeight="bold" color="text.primary">
                                {className}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {shortReason}
                              </Typography>
                            </Box>
                          );
                        })}
                      </Box>
                    </Alert>
                  )}

                  {/* OpenAPI Info */}
                  {openAPIInfo && (
                    <Box sx={{ mt: 3, p: 2, bgcolor: 'background.default', borderRadius: 1 }}>
                      <Typography variant="caption" color="text.secondary" display="block">
                        Source Specification
                      </Typography>
                      <Typography variant="body2" fontWeight="bold">
                        {openAPIInfo.title} {openAPIInfo.version && `v${openAPIInfo.version}`}
                      </Typography>
                    </Box>
                  )}
                </>
              );
            })()}
          </Box>
        )}

        {/* Details Step */}
        {step === 'details' && (
          <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Provide project and version details for the import.
            </Typography>

            <TextField
              autoFocus
              margin="dense"
              label="Project Name"
              type="text"
              fullWidth
              variant="outlined"
              value={projectName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setProjectName(e.target.value);
                if (!projectSlug || projectSlug === generateSlug(projectName)) {
                  setProjectSlug(generateSlug(e.target.value));
                }
              }}
              disabled={isLoading}
              required
              sx={{ mb: 2 }}
            />

            <TextField
              margin="dense"
              label="Project Slug"
              type="text"
              fullWidth
              variant="outlined"
              value={projectSlug}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProjectSlug(filterSlugInput(e.target.value))}
              disabled={isLoading}
              required
              helperText="URL-friendly identifier (lowercase letters, numbers, and dashes only)"
              sx={{ mb: 2 }}
            />

            <TextField
              margin="dense"
              label="Project Description"
              type="text"
              fullWidth
              variant="outlined"
              multiline
              rows={3}
              value={projectDescription}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setProjectDescription(e.target.value)}
              disabled={isLoading}
              sx={{ mb: 2 }}
            />

            <TextField
              margin="dense"
              label="Initial Version ID"
              type="text"
              fullWidth
              variant="outlined"
              value={versionId}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVersionId(e.target.value)}
              disabled={isLoading}
              required
              helperText="Semantic version (e.g., 1.0.0)"
              sx={{ mb: 2 }}
            />

            <TextField
              margin="dense"
              label="Version Description"
              type="text"
              fullWidth
              variant="outlined"
              multiline
              rows={2}
              value={versionDescription}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setVersionDescription(e.target.value)}
              disabled={isLoading}
            />

            <Box sx={{ mt: 2, p: 2, bgcolor: 'success.lighter', borderRadius: 1 }}>
              <Typography variant="body2" color="success.dark">
                <CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                {classes.filter(c => c.selected).length} classes will be imported
              </Typography>
            </Box>
          </Box>
        )}
          </div>

          <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2 shrink-0">
            <Button onClick={handleClose} disabled={isLoading}>Cancel</Button>
            {step === 'upload' && (
              <Button
                onClick={() => {
                  if (importMethod === 'file' && file) setStep('review');
                  else if (importMethod === 'url') handleUrlImport();
                }}
                variant="contained"
                disabled={(importMethod === 'file' && !file) || (importMethod === 'url' && !urlInput.trim()) || (importMethod === 'sso') || isLoading}
              >
                {isLoading ? 'Loading...' : importMethod === 'file' ? 'Next' : 'Import'}
              </Button>
            )}
            {step === 'review' && (
              <>
                <Button onClick={() => setStep('upload')} disabled={isLoading}>Back</Button>
                <Button onClick={() => setStep('summary')} variant="contained" disabled={(classes.filter(c => c.selected).length === 0 && parsedPaths.length === 0 && parsedSecuritySchemes.length === 0) || isLoading}>Next</Button>
              </>
            )}
            {step === 'summary' && (
              <>
                <Button onClick={() => setStep('review')} disabled={isLoading}>Back</Button>
                <Button onClick={() => setStep('details')} variant="contained" disabled={isLoading}>Continue to Project Details</Button>
              </>
            )}
            {step === 'details' && (
              <>
                <Button onClick={() => setStep('summary')} disabled={isLoading}>Back</Button>
                <Button onClick={handleImport} variant="contained" disabled={isLoading}>{isLoading ? 'Importing...' : 'Import Project'}</Button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default OpenAPIImportDialog;

