/**
 * Admin manual trigger for the weekly digest.
 * Same composer + same dispatcher as the scheduled function — useful
 * for verification, testing, or one-off ad-hoc reports.
 */

'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase, getDryingDaysByProcess } = require('./_lib/supabase');
const { composeWeeklyDigest } = require('./_lib/digest');
const { dispatch } = require('./_lib/notifications');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  try {
    const sb = getSupabase();
    const dryingDaysByProcess = await getDryingDaysByProcess();
    const { subject, text, html, summary } = await composeWeeklyDigest({ sb, dryingDaysByProcess });
    const result = await dispatch({ event_type: 'weekly_digest', subject, text, html });
    return ok({ ok: true, summary, dispatch: result, subject });
  } catch (err) {
    return serverErr('Digest failed', err.message);
  }
});
