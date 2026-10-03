'use strict';

const env = require('../config/env');
const AppError = require('./AppError');

/**
 * Opaque keyset ("seek") cursor for stable pagination.
 *
 * Why not OFFSET/LIMIT? `skip: 100000` makes MongoDB walk and discard 100k
 * documents on every page — cost grows linearly with page number. A keyset
 * cursor remembers the last document's sort key and continues from there, so
 * every page costs the same O(log n) index seek, and rows inserted mid-scroll
 * never shift the window.
 *
 * The cursor value mirrors the FULL sort specification, field by field. That is
 * not optional: sorting by `dueDate` with a cursor that only remembers
 * `createdAt` silently skips and duplicates rows the moment two tasks share a
 * due date, because the continuation predicate no longer describes the sort.
 * `_id` is therefore appended to every sort spec as the final tie-breaker.
 */
function sortFields(sortSpec) {
  return Object.keys(sortSpec);
}

/** Reads the cursor's sort key out of a mongoose document, per field. */
function sortValue(doc, field) {
  if (field === '_id') return doc._id;
  const value = doc[field];
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * @param {object} doc        last document of the current page
 * @param {object} sortSpec   mongo sort spec, e.g. `{ createdAt: -1, _id: -1 }`
 * @param {string} sortKey    client-facing name of the sort (echoed back so a
 *                            cursor can never be replayed against another sort)
 */
function encodeCursor(doc, sortSpec, sortKey) {
  if (!doc) return null;
  const fields = sortFields(sortSpec);
  const v = {};
  for (const field of fields) v[field] = sortValue(doc, field);
  return Buffer.from(JSON.stringify({ s: sortKey, v })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.s !== 'string' || !parsed.v || typeof parsed.v !== 'object') {
      throw new Error('malformed');
    }
    return { sort: parsed.s, values: parsed.v };
  } catch {
    throw AppError.badRequest('Malformed pagination cursor', 'INVALID_CURSOR');
  }
}

/**
 * Builds the `$or` continuation predicate for an arbitrary sort spec.
 *
 * For `sort({ createdAt: -1, _id: -1 })` and cursor `{ createdAt, _id }`:
 *   { $or: [ { createdAt: { $lt: c } },
 *            { createdAt: c, _id: { $lt: i } } ] }
 *
 * For a longer sort the branches extend one field at a time, so the predicate is
 * always exactly the set of documents that sort strictly after the cursor.
 */
function cursorFilter(cursor, sortSpec, sortKey) {
  if (!cursor) return null;
  if (cursor.sort !== sortKey) {
    // A cursor is only meaningful for the sort that produced it. Rejecting it is
    // better than silently returning a wrong page.
    throw AppError.badRequest(
      `This cursor belongs to sort="${cursor.sort}" but the request asked for sort="${sortKey}".`,
      'CURSOR_SORT_MISMATCH'
    );
  }

  const fields = sortFields(sortSpec);
  const clauses = [];
  for (let i = 0; i < fields.length; i += 1) {
    // "everything before this field matched, now compare on this one"
    const eq = {};
    for (let j = 0; j < i; j += 1) {
      eq[fields[j]] = coerce(fields[j], cursor.values[fields[j]]);
    }
    const field = fields[i];
    const direction = sortSpec[field] < 0 ? '$lt' : '$gt';
    clauses.push({ ...eq, [field]: { [direction]: coerce(field, cursor.values[field]) } });
  }
  return { $or: clauses };
}

/** JSON has no Date, so date-ish sort keys travel as ISO strings. */
function coerce(field, value) {
  if (value === null || value === undefined) return null;
  if (field === '_id') return value; // Mongoose casts the hex string back to ObjectId
  if (field.endsWith('At') || field.endsWith('Date')) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw AppError.badRequest('Malformed pagination cursor', 'INVALID_CURSOR');
    return date;
  }
  return value;
}

function parseLimit(raw) {
  const limit = Number.parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit < 1) return env.pagination.defaultLimit;
  return Math.min(limit, env.pagination.maxLimit);
}

module.exports = { encodeCursor, decodeCursor, cursorFilter, parseLimit, sortFields };
