'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  Users,
  CreditCard,
  Settings,
  LogOut,
  Shield,
  Database,
  Activity,
  Building2,
  Package,
  LayoutGrid,
  Award,
  Flag,
} from 'lucide-react';
import SidebarShell, { SidebarSectionLabel } from '../../components/sidebar/SidebarShell';
import SidebarDensityToggle from '../../components/sidebar/SidebarDensityToggle';
import { sidebarTheme, useSidebarTokens } from '../../components/sidebar/sidebar-theme';

interface AdminMenuItem {
  id: string;
  path: string;
  icon: React.ReactNode;
  title: string;
}

const OVERVIEW: AdminMenuItem = {
  id: 'overview',
  path: '/admin/dashboard',
  icon: <LayoutGrid className="w-4 h-4" />,
  title: 'Overview',
};

const MANAGEMENT_ITEMS: AdminMenuItem[] = [
  { id: 'users', path: '/admin/dashboard/users', icon: <Users className="w-4 h-4" />, title: 'User Management' },
  { id: 'tenants', path: '/admin/dashboard/tenants', icon: <Building2 className="w-4 h-4" />, title: 'Tenant Management' },
  { id: 'licenses', path: '/admin/dashboard/licenses', icon: <Award className="w-4 h-4" />, title: 'License Management' },
  { id: 'featureFlags', path: '/admin/dashboard/feature-flags', icon: <Flag className="w-4 h-4" />, title: 'Feature Flags' },
  { id: 'templates', path: '/admin/dashboard/templates', icon: <Package className="w-4 h-4" />, title: 'Property Templates' },
  { id: 'payments', path: '/admin/dashboard/payments', icon: <CreditCard className="w-4 h-4" />, title: 'Payment Management' },
  { id: 'database', path: '/admin/dashboard/database', icon: <Database className="w-4 h-4" />, title: 'Database Administration' },
  { id: 'monitoring', path: '/admin/dashboard/monitoring', icon: <Activity className="w-4 h-4" />, title: 'System Monitoring' },
  { id: 'settings', path: '/admin/dashboard/settings', icon: <Settings className="w-4 h-4" />, title: 'System Configuration' },
];

function NavItem({
  item,
  active,
  onClick,
}: {
  item: AdminMenuItem;
  active: boolean;
  onClick: () => void;
}) {
  const tokens = useSidebarTokens();
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group relative w-full flex items-center gap-2.5 rounded-md text-left transition-colors',
        tokens.rowPaddingX,
        tokens.rowPaddingY,
        tokens.rowText,
        active
          ? `${sidebarTheme.rowSelected} font-medium`
          : `${sidebarTheme.textSecondary} hover:${sidebarTheme.textPrimary.replace('text-', 'text-')} ${sidebarTheme.hover}`,
      ].join(' ')}
    >
      {active && (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r bg-indigo-500"
          aria-hidden
        />
      )}
      <span
        className={[
          'shrink-0 flex items-center justify-center',
          active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500 group-hover:text-slate-600 dark:group-hover:text-slate-300',
        ].join(' ')}
      >
        {item.icon}
      </span>
      <span className="truncate">{item.title}</span>
    </button>
  );
}

export default function AdminSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const tokens = useSidebarTokens();

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await fetch('/api/admin/auth', { method: 'DELETE' });
      router.push('/admin');
      router.refresh();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <SidebarShell
      icon={<Shield />}
      title="Super Admin"
      subtitle="Apiome Console"
      width={264}
      footer={
        <div className="flex items-center justify-between gap-2">
          <SidebarDensityToggle />
          <button
            type="button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            className={[
              'flex items-center gap-1.5 rounded-md transition-colors',
              tokens.rowPaddingY,
              'px-2.5 text-xs font-medium',
              'text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400',
              'hover:bg-rose-50 dark:hover:bg-rose-950/30',
              'border border-transparent hover:border-rose-200 dark:hover:border-rose-900/60',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            <LogOut className="w-3.5 h-3.5" />
            {isLoggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      }
    >
      <nav className={[tokens.sectionPadding, 'flex flex-col', tokens.rowGap].join(' ')}>
        <NavItem
          item={OVERVIEW}
          active={pathname === OVERVIEW.path}
          onClick={() => router.push(OVERVIEW.path)}
        />

        <div className="pt-3 pb-1">
          <SidebarSectionLabel>Management</SidebarSectionLabel>
        </div>

        <div className={['flex flex-col', tokens.rowGap].join(' ')}>
          {MANAGEMENT_ITEMS.map((item) => (
            <NavItem
              key={item.id}
              item={item}
              active={pathname === item.path}
              onClick={() => router.push(item.path)}
            />
          ))}
        </div>
      </nav>
    </SidebarShell>
  );
}
