'use client';

import * as React from 'react';
import { useAuthSession } from '@lib/auth/session-client';
import { Check } from 'lucide-react';
import * as Select from '@radix-ui/react-select';
import { useMigration } from '../MigrationContext';
import RevisionDeprecationBanner from '@/app/components/ade/RevisionDeprecationBanner';
import { isRevisionDeprecated } from '@/app/utils/revision-deprecation';
import { formatVersionSelectorLabel } from '@/app/utils/version-display';

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface Version {
  id: string;
  version_id: string;
  description?: string | null;
  shortMessage?: string | null;
  published: boolean;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

export default function MigrationHeader() {
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;
  const {
    selectedProjectId,
    setSelectedProjectId,
    fromVersionId,
    setFromVersionId,
    toVersionId,
    setToVersionId,
  } = useMigration();

  const [projects, setProjects] = React.useState<Project[]>([]);
  const [versions, setVersions] = React.useState<Version[]>([]);
  const [localProjectId, setLocalProjectId] = React.useState<string>(selectedProjectId || '');
  const [localFromVersionId, setLocalFromVersionId] = React.useState<string>(fromVersionId || '');
  const [localToVersionId, setLocalToVersionId] = React.useState<string>(toVersionId || '');
  const [isLoadingProjects, setIsLoadingProjects] = React.useState(false);
  const [isLoadingVersions, setIsLoadingVersions] = React.useState(false);

  React.useEffect(() => {
    if (selectedProjectId !== localProjectId) setLocalProjectId(selectedProjectId || '');
    if (fromVersionId !== localFromVersionId) setLocalFromVersionId(fromVersionId || '');
    if (toVersionId !== localToVersionId) setLocalToVersionId(toVersionId || '');
  }, [selectedProjectId, fromVersionId, toVersionId]);

  React.useEffect(() => {
    if (!currentTenantId) {
      setProjects([]);
      return;
    }
    let cancelled = false;
    setIsLoadingProjects(true);
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success && data.projects) setProjects(data.projects);
        else setProjects([]);
      })
      .catch(() => { if (!cancelled) setProjects([]); })
      .finally(() => { if (!cancelled) setIsLoadingProjects(false); });
    return () => { cancelled = true; };
  }, [currentTenantId]);

  React.useEffect(() => {
    if (!localProjectId) {
      setVersions([]);
      return;
    }
    let cancelled = false;
    setIsLoadingVersions(true);
    fetch(`/api/versions?projectId=${localProjectId}`)
      .then((r) => r.json())
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.versions) {
          const list = result.versions as Version[];
          setVersions(list);
        } else {
          setVersions([]);
        }
      })
      .catch(() => { if (!cancelled) setVersions([]); })
      .finally(() => { if (!cancelled) setIsLoadingVersions(false); });
    return () => { cancelled = true; };
  }, [localProjectId]);

  const handleProjectChange = (value: string) => {
    setLocalProjectId(value);
    setSelectedProjectId(value);
    setLocalFromVersionId('');
    setLocalToVersionId('');
    setFromVersionId(null);
    setToVersionId(null);
  };

  const handleFromVersionChange = (value: string) => {
    setLocalFromVersionId(value);
    setFromVersionId(value);
  };

  const handleToVersionChange = (value: string) => {
    setLocalToVersionId(value);
    setToVersionId(value);
  };

  const versionOptionLabel = (version: Version) => formatVersionSelectorLabel(version);

  const fromVer = versions.find((x) => x.id === localFromVersionId);
  const toVer = versions.find((x) => x.id === localToVersionId);

  if (!currentTenantId) return null;

  return (
    <div
      className="bg-gradient-to-r from-white via-slate-50 to-white dark:from-gray-800 dark:via-gray-800 dark:to-gray-800 border-b border-gray-200/80 dark:border-gray-700/80 px-2 py-1.5 shadow-sm"
      /*
       * In flow, not fixed. The `top: 48` this used to carry cleared the pre-Hive
       * `TopHeader`, retired in HIVE-3.8 (#5294); the toolbar is now the first row of its
       * layout's flex column. `position: relative` is kept only to hold the stacking
       * context its own control popovers are numbered against.
       */
      style={{ position: 'relative', zIndex: 1000, flexShrink: 0 }}
    >
      <div className="flex flex-wrap items-center gap-4 w-full">
        <div className="flex items-center gap-2" style={{ position: 'relative', zIndex: 1001 }}>
          <Select.Root
            value={localProjectId}
            onValueChange={handleProjectChange}
            disabled={isLoadingProjects || !currentTenantId}
          >
            <Select.Trigger className="inline-flex items-center gap-2 bg-white dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 shadow-sm px-3 py-2 text-sm text-gray-900 dark:text-white hover:border-indigo-300 dark:hover:border-indigo-500/50 min-w-[220px] disabled:opacity-50 disabled:cursor-not-allowed">
              <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <Select.Value placeholder="Select project..." />
              <Select.Icon className="ml-auto">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content className="overflow-hidden bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-[9999]" position="popper" sideOffset={5}>
                <Select.Viewport className="p-1">
                  {projects.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No projects available</div>
                  ) : (
                    projects.map((project) => (
                      <Select.Item
                        key={project.id}
                        value={project.id}
                        className="relative flex items-center px-8 py-2 text-sm text-gray-700 dark:text-gray-300 rounded-md outline-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 data-[highlighted]:bg-gray-100 dark:data-[highlighted]:bg-gray-700 data-[state=checked]:bg-indigo-50 dark:data-[state=checked]:bg-indigo-900/30"
                      >
                        <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                          <Check className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                        </Select.ItemIndicator>
                        <Select.ItemText>{project.name}</Select.ItemText>
                      </Select.Item>
                    ))
                  )}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
        <div className="flex items-center gap-2" style={{ position: 'relative', zIndex: 1001 }}>
          <Select.Root
            value={localFromVersionId}
            onValueChange={handleFromVersionChange}
            disabled={isLoadingVersions || !localProjectId || versions.length === 0}
          >
            <Select.Trigger className="inline-flex items-center gap-2 bg-white dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 shadow-sm px-3 py-2 text-sm text-gray-900 dark:text-white hover:border-indigo-300 dark:hover:border-indigo-500/50 min-w-[220px] disabled:opacity-50 disabled:cursor-not-allowed">
              <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <Select.Value placeholder="Select version..." />
              <Select.Icon className="ml-auto">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content className="overflow-hidden bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-[9999]" position="popper" sideOffset={5}>
                <Select.Viewport className="p-1">
                  {versions.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No versions available</div>
                  ) : (
                    versions.map((version) => (
                      <Select.Item
                        key={version.id}
                        value={version.id}
                        className="relative flex items-center px-8 py-2 text-sm text-gray-700 dark:text-gray-300 rounded-md outline-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 data-[highlighted]:bg-gray-100 dark:data-[highlighted]:bg-gray-700 data-[state=checked]:bg-indigo-50 dark:data-[state=checked]:bg-indigo-900/30"
                      >
                        <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                          <Check className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                        </Select.ItemIndicator>
                        <Select.ItemText>{versionOptionLabel(version)}</Select.ItemText>
                      </Select.Item>
                    ))
                  )}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
        <div className="flex items-center gap-2" style={{ position: 'relative', zIndex: 1001 }}>
          <span className="text-sm font-medium text-gray-600 dark:text-gray-400 shrink-0" aria-hidden>→</span>
          <Select.Root
            value={localToVersionId}
            onValueChange={handleToVersionChange}
            disabled={isLoadingVersions || !localProjectId || versions.length === 0}
          >
            <Select.Trigger className="inline-flex items-center gap-2 bg-white dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600 shadow-sm px-3 py-2 text-sm text-gray-900 dark:text-white hover:border-indigo-300 dark:hover:border-indigo-500/50 min-w-[220px] disabled:opacity-50 disabled:cursor-not-allowed">
              <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <Select.Value placeholder="Select version..." />
              <Select.Icon className="ml-auto">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content className="overflow-hidden bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-[9999]" position="popper" sideOffset={5}>
                <Select.Viewport className="p-1">
                  {versions.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No versions available</div>
                  ) : (
                    versions.map((version) => (
                      <Select.Item
                        key={version.id}
                        value={version.id}
                        className="relative flex items-center px-8 py-2 text-sm text-gray-700 dark:text-gray-300 rounded-md outline-none cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 data-[highlighted]:bg-gray-100 dark:data-[highlighted]:bg-gray-700 data-[state=checked]:bg-indigo-50 dark:data-[state=checked]:bg-indigo-900/30"
                      >
                        <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                          <Check className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                        </Select.ItemIndicator>
                        <Select.ItemText>{versionOptionLabel(version)}</Select.ItemText>
                      </Select.Item>
                    ))
                  )}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
      </div>
      {fromVer && isRevisionDeprecated(fromVer.metadata) ? (
        <RevisionDeprecationBanner
          roleLabel="From"
          versionLabel={fromVer.version_id}
          metadata={fromVer.metadata}
        />
      ) : null}
      {toVer && isRevisionDeprecated(toVer.metadata) ? (
        <RevisionDeprecationBanner
          roleLabel="To"
          versionLabel={toVer.version_id}
          metadata={toVer.metadata}
        />
      ) : null}
    </div>
  );
}
