/**
 * Gmail API wrapper — sends transactional + digest emails via the same
 * OAuth refresh token used by other Forest apps.
 *
 * If EMAIL_DRY_RUN === 'true' (default), no real send is performed; the
 * call resolves with { dryRun: true } and the caller logs it as such.
 */

'use strict';

const { google } = require('googleapis');

let _client = null;

function isDryRun() {
  return (process.env.EMAIL_DRY_RUN || 'true').toLowerCase() !== 'false';
}

function getGmail() {
  if (_client) return _client;
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail OAuth env vars missing (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
  }
  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2.setCredentials({ refresh_token: refreshToken });
  _client = google.gmail({ version: 'v1', auth: oAuth2 });
  return _client;
}

function getFromAddress() {
  return process.env.GMAIL_FROM_ADDRESS || 'me';
}

/** Build a base64url-encoded RFC 822 message. */
function buildRawMessage({ from, to, subject, text, html }) {
  const boundary = `fvb_${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    text || '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html || `<pre>${escapeHtml(text || '')}</pre>`,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const raw = `${headers}\r\n\r\n${body}`;
  return Buffer.from(raw, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @returns {Promise<{ dryRun: boolean, messageId?: string }>}
 */
async function sendEmail({ to, subject, text, html }) {
  if (!to || (Array.isArray(to) && to.length === 0)) {
    throw new Error('sendEmail: "to" is required');
  }
  if (isDryRun()) {
    return { dryRun: true };
  }
  const gmail = getGmail();
  const raw = buildRawMessage({ from: getFromAddress(), to, subject, text, html });
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { dryRun: false, messageId: res.data && res.data.id };
}

module.exports = { sendEmail, isDryRun, buildRawMessage };
