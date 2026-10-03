'use strict';

const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/authenticate');
const { authRateLimit } = require('../middleware/rateLimit');
const controller = require('../controllers/auth.controller');

const router = Router();

/* --------------------------- validation --------------------------- */
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a 24-char hex id');

const registerSchema = {
  body: z
    .object({
      name: z.string().trim().min(2).max(80),
      email: z.string().trim().toLowerCase().email(),
      // 10+ chars with a mix of classes: resists short/weak passwords without
      // the friction of arbitrary composition rules.
      password: z
        .string()
        .min(10, 'password must be at least 10 characters')
        .max(128)
        .regex(/[a-z]/, 'password needs a lowercase letter')
        .regex(/[A-Z]/, 'password needs an uppercase letter')
        .regex(/\d/, 'password needs a number'),
    })
    .strict(),
};

const loginSchema = {
  body: z
    .object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(1).max(128),
    })
    .strict(),
};

const refreshSchema = {
  body: z
    .object({
      refreshToken: z.string().optional(),
    })
    .strict()
    .default({}),
};

/* ----------------------------- routes ----------------------------- */
// The stricter Redis-backed limiter guards every credential endpoint.
router.post('/register', authRateLimit, validate(registerSchema), asyncHandler(controller.register));
router.post('/login', authRateLimit, validate(loginSchema), asyncHandler(controller.login));
router.post('/refresh', authRateLimit, validate(refreshSchema), asyncHandler(controller.refresh));
router.post('/logout', asyncHandler(controller.logout));
router.get('/me', authenticate, asyncHandler(controller.me));

module.exports = router;
module.exports.schemas = { objectId };
