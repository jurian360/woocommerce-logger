import mongoose, { type InferSchemaType, type Model } from 'mongoose';

// Mongoose ships as CommonJS: destructuring the default export keeps this file
// importable from bundlers *and* from a plain ESM runtime (test scripts, scripts/).
const { Schema, model, models } = mongoose;

/**
 * Who performed the change. Kept as a sub-document (no _id) so the shape is
 * enforced but the row stays compact.
 */
const AdminSchema = new Schema(
  {
    id: { type: Number, default: 0 },
    user: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    roles: { type: [String], default: undefined },
  },
  { _id: false }
);

/**
 * What changed.
 *
 * The known WooCommerce groups are declared for documentation and query
 * ergonomics, but every value is `Mixed` and the schema is non-strict: the
 * WordPress side can start tracking new props (weight, tax class, ...) without
 * a deploy here, and they will still be persisted and rendered.
 *
 * Expected shape (all keys optional):
 *   price:              { regular_price: { from, to }, sale_price: { from, to } }
 *   stock:              { stock_quantity: { from, to }, stock_status: { from, to } }
 *   status:             { from: 'draft',   to: 'publish' }
 *   catalog_visibility: { from: 'visible', to: 'hidden'  }
 */
const ChangesSchema = new Schema(
  {
    price: { type: Schema.Types.Mixed, default: undefined },
    stock: { type: Schema.Types.Mixed, default: undefined },
    status: { type: Schema.Types.Mixed, default: undefined },
    catalog_visibility: { type: Schema.Types.Mixed, default: undefined },
  },
  { _id: false, strict: false, minimize: true }
);

const AuditLogSchema = new Schema(
  {
    product_id: { type: Number, required: true, index: true },
    /** Set for variations; 0 for simple/variable parent products. */
    parent_id: { type: Number, default: 0 },
    sku: { type: String, default: '', trim: true, index: true },
    name: { type: String, default: '' },
    currency: { type: String, default: '' },
    /** Origin site — lets one deployment receive from multiple shops. */
    site: { type: String, default: '' },
    /** 'admin' | 'ajax' | 'rest' | 'frontend' */
    source: { type: String, default: '' },
    permalink: { type: String, default: '' },
    edit_link: { type: String, default: '' },
    /** True when the save created the product rather than updating it. */
    is_new: { type: Boolean, default: false },

    admin: { type: AdminSchema, default: () => ({}) },

    /** When the change happened in WordPress. */
    timestamp: { type: Date, required: true, default: () => new Date() },
    /** When this API received it — useful to spot clock skew or retries. */
    received_at: { type: Date, default: () => new Date() },

    changes: { type: ChangesSchema, default: () => ({}) },
  },
  {
    collection: 'audit_logs',
    versionKey: false,
    minimize: true,
  }
);

// Dashboard query: newest first. Also serves the day filter and the retention
// purge, which both select on `timestamp` alone.
AuditLogSchema.index({ timestamp: -1 });
// Per-product history.
AuditLogSchema.index({ product_id: 1, timestamp: -1 });
// Dashboard SKU search combined with the day filter and the newest-first sort.
AuditLogSchema.index({ sku: 1, timestamp: -1 });

export type AuditLogDocument = InferSchemaType<typeof AuditLogSchema>;

/**
 * `models.AuditLog ||` guard: Next.js re-evaluates modules on hot reload, and
 * re-registering a model throws `OverwriteModelError`.
 */
const AuditLog: Model<AuditLogDocument> =
  (models.AuditLog as Model<AuditLogDocument>) ||
  model<AuditLogDocument>('AuditLog', AuditLogSchema);

export default AuditLog;
