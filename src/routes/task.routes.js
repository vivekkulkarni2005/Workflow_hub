'use strict';

const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authorize } = require('../middleware/authorize');
const controller = require('../controllers/task.controller');
const { STATUSES, PRIORITIES } = require('../models/Task');
const { ROLES } = require('../models/Workspace');

const router = Router({ mergeParams: true });

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a 24-char hex id');
const optionalDate = z
  .union([z.string().datetime(), z.string().date(), z.literal(''), z.null()])
  .transform((v) => (v === '' || v === null ? null : new Date(v)))
  .nullable();

const listQuery = {
  query: z.object({
    status: z
      .union([z.enum(STATUSES), z.array(z.enum(STATUSES))])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    priority: z
      .union([z.enum(PRIORITIES), z.array(z.enum(PRIORITIES))])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    assignee: z.union([objectId, z.literal('me'), z.literal('unassigned')]).optional(),
    overdue: z.enum(['true', 'false']).optional(),
    sort: z.enum(['createdAt', 'dueDate', 'priority', 'status']).optional(),
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
  }),
};

const createBody = {
  body: z
    .object({
      title: z.string().trim().min(1).max(200),
      description: z.string().max(5000).optional(),
      status: z.enum(STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      assignee: objectId.nullable().optional(),
      dueDate: optionalDate.optional(),
      labels: z.array(z.string().max(30)).max(10).optional(),
    })
    .strict(),
};

const updateBody = {
  body: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(5000).optional(),
      status: z.enum(STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      assignee: objectId.nullable().optional(),
      dueDate: optionalDate.optional(),
      labels: z.array(z.string().max(30)).max(10).optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' }),
};

const taskIdParam = { params: z.object({ taskId: objectId }) };

// Membership gate: `authorize()` with no roles = "any member may do this".
router.get('/', authorize(), validate(listQuery), asyncHandler(controller.list));
router.post('/', authorize(), validate(createBody), asyncHandler(controller.create));
router.get('/:taskId', authorize(), validate(taskIdParam), asyncHandler(controller.getOne));

// Editing/deleting is restricted to admins and owners; members are read-only.
router.patch(
  '/:taskId',
  authorize(['admin', 'owner']),
  validate(taskIdParam),
  validate(updateBody),
  asyncHandler(controller.update)
);
router.delete(
  '/:taskId',
  authorize(['admin', 'owner']),
  validate(taskIdParam),
  asyncHandler(controller.remove)
);

module.exports = router;
module.exports.ROLES = ROLES;
