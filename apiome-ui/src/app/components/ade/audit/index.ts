/**
 * The access-audit surface — HIVE-5.5 (#5308).
 *
 * `/ade/dashboard/audit`: the append-only, hash-chained record of every access and permission
 * change in a workspace, and the per-entry drawer this ticket adds. The page composes these;
 * the derivations they share are in {@link ./auditModel}, which is pure and unit-tested, and
 * the two calls they make are in {@link ./auditApi}.
 */

export { default as AuditTable } from './AuditTable';
export type { AuditTableProps } from './AuditTable';

export { default as AuditEventDrawer } from './AuditEventDrawer';
export type { AuditEventDrawerProps } from './AuditEventDrawer';

export * from './auditModel';
export * from './auditApi';
