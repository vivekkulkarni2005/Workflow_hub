'use strict';

const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema(
  {
    workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: false },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: {
      type: String,
      required: true,
      enum: [
        'workspace.created',
        'workspace.updated',
        'workspace.member_added',
        'workspace.member_removed',
        'workspace.member_role_changed',
        'task.created',
        'task.updated',
        'task.deleted',
      ],
    },
    entity: { type: String, enum: ['workspace', 'task'], required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    // TTL: MongoDB removes the document automatically once this moment passes.
    expireAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * INDEX RATIONALE (ESR)
 * ------------------------------------------------------------------
 * { workspace: 1, createdAt: -1 }
 *   E : workspace        — "activity feed for workspace X"
 *   S : createdAt:-1     — newest first
 *   R : none required    — the feed is bounded by `limit`, not by a range scan.
 *
 * expireAt TTL index (single field, no ESR needed): it is not a query path, the
 * TTL monitor just needs a sorted list of expiring documents.
 */
activityLogSchema.index({ workspace: 1, createdAt: -1 });
activityLogSchema.index({ actor: 1, createdAt: -1 });
activityLogSchema.index(
  { expireAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_expire_at' }
);

activityLogSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('ActivityLog', activityLogSchema);
