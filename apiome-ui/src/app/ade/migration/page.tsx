'use client';

import { useState } from 'react';
import { useMigration } from './MigrationContext';
import { GitCompare, Info, Palette, ClipboardList, CalendarClock } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/Tabs';
import MigrationCanvas from './components/MigrationCanvas';
import DataInspectionView from './components/DataInspectionView';
import MigrationPlanView from './components/MigrationPlanView';
import MigrationSchedulerView from './components/MigrationSchedulerView';

export default function MigrationPage() {
  const { selectedProjectId, fromVersionId, toVersionId } = useMigration();
  const [activeTab, setActiveTab] = useState<'designer' | 'explorer' | 'scheduler'>('designer');

  const hasSelection = selectedProjectId && fromVersionId && toVersionId;
  const fromToSame = fromVersionId && toVersionId && fromVersionId === toVersionId;
  const showCanvas = hasSelection && !fromToSame;

  if (showCanvas) {
    return (
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'designer' | 'explorer' | 'scheduler')} className="h-full flex flex-col min-h-0">
        <TabsList className="w-full shrink-0 flex-nowrap">
          <TabsTrigger value="designer">
            <Palette className="h-4 w-4" />
            Designer
          </TabsTrigger>
          <TabsTrigger value="explorer">
            <ClipboardList className="h-4 w-4" />
            Explorer
          </TabsTrigger>
          <TabsTrigger value="scheduler">
            <CalendarClock className="h-4 w-4" />
            Scheduler
          </TabsTrigger>
        </TabsList>
        <TabsContent value="designer" className="flex-1 flex flex-col min-h-0 mt-0 data-[state=inactive]:hidden">
          <div className="flex-1 min-h-0">
            <MigrationCanvas />
          </div>
          <div className="flex-1 min-h-0">
            <DataInspectionView />
          </div>
        </TabsContent>
        <TabsContent value="explorer" className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden overflow-auto">
          <MigrationPlanView />
        </TabsContent>
        <TabsContent value="scheduler" className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden overflow-auto">
          <MigrationSchedulerView />
        </TabsContent>
      </Tabs>
    );
  }

  const title = !hasSelection
    ? 'No Project Selected'
    : fromToSame
      ? 'Choose Different Versions'
      : 'Data Migration';
  const description = !hasSelection
    ? 'Select a project, then choose the source version (from) and target version (to) in the header above to migrate data between schema versions.'
    : fromToSame
      ? '"From" and "to" versions must be different. Choose a different target version in the header above.'
      : 'Migration tools and workflows will be available here once configured.';
  const tip = !hasSelection
    ? 'Tip: Migration runs from an older (or current) schema version to a newer one; both versions must have frozen schemas.'
    : fromToSame
      ? 'Select a different "to" version to continue.'
      : 'Use the header dropdowns to change project or versions.';

  return (
    <div className="h-full flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-50 dark:from-gray-900 dark:via-gray-900 dark:to-gray-800">
      <div className="relative">
        <div className="absolute -top-20 -left-20 w-40 h-40 bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-full blur-3xl opacity-60" />
        <div className="absolute -bottom-20 -right-20 w-40 h-40 bg-gradient-to-br from-blue-100 to-cyan-100 dark:from-blue-900/20 dark:to-cyan-900/20 rounded-full blur-3xl opacity-60" />

        <div className="relative bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl border border-gray-200/50 dark:border-gray-700/50 rounded-2xl p-12 md:p-16 text-center shadow-xl shadow-gray-200/50 dark:shadow-gray-900/50">
          <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-500/25">
            <GitCompare className="h-10 w-10 text-white" />
          </div>
          <h3 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-3">
            {title}
          </h3>
          <p className="text-gray-500 dark:text-gray-400 max-w-sm mx-auto leading-relaxed">
            {description}
          </p>

          <div className="mt-8 pt-6 border-t border-gray-100 dark:border-gray-700/50">
            <p className="text-xs text-gray-400 dark:text-gray-500 flex items-center justify-center gap-2">
              <Info className="w-4 h-4" />
              {tip}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
