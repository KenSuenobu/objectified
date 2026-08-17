/**
 * The members surface — HIVE-5.2 (#5305).
 *
 * `/ade/dashboard/members`: who can sign in to this workspace and what they may do. The page
 * composes these; the logic they share is in {@link ./membersModel}, which is pure and
 * unit-tested so that "may I suspend this person" is one sentence rather than one per surface,
 * and the calls they make are in {@link ./membersApi}.
 */

export { default as MemberSeatsCard } from './MemberSeatsCard';
export type { MemberSeatsCardProps } from './MemberSeatsCard';

export { default as MembersTable } from './MembersTable';
export type { MembersTableProps } from './MembersTable';

export { default as InviteMemberDialog } from './InviteMemberDialog';
export type { InviteMemberDialogProps } from './InviteMemberDialog';

export { SuspendMemberDialog, OffboardMemberDialog } from './MemberLifecycleDialogs';
export type {
  SuspendMemberDialogProps,
  OffboardMemberDialogProps,
} from './MemberLifecycleDialogs';

export { default as MemberDetailDrawer } from './MemberDetailDrawer';
export type { MemberDetailDrawerProps } from './MemberDetailDrawer';

export { default as IdentityProviderCards } from './IdentityProviderCards';

export * from './membersModel';
export * from './membersApi';
