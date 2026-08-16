'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import * as Dialog from '@radix-ui/react-dialog';
import { FileCode } from 'lucide-react';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export interface SchemaViewModalProps {
  open: boolean;
  onClose: () => void;
  className: string;
  schema: Record<string, unknown> | null;
  loading?: boolean;
  error?: string | null;
}

export default function SchemaViewModal({
  open,
  onClose,
  className,
  schema,
  loading = false,
  error = null,
}: SchemaViewModalProps) {
  const normalizedSchema = React.useMemo(() => {
    if (schema == null) return null;
    if (typeof schema === 'string') {
      try {
        return JSON.parse(schema) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return schema;
  }, [schema]);

  const jsonText =
    normalizedSchema != null
      ? JSON.stringify(normalizedSchema, null, 2)
      : '';

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-4xl max-h-[90vh] min-h-[600px] flex flex-col rounded-lg bg-white dark:bg-gray-800 shadow-lg border border-gray-200 dark:border-gray-700 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white p-6 pb-2 flex items-center gap-2 shrink-0">
            <FileCode className="w-5 h-5 text-indigo-500" />
            JSON Schema — {className}
          </Dialog.Title>
          <Dialog.Description className="px-6 text-sm text-gray-500 dark:text-gray-400 shrink-0">
            Class schema definition for validation and insert form.
          </Dialog.Description>
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col p-6 pt-3">
            {loading && (
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading schema…</p>
            )}
            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}
            {!loading && !error && normalizedSchema != null && (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <div className="flex-1 min-h-[480px] rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden bg-[#1e1e1e]">
                  <MonacoEditor
                    key={`schema-${className}`}
                    height="65vh"
                    language="json"
                    theme="vs-dark"
                    value={jsonText}
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      fontSize: CODE_EDITOR_FONT_SIZE,
                      wordWrap: 'on',
                    }}
                  />
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 p-6 pt-2 border-t border-gray-200 dark:border-gray-700">
            <Dialog.Close asChild>
              <button
                type="button"
                className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
