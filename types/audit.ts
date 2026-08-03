/**
 * Shared payload/record types for the audit log.
 *
 * The WordPress plugin sends every tracked field as a `{ from, to }` pair, but
 * the Mongoose `changes` sub-document is intentionally non-strict, so raw
 * scalar values are accepted and rendered too.
 */

export interface FieldDelta<T = unknown> {
  from: T;
  to: T;
}

export interface PriceChanges {
  regular_price?: FieldDelta<string | number | null>;
  sale_price?: FieldDelta<string | number | null>;
  [key: string]: unknown;
}

export interface StockChanges {
  stock_quantity?: FieldDelta<number | null>;
  stock_status?: FieldDelta<string>;
  manage_stock?: FieldDelta<boolean>;
  [key: string]: unknown;
}

export interface AuditChanges {
  price?: PriceChanges;
  stock?: StockChanges;
  /** e.g. 'publish' | 'draft' | 'pending' | 'private' | 'trash' */
  status?: FieldDelta<string> | string;
  /** e.g. 'visible' | 'catalog' | 'search' | 'hidden' */
  catalog_visibility?: FieldDelta<string> | string;
  [key: string]: unknown;
}

export interface AuditAdmin {
  id: number;
  user: string;
  email: string;
  roles?: string[];
}

/** Shape of a document as read back from MongoDB and rendered by the dashboard. */
export interface AuditLogRecord {
  _id: string;
  product_id: number;
  parent_id?: number;
  sku: string;
  name?: string;
  currency?: string;
  site?: string;
  source?: string;
  permalink?: string;
  edit_link?: string;
  is_new?: boolean;
  admin: AuditAdmin;
  timestamp: Date;
  changes: AuditChanges;
  received_at?: Date;
}
