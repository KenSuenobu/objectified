/**
 * The account surfaces (HIVE-4.7, #5301).
 *
 * `/ade/dashboard/profile` composes these; `/ade/dashboard/linked-accounts` shares the tab
 * strip. Everything that can be decided without a DOM lives in `accountModel.ts` and
 * `passwordStrength.ts`, which is why both are unit-tested on their own.
 */
export { AccountTabs, LINKED_ACCOUNTS_ROUTE, PROFILE_ROUTE } from './AccountTabs';
export type { AccountTabId, AccountTabsProps } from './AccountTabs';
export { AccountDetailsCard } from './AccountDetailsCard';
export type { AccountDetailsCardProps } from './AccountDetailsCard';
export { BackupCodes, BACKUP_CODES_FILENAME, backupCodesFileBody } from './BackupCodes';
export type { BackupCodesProps } from './BackupCodes';
export { ChangePasswordDialog } from './ChangePasswordDialog';
export type { ChangePasswordDialogProps } from './ChangePasswordDialog';
export { EditNameDialog } from './EditNameDialog';
export type { EditNameDialogProps } from './EditNameDialog';
export { IdentityHero } from './IdentityHero';
export type { IdentityHeroProps } from './IdentityHero';
export { SecurityCard } from './SecurityCard';
export type { SecurityCardProps } from './SecurityCard';
export { SessionCard } from './SessionCard';
export type { SessionCardProps } from './SessionCard';
export { SignInMethodsCard } from './SignInMethodsCard';
export type { SignInMethodsCardProps } from './SignInMethodsCard';
export {
  SESSION_LIFETIME_DAYS,
  buildSignInMethods,
  describeDevice,
  formatLoginStamp,
  providerLabel,
  readSessionLifetime,
} from './accountModel';
export type { LinkedIdentity, SessionLifetime, SignInMethodRow } from './accountModel';
export {
  PASSWORD_MAX_POINTS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS,
  PASSWORD_STRONG_LENGTH,
  passwordStrength,
} from './passwordStrength';
export type { PasswordRequirement, PasswordStrength } from './passwordStrength';
