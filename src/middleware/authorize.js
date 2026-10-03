'use strict';

const Workspace = require('../models/Workspace');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../config/logger');

/**
 * `authorize(...roles)` — RBAC gate that runs *after* `authenticate`.
 *
 * Two modes:
 *   - no args  -> the user must be a member of :workspaceId (any role)
 *   - with args-> the user must be a member AND hold one of the listed roles
 *
 * The loaded workspace is cached on `req.workspace` so controllers never
 * re-query it. Role rank: member(1) < admin(2) < owner(3).
 */
const authorize = (...roles) =>
  asyncHandler(async (req, _res, next) => {
    const { workspaceId } = req.params;
    if (!workspaceId) {
      throw AppError.badRequest('workspaceId is required', 'MISSING_WORKSPACE_ID');
    }

    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) throw AppError.notFound('Workspace not found', 'WORKSPACE_NOT_FOUND');

    const role = workspace.roleOf(req.userId);
    if (!role) {
      logger.warn(
        { userId: req.userId, workspaceId },
        'authorization denied: not a member'
      );
      throw AppError.forbidden('You are not a member of this workspace', 'NOT_A_MEMBER');
    }

    if (roles.length) {
      const allowed = roles.flat();
      if (!allowed.includes(role)) {
        logger.warn({ userId: req.userId, workspaceId, role, allowed }, 'authorization denied: role');
        throw AppError.forbidden(
          `Requires role ${allowed.join(' or ')}, you are ${role}`,
          'INSUFFICIENT_ROLE'
        );
      }
    }

    req.workspace = workspace;
    req.workspaceRole = role;
    next();
  });

module.exports = { authorize };
