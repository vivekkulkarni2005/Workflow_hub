'use strict';

const AppError = require('../utils/AppError');

/**
 * Zod-backed request validation.
 *
 * `validate({ body, query, params })` — each key is a Zod schema. The parsed
 * (coerced, stripped) value REPLACES the raw body, so downstream controllers can
 * trust the shape. Unknown body keys are rejected by `.strict()` schemas, which
 * is how a typo like `assigne` fails loudly instead of silently doing nothing.
 *
 * `params` and `query` are MERGED instead of replaced: several route params
 * travel through the same object (`workspaceId` + `taskId`), and replacing it
 * with a single-field schema would delete the fields another layer still needs.
 */
function validate(schemas) {
  return (req, _res, next) => {
    for (const source of ['params', 'query', 'body']) {
      const schema = schemas[source];
      if (!schema) continue;
      const result = schema.safeParse(req[source]);
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          field: [source, ...issue.path].join('.'),
          message: issue.message,
          code: issue.code,
        }));
        return next(AppError.unprocessable('Request validation failed', details));
      }
      req[source] =
        source === 'body' ? result.data : { ...req[source], ...result.data };
    }
    return next();
  };
}

module.exports = { validate };
