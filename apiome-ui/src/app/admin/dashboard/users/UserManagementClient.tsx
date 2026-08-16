'use client';

import { useState, useEffect, type FormEvent } from 'react';
import {
  Users,
  UserPlus,
  UserCheck,
  Mail,
  Calendar,
  Trash2,
  CheckCircle,
  XCircle,
  RefreshCw,
  AlertCircle,
  MoreVertical,
  Power,
  Award,
  Flag,
  Plus,
  X,
} from 'lucide-react';
import {
  getAllSignups,
  createUser,
  createUserFromSignup,
  deleteSignup,
  updateUser,
  deleteUser,
  getUserStats,
  getSignupStats,
  getAllUsersWithLicenses,
  getAllLicenses,
  assignLicenseToUser,
  removeUserLicense,
} from '../../../../../lib/db/admin-helper';
import { FeatureFlagUserOverridesPanel } from '../components/FeatureFlagUserOverridesPanel';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { destructiveConfirm } from '@/app/components/dialogs/destructiveConfirm';

interface User {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  license_id: string | null;
  license_name: string | null;
  license_type: string | null;
}

interface Signup {
  name: string;
  email_address: string;
  signup_source: string;
  signup_date: string;
  password: string;
}

interface UserStats {
  total_users: number;
  enabled_users: number;
  verified_users: number;
  new_users_30_days: number;
  new_users_7_days: number;
}

interface SignupStats {
  total_signups: number;
  signups_30_days: number;
  signups_7_days: number;
  signups_today: number;
}

interface License {
  id: string;
  name: string;
  license_type: string;
  enabled: boolean;
}

const LICENSE_TYPE_COLORS: Record<string, string> = {
  free:    'bg-slate-700 text-slate-200',
  paid:    'bg-indigo-700 text-indigo-100',
  sponsor: 'bg-amber-700 text-amber-100',
};

export default function UserManagementClient() {
  const { confirm } = useDialog();
  const [users, setUsers] = useState<User[]>([]);
  const [signups, setSignups] = useState<Signup[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [signupStats, setSignupStats] = useState<SignupStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'users' | 'signups'>('signups');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [openSignupDropdown, setOpenSignupDropdown] = useState<string | null>(null);
  const [openUserDropdown, setOpenUserDropdown] = useState<string | null>(null);
  const [signupDropdownPos, setSignupDropdownPos] = useState<{ top: number; right: number } | null>(null);
  const [userDropdownPos, setUserDropdownPos] = useState<{ top: number; right: number } | null>(null);
  const [licenseSubMenu, setLicenseSubMenu] = useState<string | null>(null);
  const [flagsUser, setFlagsUser] = useState<User | null>(null);
  const [showCreateUserDialog, setShowCreateUserDialog] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [newUser, setNewUser] = useState({
    name: '',
    email: '',
    password: '',
    verified: true,
    enabled: true,
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [usersRes, signupsRes, userStatsRes, signupStatsRes, licensesRes] = await Promise.all([
        getAllUsersWithLicenses(),
        getAllSignups(),
        getUserStats(),
        getSignupStats(),
        getAllLicenses(),
      ]);

      const usersData = JSON.parse(usersRes);
      const signupsData = JSON.parse(signupsRes);
      const userStatsData = JSON.parse(userStatsRes);
      const signupStatsData = JSON.parse(signupStatsRes);
      const licensesData = JSON.parse(licensesRes);

      if (usersData.success) setUsers(usersData.users);
      if (signupsData.success) setSignups(signupsData.signups);
      if (userStatsData.success) setUserStats(userStatsData.stats);
      if (signupStatsData.success) setSignupStats(signupStatsData.stats);
      if (licensesData.success) setLicenses(licensesData.licenses.filter((l: License) => l.enabled));
    } catch (error) {
      console.error('Error loading data:', error);
      showMessage('error', 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleAssignLicense = async (userId: string, licenseId: string) => {
    try {
      const result = await assignLicenseToUser(userId, licenseId);
      const data = JSON.parse(result);
      if (data.success) {
        showMessage('success', 'License assigned successfully');
        await loadData();
      } else {
        showMessage('error', data.error || 'Failed to assign license');
      }
    } catch {
      showMessage('error', 'Failed to assign license');
    } finally {
      setLicenseSubMenu(null);
      setOpenUserDropdown(null);
    }
  };

  const handleRemoveLicense = async (userId: string) => {
    try {
      const result = await removeUserLicense(userId);
      const data = JSON.parse(result);
      if (data.success) {
        showMessage('success', 'License removed');
        await loadData();
      } else {
        showMessage('error', data.error || 'Failed to remove license');
      }
    } catch {
      showMessage('error', 'Failed to remove license');
    } finally {
      setOpenUserDropdown(null);
    }
  };

  const handleOpenFlagsModal = (user: User) => {
    setOpenUserDropdown(null);
    setFlagsUser(user);
  };

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  };

  const resetNewUserForm = () => {
    setNewUser({
      name: '',
      email: '',
      password: '',
      verified: true,
      enabled: true,
    });
  };

  const handleCreateUser = async (event: FormEvent) => {
    event.preventDefault();

    const name = newUser.name.trim();
    const email = newUser.email.trim().toLowerCase();

    if (!name || !email || !newUser.password) {
      showMessage('error', 'Name, email, and password are required');
      return;
    }

    setCreatingUser(true);
    try {
      const result = await createUser(
        name,
        email,
        newUser.password,
        newUser.verified,
        newUser.enabled
      );
      const data = JSON.parse(result);

      if (data.success) {
        showMessage('success', `User created successfully for ${name}`);
        setShowCreateUserDialog(false);
        resetNewUserForm();
        setActiveTab('users');
        await loadData();
      } else {
        showMessage('error', data.error || 'Failed to create user');
      }
    } catch (error) {
      console.error('Error creating user:', error);
      showMessage('error', 'Failed to create user');
    } finally {
      setCreatingUser(false);
    }
  };

  const handleCreateUserFromSignup = async (signup: Signup) => {
    const confirmed = await confirm({
      title: `Create an account for ${signup.name}?`,
      message: `${signup.email_address} gets a verified, enabled account and can sign in straight away.`,
      variant: 'info',
      confirmLabel: 'Create account',
    });
    if (!confirmed) return;

    try {
      const result = await createUserFromSignup(signup.email_address, true, true);
      const data = JSON.parse(result);

      if (data.success) {
        showMessage('success', `User created successfully for ${signup.name}`);
        await loadData();
      } else {
        showMessage('error', data.error || 'Failed to create user');
      }
    } catch (error) {
      console.error('Error creating user from signup:', error);
      showMessage('error', 'Failed to create user');
    }
  };

  const handleDeleteSignup = async (email: string) => {
    const confirmed = await confirm(
      destructiveConfirm({
        action: 'Delete',
        noun: 'signup request from',
        name: email,
        consequence:
          'The request leaves the queue. Nobody is emailed, and the address can sign up again.',
        confirmLabel: 'Delete request',
      })
    );
    if (!confirmed) return;

    try {
      const result = await deleteSignup(email);
      const data = JSON.parse(result);

      if (data.success) {
        showMessage('success', 'Signup deleted successfully');
        await loadData();
      } else {
        showMessage('error', data.error || 'Failed to delete signup');
      }
    } catch (error) {
      console.error('Error deleting signup:', error);
      showMessage('error', 'Failed to delete signup');
    }
  };

  const handleToggleUserEnabled = async (user: User) => {
    try {
      const result = await updateUser(user.id, { enabled: !user.enabled });
      const data = JSON.parse(result);

      if (data.success) {
        showMessage('success', `User ${user.enabled ? 'disabled' : 'enabled'} successfully`);
        await loadData();
      } else {
        showMessage('error', data.error || 'Failed to update user');
      }
    } catch (error) {
      console.error('Error updating user:', error);
      showMessage('error', 'Failed to update user');
    }
  };

  const handleToggleUserVerified = async (user: User) => {
    try {
      const result = await updateUser(user.id, { verified: !user.verified });
      const data = JSON.parse(result);

      if (data.success) {
        showMessage('success', `User ${user.verified ? 'unverified' : 'verified'} successfully`);
        await loadData();
      } else {
        showMessage('error', data.error || 'Failed to update user');
      }
    } catch (error) {
      console.error('Error updating user:', error);
      showMessage('error', 'Failed to update user');
    }
  };

  const handleDeleteUser = async (user: User) => {
    // Type-to-confirm: #5286 names the admin user delete alongside tenants and projects as
    // the irreversible cases. The phrase is the email, not the display name — two people
    // can share a name, and it is the email the row is identified by everywhere else.
    const confirmed = await confirm(
      destructiveConfirm({
        action: 'Delete',
        noun: 'user',
        name: user.email,
        consequence: `${user.name} loses their account, every tenant membership it carried and any licence assigned to it.`,
        typeToConfirm: true,
        confirmLabel: 'Delete user',
      })
    );
    if (!confirmed) return;

    try {
      const result = await deleteUser(user.id);
      const data = JSON.parse(result);

      if (data.success) {
        showMessage('success', 'User deleted successfully');
        await loadData();
      } else {
        showMessage('error', data.error || 'Failed to delete user');
      }
    } catch (error) {
      console.error('Error deleting user:', error);
      showMessage('error', 'Failed to delete user');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <>
      {/* Header */}
      <header className="shrink-0 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">User Management</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">Manage user accounts and approve signups</p>
            </div>
            <button
              type="button"
              onClick={() => setShowCreateUserDialog(true)}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors shrink-0"
            >
              <Plus className="w-4 h-4" />
              New User
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-slate-950">
        <div className="space-y-6">
          {/* Message Banner */}
      {message && (
        <div
          className={`p-4 rounded-lg border flex items-start gap-3 ${
            message.type === 'success'
              ? 'bg-green-900/20 border-green-700 text-green-400'
              : 'bg-red-900/20 border-red-700 text-red-400'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          )}
          <p className="text-sm">{message.text}</p>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-blue-600/20 rounded-lg">
              <Users className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400 text-xs">Total Users</p>
              <p className="text-gray-900 dark:text-white text-xl font-bold">{userStats?.total_users || 0}</p>
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            {userStats?.new_users_7_days || 0} new this week
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-green-600/20 rounded-lg">
              <UserCheck className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400 text-xs">Verified Users</p>
              <p className="text-gray-900 dark:text-white text-xl font-bold">{userStats?.verified_users || 0}</p>
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            {userStats?.enabled_users || 0} enabled
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-purple-600/20 rounded-lg">
              <UserPlus className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400 text-xs">Pending Signups</p>
              <p className="text-gray-900 dark:text-white text-xl font-bold">{signupStats?.total_signups || 0}</p>
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            {signupStats?.signups_today || 0} today
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-orange-600/20 rounded-lg">
              <Calendar className="w-5 h-5 text-orange-400" />
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400 text-xs">Recent Signups</p>
              <p className="text-gray-900 dark:text-white text-xl font-bold">{signupStats?.signups_7_days || 0}</p>
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400">Last 7 days</p>
        </div>
      </div>

      {/* Tabs */}
      <div className={TAB_LIST_CLASS} role="tablist" aria-label="User management views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'signups'}
          onClick={() => setActiveTab('signups')}
          className={tabTriggerClass({ active: activeTab === 'signups' })}
        >
          Pending Signups
          {signups.length > 0 && (
            <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs text-white">
              {signups.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'users'}
          onClick={() => setActiveTab('users')}
          className={tabTriggerClass({ active: activeTab === 'users' })}
        >
          Active Users
        </button>
      </div>

      {/* Refresh Button */}
      <div className="flex justify-end">
        <button
          onClick={loadData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-600 text-gray-700 dark:text-white rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
        </div>
      ) : activeTab === 'signups' ? (
        // Signups Table
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          {signups.length === 0 ? (
            <div className="p-12 text-center">
              <UserPlus className="w-12 h-12 text-gray-600 mx-auto mb-4" />
              <p className="text-gray-400 text-sm">No pending signups</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/80">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Name
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Email
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Source
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Date
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {signups.map((signup) => (
                    <tr key={signup.email_address} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900 dark:text-white">{signup.name}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Mail className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-gray-600 dark:text-gray-300">{signup.email_address}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          {signup.signup_source || 'Direct'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          {formatDate(signup.signup_date)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="relative inline-block">
                          <button
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setSignupDropdownPos({
                                top: rect.bottom + 4,
                                right: window.innerWidth - rect.right
                              });
                              setOpenSignupDropdown(openSignupDropdown === signup.email_address ? null : signup.email_address);
                            }}
                            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors text-gray-400 hover:text-gray-700 dark:hover:text-white"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>

                          {openSignupDropdown === signup.email_address && signupDropdownPos && (
                            <>
                              <div
                                className="fixed inset-0 z-[100]"
                                onClick={() => setOpenSignupDropdown(null)}
                              />
                              <div
                                className="fixed w-44 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg z-[101]"
                                style={{
                                  top: `${signupDropdownPos.top}px`,
                                  right: `${signupDropdownPos.right}px`
                                }}
                              >
                                <div className="py-1">
                                  <button
                                    onClick={() => {
                                      setOpenSignupDropdown(null);
                                      handleCreateUserFromSignup(signup);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-3 text-green-400 hover:text-green-300 transition-colors"
                                  >
                                    <UserCheck className="w-4 h-4" />
                                    Create User
                                  </button>
                                  <button
                                    onClick={() => {
                                      setOpenSignupDropdown(null);
                                      handleDeleteSignup(signup.email_address);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-3 text-red-400 hover:text-red-300 transition-colors"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                    Delete Signup
                                  </button>
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        // Users Table
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          {users.length === 0 ? (
            <div className="p-12 text-center">
              <Users className="w-12 h-12 text-gray-600 mx-auto mb-4" />
              <p className="text-gray-400 text-sm">No users found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/80">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      User
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Email
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      License
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Created
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-red-600/20 rounded-full flex items-center justify-center">
                            <span className="text-red-400 text-sm font-medium">
                              {user.name.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <div className="text-sm font-medium text-gray-900 dark:text-white">{user.name}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Mail className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-gray-600 dark:text-gray-300">{user.email}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {user.license_name && user.license_type ? (
                          <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-semibold uppercase tracking-wide ${LICENSE_TYPE_COLORS[user.license_type] ?? 'bg-gray-700 text-gray-200'}`}>
                            <Award className="w-3 h-3" />
                            {user.license_name}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400 dark:text-gray-600 italic">No license</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {user.verified ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-600/20 text-green-400 text-xs rounded">
                              <CheckCircle className="w-3 h-3" />
                              Verified
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-1 bg-yellow-600/20 text-yellow-400 text-xs rounded">
                              <AlertCircle className="w-3 h-3" />
                              Unverified
                            </span>
                          )}
                          {user.enabled ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 bg-blue-600/20 text-blue-400 text-xs rounded">
                              Enabled
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-600/20 text-gray-400 text-xs rounded">
                              Disabled
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          {formatDate(user.created_at)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="relative inline-block">
                          <button
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setUserDropdownPos({
                                top: rect.bottom + 4,
                                right: window.innerWidth - rect.right
                              });
                              setOpenUserDropdown(openUserDropdown === user.id ? null : user.id);
                            }}
                            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors text-gray-400 hover:text-gray-700 dark:hover:text-white"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>

                          {openUserDropdown === user.id && userDropdownPos && (
                            <>
                              <div
                                className="fixed inset-0 z-[100]"
                                onClick={() => setOpenUserDropdown(null)}
                              />
                              <div
                                className="fixed w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg z-[101]"
                                style={{
                                  top: `${userDropdownPos.top}px`,
                                  right: `${userDropdownPos.right}px`
                                }}
                              >
                                <div className="py-1">
                                  <button
                                    onClick={() => {
                                      setOpenUserDropdown(null);
                                      handleToggleUserVerified(user);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-3 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                  >
                                    {user.verified ? (
                                      <>
                                        <XCircle className="w-4 h-4 text-yellow-400" />
                                        Mark Unverified
                                      </>
                                    ) : (
                                      <>
                                        <CheckCircle className="w-4 h-4 text-green-400" />
                                        Mark Verified
                                      </>
                                    )}
                                  </button>
                                  <button
                                    onClick={() => {
                                      setOpenUserDropdown(null);
                                      handleToggleUserEnabled(user);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-3 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
                                  >
                                    {user.enabled ? (
                                      <>
                                        <Power className="w-4 h-4 text-orange-400" />
                                        Disable User
                                      </>
                                    ) : (
                                      <>
                                        <Power className="w-4 h-4 text-blue-400" />
                                        Enable User
                                      </>
                                    )}
                                  </button>

                                  <div className="border-t border-slate-200 dark:border-slate-800 mt-1 pt-1">
                                    <div className="relative">
                                      <button
                                        onClick={() => setLicenseSubMenu(licenseSubMenu === user.id ? null : user.id)}
                                        className="w-full px-4 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-3 text-indigo-300 hover:text-indigo-200 transition-colors"
                                      >
                                        <Award className="w-4 h-4" />
                                        Assign License…
                                      </button>
                                      {licenseSubMenu === user.id && (
                                        <div className="pl-4 pb-1">
                                          {licenses.map(lic => (
                                            <button
                                              key={lic.id}
                                              onClick={() => handleAssignLicense(user.id, lic.id)}
                                              className="w-full px-3 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors rounded"
                                            >
                                              <span className={`w-2 h-2 rounded-full ${lic.license_type === 'free' ? 'bg-slate-400' : lic.license_type === 'paid' ? 'bg-indigo-400' : 'bg-amber-400'}`} />
                                              {lic.name}
                                              {lic.id === user.license_id && <CheckCircle className="w-3 h-3 text-green-400 ml-auto" />}
                                            </button>
                                          ))}
                                          {user.license_id && (
                                            <button
                                              onClick={() => handleRemoveLicense(user.id)}
                                              className="w-full px-3 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2 text-red-400 hover:text-red-300 transition-colors rounded"
                                            >
                                              <Trash2 className="w-3 h-3" />
                                              Remove License
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  <div className="border-t border-slate-200 dark:border-slate-800 mt-1 pt-1">
                                    <button
                                      onClick={() => handleOpenFlagsModal(user)}
                                      className="w-full px-4 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-3 text-emerald-300 hover:text-emerald-200 transition-colors"
                                    >
                                      <Flag className="w-4 h-4" />
                                      Manage Feature Flags…
                                    </button>
                                  </div>

                                  <div className="border-t border-slate-200 dark:border-slate-800 mt-1 pt-1">
                                    <button
                                      onClick={() => {
                                        setOpenUserDropdown(null);
                                        handleDeleteUser(user);
                                      }}
                                      className="w-full px-4 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-3 text-red-400 hover:text-red-300 transition-colors"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                      Delete User
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
        </div>
      </main>

      {/* Create User Dialog */}
      {showCreateUserDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[200] p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg max-w-md w-full">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Create New User</h3>
              <button
                type="button"
                onClick={() => {
                  setShowCreateUserDialog(false);
                  resetNewUserForm();
                }}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateUser} className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Name *
                </label>
                <input
                  type="text"
                  value={newUser.name}
                  onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg text-gray-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600"
                  placeholder="Jane Doe"
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Email *
                </label>
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg text-gray-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600"
                  placeholder="jane@example.com"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Password *
                </label>
                <input
                  type="password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-800 rounded-lg text-gray-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600"
                  placeholder="Temporary password"
                  required
                  minLength={8}
                />
                <p className="text-gray-500 text-xs mt-1">Minimum 8 characters. Stored as a bcrypt hash.</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="newUserVerified"
                    checked={newUser.verified}
                    onChange={(e) => setNewUser({ ...newUser, verified: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900 text-red-600 focus:ring-2 focus:ring-red-600 focus:ring-offset-0"
                  />
                  <label htmlFor="newUserVerified" className="text-sm text-gray-700 dark:text-gray-300">
                    Mark email as verified
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="newUserEnabled"
                    checked={newUser.enabled}
                    onChange={(e) => setNewUser({ ...newUser, enabled: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900 text-red-600 focus:ring-2 focus:ring-red-600 focus:ring-offset-0"
                  />
                  <label htmlFor="newUserEnabled" className="text-sm text-gray-700 dark:text-gray-300">
                    Enable account immediately
                  </label>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateUserDialog(false);
                    resetNewUserForm();
                  }}
                  className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
                  disabled={creatingUser}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingUser}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {creatingUser ? 'Creating…' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Feature Flags Modal */}
      {flagsUser && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setFlagsUser(null)} />
          <div className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl w-full max-w-3xl h-[90vh] max-h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
              <div className="p-2 bg-emerald-600/20 rounded-lg">
                <Flag className="w-5 h-5 text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-gray-900 dark:text-white font-semibold text-lg">Feature Flags</h3>
                <p className="text-gray-400 text-xs truncate">{flagsUser.name} — {flagsUser.email}</p>
              </div>
              <button onClick={() => setFlagsUser(null)} className="text-gray-400 hover:text-white p-1 rounded transition-colors">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-4">
              <FeatureFlagUserOverridesPanel
                className="h-full min-h-0"
                userId={flagsUser.id}
                userName={flagsUser.name}
                userEmail={flagsUser.email}
                onNotify={showMessage}
              />
            </div>
            <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end shrink-0">
              <button
                onClick={() => setFlagsUser(null)}
                className="px-4 py-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-600 text-gray-700 dark:text-white text-sm rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

