'use client';

import { cn } from '@lib/utils';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';

export type ImportSourceTabId =
  | 'file'
  | 'url'
  | 'clipboard'
  | 'git'
  | 'swaggerhub'
  | 'registry';

const TABS: { id: ImportSourceTabId; label: string; disabled?: boolean }[] = [
  { id: 'file', label: 'File' },
  { id: 'url', label: 'URL' },
  { id: 'clipboard', label: 'Clipboard' },
  { id: 'git', label: 'Git' },
  { id: 'swaggerhub', label: 'SwaggerHub' },
  { id: 'registry', label: 'Registry', disabled: true },
];

const TAB_ICONS: Record<ImportSourceTabId, string> = {
  file: '📁',
  url: '🔗',
  clipboard: '📋',
  git: '🐙',
  swaggerhub: '☁️',
  registry: '📦',
};

export interface ImportSourceTabBarProps {
  active: ImportSourceTabId;
  onSelect: (id: ImportSourceTabId) => void;
  className?: string;
  /** Additional tab ids to disable (e.g. SwaggerHub when this flow does not support it). */
  disabledIds?: ImportSourceTabId[];
}

export function ImportSourceTabBar({ active, onSelect, className = '', disabledIds }: ImportSourceTabBarProps) {
  return (
    <div
      role="tablist"
      aria-label="Import source"
      className={cn(TAB_LIST_CLASS, className)}
    >
      {TABS.map(({ id, label, disabled }) => {
        const isDisabled = Boolean(disabled) || Boolean(disabledIds?.includes(id));
        const isActive = active === id;
        const icon = TAB_ICONS[id];
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={isDisabled || undefined}
            disabled={isDisabled}
            onClick={() => !isDisabled && onSelect(id)}
            title={isDisabled ? 'Coming soon' : undefined}
            className={tabTriggerClass({ active: isActive, disabled: isDisabled })}
          >
            <span aria-hidden="true">{icon}</span>
            {label}
          </button>
        );
      })}
    </div>
  );
}
