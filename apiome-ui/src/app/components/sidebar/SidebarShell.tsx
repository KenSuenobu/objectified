'use client';

import * as React from 'react';
import { sidebarTheme, useSidebarTokens } from './sidebar-theme';

interface SidebarShellProps {
  /** Icon rendered inside the small accent badge in the header. */
  icon: React.ReactNode;
  /** Primary header label. */
  title: string;
  /** Optional secondary line (count, version name, hint text). */
  subtitle?: React.ReactNode;
  /** Optional right-aligned slot inside the header (e.g. status pill). */
  headerActions?: React.ReactNode;
  /** Width of the sidebar content column in pixels. Defaults to 280. The
   *  rail (when provided) is added to this for the total sidebar width. */
  width?: number;
  /** Optional toolbar rendered directly below the header (filters, tabs). */
  toolbar?: React.ReactNode;
  /** Footer pinned to the bottom (density toggle, primary actions). */
  footer?: React.ReactNode;
  /** Body content (scrollable). */
  children: React.ReactNode;
  /** Extra className for the outer aside. */
  className?: string;
  /** Override scrolling behavior for the body. Defaults to true. */
  bodyScroll?: boolean;
  /**
   * Optional VSCode/Cursor-style activity rail rendered flush-left of the
   * shell. Typically a vertical list of icon buttons (e.g. Radix Tabs.List
   * with orientation="vertical"). When present, the total sidebar width
   * becomes `railWidth + width`.
   */
  rail?: React.ReactNode;
  /** Width of the activity rail in pixels. Defaults to 40. */
  railWidth?: number;
}

/**
 * Linear/Vercel-style sidebar shell. Provides a consistent header with a small
 * accent icon badge, a hairline-divided body, and an optional pinned footer.
 *
 * Visual choices intentionally lean on subtle borders and a single indigo
 * accent so the sidebar reads as enterprise/IDE rather than marketing.
 */
export default function SidebarShell({
  icon,
  title,
  subtitle,
  headerActions,
  width = 280,
  toolbar,
  footer,
  children,
  className,
  bodyScroll = true,
  rail,
  railWidth = 40,
}: SidebarShellProps) {
  const tokens = useSidebarTokens();

  const totalWidth = rail != null ? width + railWidth : width;

  return (
    <aside
      className={[
        'shrink-0 flex h-full relative overflow-hidden',
        'border-r',
        sidebarTheme.surface,
        sidebarTheme.border,
        className ?? '',
      ].join(' ')}
      style={{ width: totalWidth, minWidth: totalWidth }}
    >
      {rail != null && (
        <div
          className={['shrink-0 flex flex-col items-stretch border-r', sidebarTheme.borderSoft].join(' ')}
          style={{ width: railWidth }}
        >
          {rail}
        </div>
      )}
      <div className="flex flex-col h-full flex-1 min-w-0">
      {/* Header */}
      <div
        className={[
          'shrink-0 flex items-center gap-3 px-3 border-b',
          tokens.headerHeight,
          sidebarTheme.border,
        ].join(' ')}
      >
        <div
          className={[
            'shrink-0 w-7 h-7 rounded-md flex items-center justify-center',
            sidebarTheme.iconBadge,
          ].join(' ')}
        >
          <span className="[&>svg]:w-3.5 [&>svg]:h-3.5">{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={[
              'text-sm font-semibold leading-tight truncate',
              sidebarTheme.textPrimary,
            ].join(' ')}
          >
            {title}
          </div>
          {subtitle != null && (
            <div
              className={[
                'text-2xs leading-tight truncate mt-0.5',
                sidebarTheme.textSecondary,
              ].join(' ')}
            >
              {subtitle}
            </div>
          )}
        </div>
        {headerActions != null && (
          <div className="shrink-0 flex items-center gap-1">{headerActions}</div>
        )}
      </div>

      {toolbar != null && (
        <div
          className={[
            'shrink-0 px-3 py-2 border-b',
            sidebarTheme.borderSoft,
          ].join(' ')}
        >
          {toolbar}
        </div>
      )}

      <div
        className={[
          'flex-1 min-h-0 flex flex-col',
          bodyScroll ? 'overflow-y-auto' : 'overflow-hidden',
        ].join(' ')}
      >
        {children}
      </div>

      {footer != null && (
        <div
          className={[
            'shrink-0 px-3 py-2 border-t',
            sidebarTheme.border,
            sidebarTheme.surface,
          ].join(' ')}
        >
          {footer}
        </div>
      )}
      </div>
    </aside>
  );
}

/**
 * Small uppercase section label, matching the muted Linear-style header used
 * inside grouped sidebar lists.
 */
export function SidebarSectionLabel({
  children,
  trailing,
  className,
}: {
  children: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={['flex items-center justify-between px-1 mb-1.5', className ?? ''].join(' ')}>
      <span className={sidebarTheme.sectionLabel}>{children}</span>
      {trailing != null && (
        <span className="text-2xs text-slate-400 dark:text-slate-500 tabular-nums">
          {trailing}
        </span>
      )}
    </div>
  );
}
