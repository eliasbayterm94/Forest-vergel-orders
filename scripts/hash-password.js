#!/usr/bin/env node
/**
 * Generate a bcrypt hash for one of the role passwords
 * (FOREST / FINCA / ADMIN PASSWORD_HASH env vars).
 *
 * Usage:
 *   node scripts/hash-password.js "the-password"
 */

'use strict';

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "the-password"');
  process.exit(1);
}

const ROUNDS = 12;
const hash = bcrypt.hashSync(password, ROUNDS);
process.stdout.write(`${hash}\n`);
