'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const env = require('../config/env');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true, // creates a unique index -> fast, enforced email lookup on login
      lowercase: true,
      trim: true,
      index: true,
    },
    // Never selected by default: `passwordHash` must not leak into API responses.
    passwordHash: { type: String, required: true, select: false },
    avatarColor: { type: String, default: '#6366f1' },
    lastSeenAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        // Defence in depth: the field is already `select: false`, so it is only
        // present when a query explicitly asked for it. Strip it anyway.
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/**
 * INDEX RATIONALE (ESR = Equality, Sort, Range)
 * ---------------------------------------------------------------
 * unique(email)  : E on `email` — every login/registration is a point lookup
 *                  and the unique constraint is what prevents duplicates
 *                  (two users racing on the same email fail with E11000).
 * {createdAt:-1} : S with no R — the "newest members" list is served straight
 *                  from the index instead of an in-memory sort.
 */
userSchema.index({ createdAt: -1 });

/** Hash a plaintext password with bcrypt. */
userSchema.statics.hashPassword = function hashPassword(plain) {
  return bcrypt.hash(plain, env.bcryptRounds);
};

/** Constant-time compare of a plaintext candidate against the stored hash. */
userSchema.methods.verifyPassword = function verifyPassword(plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

module.exports = mongoose.model('User', userSchema);
