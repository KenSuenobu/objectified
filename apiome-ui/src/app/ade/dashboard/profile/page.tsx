'use client';

import { useAuthSession } from '@lib/auth/session-client';
import Link from 'next/link';
import { User, Mail, Hash, Clock, Building2, Edit2, Key, Shield, LogIn, Copy, Check, Link as LinkIcon } from 'lucide-react';
import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '../../../components/ui/Dialog';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Label } from '../../../components/ui/Label';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { LoadingState } from '../../../components/ui/LoadingState';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../../../components/ui/Card';
import { updateUserName, updateUserPassword, getCurrentUserLastLoginAt } from '../../../../../lib/db/helper';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { cn } from '../../../../../lib/utils';
import { TwoFactorSettings } from './TwoFactorSettings';

const Profile = () => {
  const { data: session, update } = useAuthSession();
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [lastLoginAt, setLastLoginAt] = useState<string | null | undefined>(undefined);
  const [copiedField, setCopiedField] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await getCurrentUserLastLoginAt();
        const parsed = JSON.parse(raw);
        if (!cancelled && parsed.success) {
          setLastLoginAt(parsed.lastLoginAt ?? null);
        } else if (!cancelled) {
          setLastLoginAt(null);
        }
      } catch {
        if (!cancelled) setLastLoginAt(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user]);

  const handleEditClick = () => {
    setEditedName(session?.user?.name || '');
    setErrorMessage('');
    setShowEditDialog(true);
  };

  const handleSaveName = async () => {
    if (!editedName.trim()) {
      setErrorMessage('Name cannot be empty');
      return;
    }
    setIsLoading(true);
    setErrorMessage('');
    try {
      const userId = (session?.user as any)?.user_id;
      const result = await updateUserName(userId, editedName.trim());
      const response = JSON.parse(result);
      if (response.success) {
        await update({
          ...session,
          user: { ...session?.user, name: editedName.trim() },
        });
        setShowEditDialog(false);
      } else {
        setErrorMessage(response.error || 'Failed to update name');
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasswordChangeClick = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError('');
    setShowPasswordDialog(true);
  };

  const handleSavePassword = async () => {
    if (!currentPassword) {
      setPasswordError('Please enter your current password');
      return;
    }
    if (!newPassword) {
      setPasswordError('Please enter a new password');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }
    setIsLoading(true);
    setPasswordError('');
    try {
      const userId = (session?.user as any)?.user_id;
      const result = await updateUserPassword(userId, currentPassword, newPassword);
      const response = JSON.parse(result);
      if (response.success) {
        setShowPasswordDialog(false);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setSuccessMessage('Password changed successfully.');
      } else {
        setPasswordError(response.error || 'Failed to update password');
      }
    } catch (error: any) {
      setPasswordError(error.message || 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(''), 2000);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  if (!session) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <LoadingState minHeightClassName="min-h-[320px]" message="Loading profile..." />
      </div>
    );
  }

  const { user, expires } = session;
  const expiryDate = new Date(expires);
  const tenantId = (user as any)?.current_tenant_id as string | undefined;
  const userId = (user as any)?.user_id as string | undefined;

  const initials = (user?.name || user?.email || '?')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  const formatLoginDate = (dateString: string) => {
    const d = new Date(dateString);
    const datePart = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timePart = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
  };

  const CopyButton = ({ field, value }: { field: string; value: string }) => (
    <button
      onClick={() => handleCopy(field, value)}
      className="p-1 rounded-md text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors flex-shrink-0"
      title={`Copy ${field}`}
    >
      {copiedField === field ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );

  const InfoTile = ({
    icon: Icon,
    label,
    value,
    mono,
    action,
    className,
  }: {
    icon: React.ElementType;
    label: string;
    value: React.ReactNode;
    mono?: boolean;
    action?: React.ReactNode;
    className?: string;
  }) => (
    <div
      className={cn(
        'rounded-lg border border-gray-100 dark:border-gray-700/60 bg-gray-50/70 dark:bg-gray-900/40 p-4',
        className
      )}
    >
      <div className="flex items-center gap-1.5 mb-1.5 text-gray-400 dark:text-gray-500">
        <Icon className="h-3.5 w-3.5 text-indigo-400 dark:text-indigo-500" />
        <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 min-w-0">
        <div
          className={
            mono
              ? 'text-sm font-mono text-gray-700 dark:text-gray-300 truncate'
              : 'text-sm font-medium text-gray-900 dark:text-white min-w-0'
          }
          title={mono && typeof value === 'string' ? value : undefined}
        >
          {value}
        </div>
        {action}
      </div>
    </div>
  );

  return (
    <>
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <User className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                Profile
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">
                Manage your account and security settings
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className={dashboardMainClass}>
        <div className={cn(dashboardContentStackClass, 'max-w-5xl mx-auto')}>
          {successMessage && (
            <Alert variant="success" onClose={() => setSuccessMessage('')}>
              {successMessage}
            </Alert>
          )}

          {/* Identity hero */}
          <Card className={cn(dashboardPanelClass, 'shadow-none overflow-hidden')}>
            <div className="h-24 bg-gradient-to-r from-indigo-500 via-violet-500 to-purple-500" />
            <div className="px-6 pb-6">
              <div className="flex items-end justify-between gap-4 -mt-10">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 ring-4 ring-white dark:ring-gray-800 shadow-lg shadow-indigo-500/25 flex items-center justify-center text-white text-2xl font-bold flex-shrink-0 select-none">
                  {initials}
                </div>
                <Button variant="outline" size="sm" onClick={handleEditClick}>
                  <Edit2 className="h-4 w-4 mr-2" />
                  Edit name
                </Button>
              </div>
              <div className="mt-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                    {user?.name || 'Unnamed user'}
                  </h3>
                  {tenantId && (
                    <Badge variant="secondary" className="gap-1.5">
                      <Building2 className="h-3 w-3" />
                      Tenant active
                    </Badge>
                  )}
                </div>
                {user?.email && (
                  <p className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 mt-1">
                    <Mail className="h-3.5 w-3.5" />
                    {user.email}
                  </p>
                )}
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Account details */}
            <Card className={cn(dashboardPanelClass, 'shadow-none lg:col-span-2 self-start')}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5 text-indigo-500" />
                  Account details
                </CardTitle>
                <CardDescription>Your identity and workspace information</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <InfoTile
                    icon={User}
                    label="Full name"
                    value={user?.name || 'Not set'}
                    action={
                      <button
                        onClick={handleEditClick}
                        className="p-1 rounded-md text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors flex-shrink-0"
                        title="Edit name"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                    }
                  />
                  <InfoTile icon={Mail} label="Email" value={user?.email || 'Not set'} />
                  <InfoTile
                    icon={Hash}
                    label="User ID"
                    value={userId ?? '—'}
                    mono
                    action={userId ? <CopyButton field="User ID" value={userId} /> : undefined}
                  />
                  {tenantId ? (
                    <InfoTile
                      icon={Building2}
                      label="Current tenant"
                      value={tenantId}
                      mono
                      action={<CopyButton field="Tenant ID" value={tenantId} />}
                    />
                  ) : (
                    <InfoTile icon={Building2} label="Current tenant" value="None selected" />
                  )}
                  <InfoTile
                    icon={LogIn}
                    label="Last login"
                    value={
                      lastLoginAt === undefined
                        ? '…'
                        : lastLoginAt
                          ? formatLoginDate(lastLoginAt)
                          : '—'
                    }
                    className="sm:col-span-2"
                  />
                </div>
              </CardContent>
            </Card>

            <div className="space-y-6">
              {/* Security */}
              <Card className={cn(dashboardPanelClass, 'shadow-none')}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Shield className="h-5 w-5 text-emerald-500" />
                    Security
                  </CardTitle>
                  <CardDescription>Password and account security</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Use a strong, unique password. Change it periodically or if you suspect it has
                      been compromised.
                    </p>
                  </div>
                  <TwoFactorSettings />
                </CardContent>
                <CardFooter>
                  <Button size="sm" className="w-full" onClick={handlePasswordChangeClick}>
                    <Key className="h-4 w-4 mr-2" />
                    Change password
                  </Button>
                </CardFooter>
              </Card>

              {/* Sign-in methods — manage linked identity providers (OLO-2.4) */}
              <Card className={cn(dashboardPanelClass, 'shadow-none')}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <LinkIcon className="h-5 w-5 text-cyan-500" />
                    Sign-in methods
                  </CardTitle>
                  <CardDescription>Linked identity providers</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Link providers like GitHub, GitLab, or Microsoft for single sign-on, and manage
                    or unlink them at any time.
                  </p>
                </CardContent>
                <CardFooter>
                  <Button asChild size="sm" variant="outline" className="w-full">
                    <Link href="/ade/dashboard/linked-accounts">
                      <LinkIcon className="h-4 w-4 mr-2" />
                      Manage linked accounts
                    </Link>
                  </Button>
                </CardFooter>
              </Card>

              {/* Session */}
              <Card className={cn(dashboardPanelClass, 'shadow-none')}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="h-5 w-5 text-amber-500" />
                    Session
                  </CardTitle>
                  <CardDescription>Your current sign-in session</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
                    Expires
                  </p>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {expiryDate.toLocaleString()}
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                    {expiryDate.toLocaleDateString('en-US', {
                      weekday: 'long',
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Edit name dialog */}
          <Dialog open={showEditDialog} onOpenChange={(open) => !isLoading && setShowEditDialog(open)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-indigo-100 dark:bg-indigo-900/40">
                    <Edit2 className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  Edit name
                </DialogTitle>
                <DialogDescription>Update your display name.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
                <div className="space-y-2">
                  <Label htmlFor="name">Full name</Label>
                  <Input
                    id="name"
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !isLoading && handleSaveName()}
                    disabled={isLoading}
                    placeholder="Your name"
                    autoFocus
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowEditDialog(false)} disabled={isLoading}>
                  Cancel
                </Button>
                <Button onClick={handleSaveName} disabled={isLoading}>
                  {isLoading ? 'Saving…' : 'Save'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Change password dialog */}
          <Dialog open={showPasswordDialog} onOpenChange={(open) => !isLoading && setShowPasswordDialog(open)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-emerald-100 dark:bg-emerald-900/40">
                    <Key className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  Change password
                </DialogTitle>
                <DialogDescription>Enter your current password and choose a new one.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                {passwordError && <Alert variant="error">{passwordError}</Alert>}
                <Alert variant="info">
                  <div>
                    <p className="font-medium mb-2">Password requirements</p>
                    <ul className="list-disc list-inside text-sm space-y-1 text-gray-600 dark:text-gray-400">
                      <li>At least 8 characters</li>
                      <li>One uppercase and one lowercase letter</li>
                      <li>One number or special character</li>
                    </ul>
                  </div>
                </Alert>
                <div className="space-y-2">
                  <Label htmlFor="currentPassword">Current password</Label>
                  <Input
                    id="currentPassword"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    disabled={isLoading}
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newPassword">New password</Label>
                  <Input
                    id="newPassword"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={isLoading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm new password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !isLoading && handleSavePassword()}
                    disabled={isLoading}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowPasswordDialog(false)} disabled={isLoading}>
                  Cancel
                </Button>
                <Button onClick={handleSavePassword} disabled={isLoading}>
                  {isLoading ? 'Updating…' : 'Change password'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </main>
    </>
  );
};

export default Profile;
