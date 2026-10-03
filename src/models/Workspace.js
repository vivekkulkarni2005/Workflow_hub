'use strict';

const mongoose = require('mongoose');

const ROLES = ['owner', 'admin', 'member'];
/** Capability matrix used by `authorize()` middleware (see src/middleware/authorize.js). */
const ROLE_RANK = { member: 1, admin: 2, owner: 3 };

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, default: 'member' },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const workspaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: '', maxlength: 1000 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: { type: [memberSchema], default: [] },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * INDEX RATIONALE (ESR)
 * ------------------------------------------------------------------
 * { members.user: 1, updatedAt: -1, _id: -1 }
 *   E (Equality) : members.user  -> "list the workspaces I belong to" hits this
 *                                  index and never scans the collection.
 *   S (Sort)      : updatedAt:-1  -> the dashboard renders most-recently-touched
 *                                  first, so the index supplies the ordering.
 *   R (Range)     : _id:-1        -> unique tie-breaker for stable cursor paging
 *                                  (equal updatedAt values still page correctly).
 *   Equality fields MUST come first in a compound index: that is the whole point
 *   of ESR. Putting updatedAt first would make the membership filter a scan.
 *
 * unique(slug) : E on slug for public URL resolution (GET /workspaces/:slugOrId).
 */
workspaceSchema.index({ 'members.user': 1, updatedAt: -1, _id: -1 });
workspaceSchema.index({ owner: 1, createdAt: -1 });

workspaceSchema.virtual('id').get(function id() {
  return this._id.toString();
});

/** Role of `userId` inside this workspace, or null when not a member. */
workspaceSchema.methods.roleOf = function roleOf(userId) {
  const id = String(userId);
  const member = this.members.find((m) => String(m.user) === id || String(m.user?._id) === id);
  return member ? member.role : null;
};

workspaceSchema.methods.hasRole = function hasRole(userId, allowed) {
  const role = this.roleOf(userId);
  if (!role) return false;
  const needed = Array.isArray(allowed) ? allowed : [allowed];
  return needed.includes(role);
};

workspaceSchema.methods.addMember = function addMember(userId, role = 'member') {
  if (this.roleOf(userId)) return this;
  this.members.push({ user: userId, role, joinedAt: new Date() });
  return this;
};

workspaceSchema.methods.removeMember = function removeMember(userId) {
  const id = String(userId);
  const before = this.members.length;
  this.members = this.members.filter((m) => String(m.user) !== id);
  return this.members.length !== before;
};

workspaceSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Workspace', workspaceSchema);
module.exports.ROLES = ROLES;
module.exports.ROLE_RANK = ROLE_RANK;
