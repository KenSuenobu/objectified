'use client';

import Link from 'next/link';
import {
  Shield,
  Building2,
  Download,
  Link2,
  AlertTriangle,
} from 'lucide-react';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import type { RegistryCoverageStats } from './primitivesRegistryTypes';

interface PrimitivesRegistryKpiStripProps {
  stats: RegistryCoverageStats | null;
  loading: boolean;
}

function KpiCard({
  label,
  value,
  subtitle,
  icon,
  valueClassName,
  href,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  valueClassName?: string;
  href?: string;
}) {
  const content = (
    <div className={`${dashboardPanelClass} p-4 h-full`}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-600 dark:text-gray-400">{label}</p>
        {icon}
      </div>
      <p className={`text-2xl font-bold mt-2 font-mono ${valueClassName ?? 'text-gray-900 dark:text-white'}`}>
        {value}
      </p>
      {subtitle ? (
        <p className="text-2xs text-gray-500 dark:text-gray-400 mt-1 font-mono">{subtitle}</p>
      ) : null}
      {href ? (
        <span className="text-2xs text-indigo-600 dark:text-indigo-400 mt-1 inline-block font-mono">
          open resolver →
        </span>
      ) : null}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block hover:opacity-90 transition-opacity">
        {content}
      </Link>
    );
  }

  return content;
}

export default function PrimitivesRegistryKpiStrip({ stats, loading }: PrimitivesRegistryKpiStripProps) {
  if (loading || !stats) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={`${dashboardPanelClass} p-4 animate-pulse h-24`} />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      <KpiCard
        label="Core system types"
        value={stats.core_type_count}
        subtitle="std/* · all tenants"
        icon={<Shield className="w-4 h-4 text-teal-500 opacity-70" />}
        valueClassName="text-indigo-600 dark:text-indigo-400"
      />
      <KpiCard
        label="Tenant types"
        value={stats.tenant_type_count}
        subtitle={`${stats.namespace_count} namespace${stats.namespace_count === 1 ? '' : 's'}`}
        icon={<Building2 className="w-4 h-4 text-emerald-500 opacity-70" />}
      />
      <KpiCard
        label="Imported schemas"
        value={stats.imported_count}
        subtitle="JSON Schema + bundles"
        icon={<Download className="w-4 h-4 text-sky-500 opacity-70" />}
      />
      <KpiCard
        label="Properties bound"
        value={stats.properties_bound_count.toLocaleString()}
        subtitle={
          stats.bound_class_count > 0
            ? `across ${stats.bound_class_count.toLocaleString()} class${stats.bound_class_count === 1 ? '' : 'es'}`
            : 'no bindings yet'
        }
        icon={<Link2 className="w-4 h-4 text-indigo-500 opacity-70" />}
      />
      <KpiCard
        label="Unresolved $ref"
        value={stats.unresolved_ref_count}
        icon={<AlertTriangle className="w-4 h-4 text-amber-500 opacity-70" />}
        valueClassName={
          stats.unresolved_ref_count > 0
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-gray-900 dark:text-white'
        }
        href={stats.unresolved_ref_count > 0 ? '/ade/dashboard/primitives?focus=resolver' : undefined}
      />
    </div>
  );
}
