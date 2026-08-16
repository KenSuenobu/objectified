'use client';

import { useEffect, useState } from 'react';
import { useAuthSession } from '@lib/auth/session-client';
import {
  Folder,
  GitBranch,
  Box,
  Code,
  Clock,
  TrendingUp,
  LayoutDashboard,
  CheckCircle2,
} from 'lucide-react';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { Skeleton } from '../../components/ui/Skeleton';
import { Badge } from '../../components/ui/Badge';
import { FirstRunChecklist } from '../../components/ade/dashboard/FirstRunChecklist';
import { cn } from '../../../../lib/utils';
import { getDashboardStats, getRecentActivity } from '../../../../lib/db/helper';

interface DashboardStats {
  total_tenants: number;
  admin_tenants: number;
  total_projects: number;
  created_projects: number;
  total_versions: number;
  created_versions: number;
  published_versions: number;
  total_classes: number;
  total_properties: number;
  total_class_properties: number;
  last_activity: string | null;
}

interface RecentActivity {
  type: 'project' | 'version' | 'class' | 'property';
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  tenant_name: string;
  tenant_slug: string;
}

const Dashboard = () => {
  const { data: session } = useAuthSession();
  const [stats, setStats] = useState<DashboardStats>({
    total_tenants: 0,
    admin_tenants: 0,
    total_projects: 0,
    created_projects: 0,
    total_versions: 0,
    created_versions: 0,
    published_versions: 0,
    total_classes: 0,
    total_properties: 0,
    total_class_properties: 0,
    last_activity: null,
  });
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const userId = (session?.user as { user_id?: string } | undefined)?.user_id;
  const userName = session?.user?.name || 'User';

  useEffect(() => {
    const loadDashboardData = async () => {
      if (!userId) return;

      setIsLoading(true);
      try {
        const [statsData, activityData] = await Promise.all([
          getDashboardStats(userId),
          getRecentActivity(userId, 10)
        ]);

        setStats(JSON.parse(statsData));
        setRecentActivity(JSON.parse(activityData));
      } catch (error) {
        console.error('Error loading dashboard data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadDashboardData();
  }, [userId]);

  const getActivityIcon = (type: string) => {
    const iconClass = "h-5 w-5";
    switch (type) {
      case 'project':
        return <Folder className={cn(iconClass, "text-purple-500")} />;
      case 'version':
        return <GitBranch className={cn(iconClass, "text-emerald-500")} />;
      case 'class':
        return <Box className={cn(iconClass, "text-cyan-500")} />;
      case 'property':
        return <Code className={cn(iconClass, "text-amber-500")} />;
      default:
        return <Clock className={cn(iconClass, "text-gray-500")} />;
    }
  };

  const getActivityLabel = (type: string) => {
    switch (type) {
      case 'project': return 'Created project';
      case 'version': return 'Created version';
      case 'class': return 'Created class';
      case 'property': return 'Created property';
      default: return 'Activity';
    }
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
    const years = Math.floor(months / 12);
    return `${years} year${years !== 1 ? 's' : ''} ago`;
  };

  const unpublishedVersionCount = Math.max(0, stats.total_versions - stats.published_versions);

  const statsConfig = [
    {
      icon: Folder,
      label: 'Tenants',
      value: stats.total_tenants,
      subtitle: `${stats.admin_tenants} admin`,
      iconColor: 'text-blue-600 dark:text-blue-400',
    },
    {
      icon: Folder,
      label: 'Projects',
      value: stats.total_projects,
      subtitle: `${stats.created_projects} created`,
      iconColor: 'text-purple-600 dark:text-purple-400',
    },
    {
      icon: GitBranch,
      label: 'Versions',
      value: stats.total_versions,
      subtitle: `${stats.created_versions} created`,
      iconColor: 'text-emerald-600 dark:text-emerald-400',
    },
    {
      icon: CheckCircle2,
      label: 'Published',
      value: stats.published_versions,
      subtitle: `${unpublishedVersionCount} draft${unpublishedVersionCount === 1 ? '' : 's'}`,
      iconColor: 'text-green-600 dark:text-green-400',
    },
    {
      icon: Box,
      label: 'Classes',
      value: stats.total_classes,
      subtitle: 'schema definitions',
      iconColor: 'text-cyan-600 dark:text-cyan-400',
    },
    {
      icon: Code,
      label: 'Properties',
      value: stats.total_properties,
      subtitle: `${stats.total_class_properties} in classes`,
      iconColor: 'text-amber-600 dark:text-amber-400',
    },
  ];

  return (
    <>
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <LayoutDashboard className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                Dashboard
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">
                Welcome back, {userName}. Here&apos;s an overview of your schema projects and activity.
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className={dashboardMainClass}>
        <div className={dashboardContentStackClass}>
      {/* First-run onboarding checklist (dismissible; completion derived from stats) */}
      {!isLoading && <FirstRunChecklist stats={stats} />}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {statsConfig.map((stat) => {
          const IconComponent = stat.icon;
          return (
            <div key={stat.label} className={`${dashboardPanelClass} p-4`}>
                {isLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-10 w-10 rounded-xl" />
                    <Skeleton className="h-8 w-16" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-600 dark:text-gray-400">{stat.label}</p>
                      <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                        {stat.value}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {stat.subtitle}
                      </p>
                    </div>
                    <IconComponent className={cn('w-8 h-8 opacity-50', stat.iconColor)} />
                  </div>
                )}
            </div>
          );
        })}
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={`${dashboardPanelClass} overflow-hidden`}>
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
              <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                  Recent Activity
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Your latest actions
                </p>
              </div>
            </div>
          </div>

          <div className="p-4">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            ) : recentActivity.length > 0 ? (
              <div className="space-y-2">
                {recentActivity.map((item, index) => (
                  <div key={item.id}>
                    <div className="flex items-start gap-3 p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                      <div className={cn(
                        "w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0",
                        item.type === 'project' ? 'bg-purple-100 dark:bg-purple-900/30' :
                        item.type === 'version' ? 'bg-emerald-100 dark:bg-emerald-900/30' :
                        item.type === 'class' ? 'bg-cyan-100 dark:bg-cyan-900/30' :
                        'bg-amber-100 dark:bg-amber-900/30'
                      )}>
                        {getActivityIcon(item.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                          {getActivityLabel(item.type)}
                        </p>
                        <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                          {item.name}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <Badge variant="default" className="text-2xs px-2 py-0">
                            {item.tenant_name}
                          </Badge>
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            {formatTimeAgo(item.created_at)}
                          </span>
                        </div>
                      </div>
                    </div>
                    {index < recentActivity.length - 1 && (
                      <div className="mx-3 border-t border-gray-100 dark:border-gray-800" />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 px-6">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900/30 dark:to-purple-900/30 flex items-center justify-center mx-auto mb-4">
                  <TrendingUp className="h-8 w-8 text-indigo-600 dark:text-indigo-400" />
                </div>
                <h3 className="font-semibold text-gray-700 dark:text-gray-200 mb-1">
                  No recent activity
                </h3>
                <p className="text-sm text-gray-400 dark:text-gray-500">
                  Start creating projects to see your activity here!
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
        </div>
      </main>
    </>
  );
};

export default Dashboard;

