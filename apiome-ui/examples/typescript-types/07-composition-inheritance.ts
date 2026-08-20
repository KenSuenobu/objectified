/**
 * Within-document composition: interface extension from two parents, intersection
 * aliases, a generic instantiated locally, and a union assembled from the results.
 */

export interface Timestamped {
  createdAt: string;
  updatedAt?: string;
}

export interface Identified {
  id: string;
}

/** Extension from two interfaces: members merge. */
export interface Record extends Identified, Timestamped {
  label: string;
}

export interface ActiveRecord extends Record {
  status: 'active';
  updatedAt: string;
}

export interface ArchivedRecord extends Record {
  status: 'archived';
  archivedAt: string;
}

export type AnyRecord = ActiveRecord | ArchivedRecord;

/** Intersection alias rather than interface extension — the other composition form. */
export type AuditedRecord = Record & {
  auditedBy: string;
  auditedAt: string;
};

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor?: string;
}

/** Generic instantiated in this file, so it is resolvable. */
export type RecordPage = Page<AnyRecord>;

export interface RecordSet {
  active: ActiveRecord[];
  archived: ArchivedRecord[];
  byId: Record2Map;
  page?: RecordPage;
}

/** Index signature over a composed type. */
export interface Record2Map {
  [id: string]: AnyRecord;
}
