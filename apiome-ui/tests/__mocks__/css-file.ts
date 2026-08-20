/**
 * Stub for a plain (non-module) stylesheet import, e.g. `import '@xyflow/react/dist/style.css'`.
 *
 * Such an import is a side effect that Next/webpack handles at build time; under Jest it would be
 * handed to the TS transformer and fail to parse. A component that pulls in a vendor stylesheet is
 * otherwise untestable, so the import resolves here to nothing at all — which is exactly what the
 * stylesheet contributes to a jsdom assertion.
 */
/** Nothing at all — a stylesheet contributes nothing to a jsdom assertion. */
const stylesheet = {};

export default stylesheet;
