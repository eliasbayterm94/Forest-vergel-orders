#!/usr/bin/env node
/**
 * Generate a random base64url secret for JWT_SECRET.
 *
 * Usage:
 *   node scripts/generate-secret.js          # 48 random bytes (default)
 *   node scripts/generate-secret.js 64       # custom byte length
 */

'use strict';

const crypto = require('node:crypto');

const bytes = parseInt(process.argv[2] || '48', 10);
if (!Number.isFinite(bytes) || bytes < 32) {
  console.error('Byte length must be an integer >= 32');
  process.exit(1);
}
process.stdout.write(`${crypto.randomBytes(bytes).toString('base64url')}\n`);
