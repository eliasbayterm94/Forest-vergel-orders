/**
 * Scheduled function: weekly digest.
 *
 * Cron: "0 2 * * 1" → every Monday 02:00 UTC = Sunday 21:00 America/Bogota
 * (Colombia does not observe DST, so this stays stable year-round.)
 *
 * The schedule is registered via the schedule() wrapper from
 * @netlify/functions — it cannot be configured via netlify.toml alone.
 */

'use strict';

const { schedule } = require('@netlify/functions');
const { getSupabase, getDryingDaysByProcess, getProcessingDaysByProcess } = require('./_lib/supabase');
const { composeWeeklyDigest } = require('./_lib/digest');
const { dispatch } = require('./_lib/notifications');

const handler = async () => {
  try {
    const sb = getSupabase();
    const dryingDaysByProcess     = await getDryingDaysByProcess();
    const processingDaysByProcess = await getProcessingDaysByProcess();
    const { subject, text, html, summary } = await composeWeeklyDigest({ sb, dryingDaysByProcess, processingDaysByProcess });
    const result = await dispatch({ event_type: 'weekly_digest', subject, text, html });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, summary, dispatch: result }),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('weekly-digest failed:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

exports.handler = schedule('0 2 * * 1', handler);
