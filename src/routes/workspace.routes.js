'use strict';

const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const controller = require('../controllers/workspace.controller');
const taskRoutes = require('./task.routes');
const { ROLES } = require('../models/Workspace');

const router = Router();

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a 24-char hex id');
const workspaceParam = { params: z.object({ workspaceId: objectId }) };
const userIdParam = { params: z.object({ userId: objectId }) };

router.use(authenticate);

router.post(
  '/',
  validate({
    body: z
      .object({
        name: z.string().trim().min(2).max(120),
        description: z.string().max(1000).optional(),
      })
      .strict(),
  }),
  asyncHandler(controller.create)
);

router.get(
  '/',
  validate({
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    }),
  }),
  asyncHandler(controller.list)
);

// Membership check happens in `authorize`; controller falls back to slug lookup.
router.get('/:workspaceId', authorize(), validate(workspaceParam), asyncHandler(controller.getOne));

router.patch(
  '/:workspaceId',
  authorize(['admin', 'owner']),
  validate(workspaceParam),
  validate({
    body: z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        description: z.string().max(1000).optional(),
        archivedAt: z.string().datetime().nullable().optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' }),
  }),
  asyncHandler(controller.update)
);

router.delete(
  '/:workspaceId',
  authorize('owner'),
  validate(workspaceParam),
  asyncHandler(controller.remove)
);

/* ---------------------------- membership ---------------------------- */
router.get('/:workspaceId/members', authorize(), validate(workspaceParam), asyncHandler(controller.listMembers));

router.post(
  '/:workspaceId/members',
  authorize(['admin', 'owner']),
  validate(workspaceParam),
  validate({ body: z.object({ userId: objectId, role: z.enum(ROLES).optional() }).strict() }),
  asyncHandler(controller.addMember)
);

router.delete(
  '/:workspaceId/members/:userId',
  authorize(['admin', 'owner']),
  validate(workspaceParam),
  validate(userIdParam),
  asyncHandler(controller.removeMember)
);

router.patch(
  '/:workspaceId/members/:userId',
  authorize(['admin', 'owner']),
  validate(workspaceParam),
  validate(userIdParam),
  validate({ body: z.object({ role: z.enum(['admin', 'member']) }).strict() }),
  asyncHandler(controller.changeRole)
);

/* -------------------- activity + report + tasks --------------------- */
router.get(
  '/:workspaceId/activity',
  authorize(),
  validate(workspaceParam),
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }) }),
  asyncHandler(controller.activity)
);

router.get(
  '/:workspaceId/reports',
  authorize(),
  validate(workspaceParam),
  asyncHandler(controller.report)
);

// Nested task router: every route below also re-runs the membership check.
router.use('/:workspaceId/tasks', taskRoutes);

module.exports = router;
