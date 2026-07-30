'use client';

import Link from 'next/link';
import { Waypoints } from 'lucide-react';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  formatRelativeTime,
  sourceKindLabel,
  type PrimitiveImportActivity,
} from './primitivesRegistryTypes';

interface PrimitivesRecentActivityProps {
  imports: PrimitiveImportActivity[];
  loading: boolean;
}

function activityDot(sourceKind: string) {
  if (sourceKind === 'type-def-bundle') return 'bg-teal-400';
  if (sourceKind === 'openapi') return 'bg-purple-400';
  return 'bg-sky-400';
}

export default function PrimitivesRecentActivity({ imports, loading }: PrimitivesRecentActivityProps) {
  return (
    <div className="space-y-6">
      <section className={`${dashboardPanelClass} p-5`}>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2 text-gray-900 dark:text-white">
          <Waypoints className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          Relative <span className="font-mono">$ref</span> resolution
        </h3>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
          References resolve against the type&apos;s import-source base URL in the API server.
        </p>
        <div className="rounded-lg bg-gray-900 dark:bg-black/40 p-3 font-mono text-[10px] leading-relaxed text-gray-300 overflow-x-auto">
          <span className="text-gray-500"># std/v0/types/date</span>
          <br />
          &quot;$ref&quot;: <span className="text-emerald-300">&quot;../primitives/string&quot;</span>
          <br />
          <span className="text-gray-500"># base</span> api.apiome.dev/types/
          <span className="text-indigo-300">std/v0/types/</span>
          <br />
          <span className="text-gray-500"># resolves →</span>{' '}
          <span className="text-indigo-300">std/v0/primitives/string</span>
        </div>
        <Link
          href="/ade/dashboard/primitives?focus=resolver"
          className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline mt-2 inline-block"
        >
          Open reference resolver →
        </Link>
      </section>

      <section className={`${dashboardPanelClass} p-5`}>
        <h3 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Recent activity</h3>
        {loading ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">Loading activity…</p>
        ) : imports.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">No import activity yet.</p>
        ) : (
          <ul className="space-y-3 text-xs">
            {imports.map((item) => (
              <li key={item.id} className="flex gap-2 items-start">
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${activityDot(item.source_kind)}`} />
                <div>
                  <p className="font-medium text-gray-700 dark:text-gray-300">
                    Imported{' '}
                    <span className="font-mono">{item.source_label ?? 'schema'}</span>
                    {item.imported_count > 0 ? ` (${item.imported_count} type${item.imported_count === 1 ? '' : 's'})` : ''}
                  </p>
                  <p className="text-gray-400">
                    {sourceKindLabel(item.source_kind)}
                    {item.target_namespace ? ` · ${item.target_namespace}` : ''}
                    {item.created_at ? ` · ${formatRelativeTime(item.created_at)}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
