'use strict';

const taskService = require('../services/task.service');
const reportService = require('../services/report.service');
const { getIO } = require('../sockets');

const room = (workspaceId) => `ws:${workspaceId}`;

/**
 * Every mutation follows the same order: write to Mongo -> invalidate the
 * cached report -> broadcast to the workspace room. Broadcasting only AFTER a
 * successful write means clients can never see an event for a task that does
 * not exist (or already has a different state).
 */
async function create(req, res) {
  const task = await taskService.create(req.workspace, req.userId, req.body);
  await reportService.invalidateWorkspaceReport(req.workspace._id);

  const payload = { task, workspaceId: String(req.workspace._id) };
  getIO()?.to(room(task.workspace)).emit('task:created', payload);

  res.status(201).json({ task });
}

async function list(req, res) {
  const result = await taskService.list(req.workspace._id, { ...req.query, userId: req.userId });
  res.json(result);
}

async function getOne(req, res) {
  const task = await taskService.getById(req.workspace._id, req.params.taskId);
  res.json({ task });
}

async function update(req, res) {
  const task = await taskService.update(req.workspace, req.userId, req.params.taskId, req.body);
  await reportService.invalidateWorkspaceReport(req.workspace._id);

  getIO()?.to(room(task.workspace)).emit('task:updated', {
    task,
    workspaceId: String(task.workspace),
    updatedBy: req.userId,
  });

  res.json({ task });
}

async function remove(req, res) {
  const task = await taskService.remove(req.workspace, req.userId, req.params.taskId);
  await reportService.invalidateWorkspaceReport(req.workspace._id);

  getIO()?.to(room(task.workspace)).emit('task:deleted', {
    taskId: String(task._id),
    workspaceId: String(task.workspace),
    deletedBy: req.userId,
  });

  res.status(204).send();
}

module.exports = { create, list, getOne, update, remove };
