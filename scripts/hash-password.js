#!/usr/bin/env node
/**
 * Generate a bcrypt hash (rounds=12).
 *
 * Users and passwords now live in the `users` table, so you normally
 * don't need this: create users from /admin/config, and reset a
 * forgotten password from the Supabase SQL Editor with
 *   UPDATE users SET password_hash = crypt('new', gen_salt('bf', 12)) ...
 *
 * Still useful for the legacy bootstrap env vars
 * (FOREST / FINCA / ADMIN_PASSWORD_HASH), or to produce a hash offline
 * when you'd rather not type the password into the SQL Editor.
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
