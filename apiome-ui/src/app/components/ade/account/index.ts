/**
 * The account surfaces (HIVE-4.7, #5301 · HIVE-4.8, #5302).
 *
 * `/ade/dashboard/profile` composes the first group; `/ade/dashboard/linked-accounts` composes
 * the second and shares the tab strip. Everything that can be decided without a DOM lives in
 * `accountModel.ts`, `passwordStrength.ts` and `linkedAccountsModel.ts`, which is why all three
 * are unit-tested on their own.
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

// ---- Linked accounts (HIVE-4.8, #5302) ----------------------------------------------
export { LinkedAccountsTable } from './LinkedAccountsTable';
export type { LinkedAccountsTableProps } from './LinkedAccountsTable';
export { PatDialog, PAT_REQUIRED_MESSAGE } from './PatDialog';
export type { PatDialogProps } from './PatDialog';
export { ProviderCard } from './ProviderCard';
export type { ProviderCardProps } from './ProviderCard';
export {
  LAST_METHOD_NOTE,
  LAST_METHOD_TOOLTIP,
  LINKED_ACCOUNTS_PATH,
  LINK_FAILURE_MESSAGE,
  LINK_SUCCESS_MESSAGE,
  PAT_ADD_HINT,
  PAT_PROVIDERS,
  PAT_SCOPES,
  PROVIDER_TAGLINES,
  accountHandle,
  buildLinkedAccountRows,
  buildProviderCards,
  describeRemainingMethods,
  isLastSignInMethod,
  parsePayload,
  patMask,
  patScopesFor,
  providerTagline,
  readActionError,
  readLinkOutcome,
  removePatConfirmOptions,
  resolveProviderLabel,
  unlinkConfirmOptions,
} from './linkedAccountsModel';
export type {
  LinkOutcome,
  LinkedAccount,
  LinkedAccountRow,
  ProviderCardModel,
} from './linkedAccountsModel';
