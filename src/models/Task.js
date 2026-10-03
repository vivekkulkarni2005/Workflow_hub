'use strict';

const mongoose = require('mongoose');

const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const taskSchema = new mongoose.Schema(
  {
    workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 5000 },
    status: { type: String, enum: STATUSES, default: 'todo', index: false },
    priority: { type: String, enum: PRIORITIES, default: 'medium' },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    dueDate: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    labels: { type: [String], default: [], index: false },
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * INDEX RATIONALE (ESR)
 * ==================================================================
 * 1) { workspace: 1, createdAt: -1, _id: -1 }   (default task list, cursor paging)
 *    E : workspace          (equality — always scoped to one workspace)
 *    S : createdAt:-1       (sort — newest first, the default UI order)
 *    R : _id:-1             (range — the cursor predicate
 *                            `createdAt < c OR (createdAt = c AND _id < id)`
 *                            is answered by walking this index; no COLLSCAN,
 *                            no in-memory SORT stage, and paging stays O(log n))
 *
 * 2) { workspace: 1, status: 1, dueDate: 1, _id: 1 }   (board columns / overdue)
 *    E : workspace, status (equality on the column being rendered)
 *    S : dueDate:1         (sort — due-soonest first; overdue = dueDate < now)
 *    R : _id:1             (range/cursor tie-break)
 *
 * 3) { workspace: 1, status: 1, assignee: 1 }   (REPORT endpoint, see report.service.js)
 *    E : workspace          (equality — one workspace)
 *    E : status             ($in: ['todo','doing'] — still a bounded set of
 *                            key ranges, so it belongs BEFORE the sort/group key;
 *                            putting `assignee` first would make `status` a
 *                            non-contiguous filter and force extra key probes)
 *    S : assignee:1         ($group by assignee is served in index order, so the
 *                            $group stage never spills to a hash/spill partition
 *                            and the $lookup on users is issued in ascending key
 *                            order — one sequential index probe per group)
 *    This is the index the benchmark measures: it cuts docsExamined from the whole
 *    collection down to only that workspace's open tasks.
 *
 * 4) { assignee: 1, status: 1, dueDate: 1 }   ("my open tasks" across workspaces)
 *    E : assignee, status;  S : dueDate
 *
 * Deliberately NOT indexed: title/description (free text), labels (low cardinality
 * per workspace and only ever filtered after workspace) — indexing them costs write
 * throughput and buys nothing for the access patterns above.
 */
taskSchema.index({ workspace: 1, createdAt: -1, _id: -1 });
taskSchema.index({ workspace: 1, status: 1, dueDate: 1, _id: 1 });
taskSchema.index({ workspace: 1, status: 1, assignee: 1 });
taskSchema.index({ assignee: 1, status: 1, dueDate: 1 });

taskSchema.virtual('id').get(function id() {
  return this._id.toString();
});

taskSchema.pre('save', function stampCompleted(next) {
  if (this.isModified('status')) {
    this.completedAt = this.status === 'done' ? new Date() : null;
  }
  next();
});

taskSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Task', taskSchema);
module.exports.STATUSES = STATUSES;
module.exports.PRIORITIES = PRIORITIES;
