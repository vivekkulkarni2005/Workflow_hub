'use strict';

const { Router } = require('express');
const env = require('../config/env');
const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const { getClient } = require('../config/redis');
const authRoutes = require('./auth.routes');
const workspaceRoutes = require('./workspace.routes');

const router = Router();

/** Liveness: is the process up? Deliberately dependency-free. */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'workflow-hub',
    uptime: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
  });
});

/** Readiness: are the dependencies usable? Used by the load balancer / k8s probe. */
router.get('/health/ready', asyncHandler(async (req, res) => {
  const checks = { mongo: 'down', redis: 'down' };
  checks.mongo = mongoose.connection.readyState === 1 ? 'up' : 'down';
  try {
    const client = getClient();
    checks.redis = client && (await client.ping()) === 'PONG' ? 'up' : 'down';
  } catch {
    checks.redis = 'down';
  }
  const ready = Object.values(checks).every((v) => v === 'up');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', checks });
}));

router.get('/', (req, res) => {
  res.json({
    name: 'workflow-hub',
    version: require('../../package.json').version,
    env: env.nodeEnv,
    endpoints: {
      auth: '/api/v1/auth',
      workspaces: '/api/v1/workspaces',
      health: '/health',
      sockets: '/socket.io',
    },
  });
});

// Versioned API surface.
const v1 = Router();
v1.use('/auth', authRoutes);
v1.use('/workspaces', workspaceRoutes);
router.use('/api/v1', v1);

module.exports = router;
