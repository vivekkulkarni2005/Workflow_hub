'use strict';

const ActivityLog = require('../models/ActivityLog');
const logger = require('../config/logger');

/**
 * Fire-and-forget audit trail. Never throws into the request path: an audit
 * failure must not roll back the business operation that already succeeded.
 */
async function logActivity({ workspace, actor, action, entity, entityId, meta = {} }) {
  try {
    await ActivityLog.create({
      workspace,
      actor,
      action,
      entity,
      entityId,
      meta,
      expireAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days, TTL index
    });
  } catch (err) {
    logger.error({ err: err.message, action }, 'failed to write activity log');
  }
}

module.exports = { logActivity };
