/**
 * Shared code-viewer primitives (MFI-28.7, #4123).
 *
 * Format-neutral, monaco-backed building blocks promoted out of `ui/mcp` because the MCP screens, the
 * Catalog (MFI-28.1/28.3), the primitives editor, and future format screens all reuse them:
 *
 *   - {@link JsonViewer}     — a read-only, syntax-highlighted code block (language-configurable).
 *   - {@link JsonDiffViewer} — a read-only split/unified diff (language-configurable).
 *   - {@link Disclosure}     — a lazy-mounting collapsible wrapper for the (heavy) viewers.
 *
 * `ui/mcp` keeps thin back-compat re-exports of these under their old `Mcp*` names so the MCP screens
 * keep working unchanged.
 */
export * from './JsonViewer';
export * from './JsonDiffViewer';
export * from './Disclosure';
// Monaco's type metrics, in one place (HIVE-1.6, #5279).
export * from './editorTypography';
