/**
 * POST /api/daily-new-orders-trigger  (admin)
 * Dispara el daily digest manualmente. Util para test o reenvio.
 */

'use strict';

const { requireAuth } = require('./_lib/auth');
const { getSupabase } = require('./_lib/supabase');
const { composeDailyNewOrdersDigest } = require('./_lib/dailyDigest');
const { dispatch, farmAndAdminRecipients } = require('./_lib/notifications');
const { ok, serverErr, methodNotAllowed } = require('./_lib/respond');

exports.handler = requireAuth(['admin'], async (event) => {
  if (event.httpMethod !== 'POST') return methodNotAllowed(['POST']);
  try {
    const sb = getSupabase();
    const result = await composeDailyNewOrdersDigest({ sb });
    if (result.skip) {
      return ok({ skipped: true, reason: result.reason });
    }
    const dispatchResult = await dispatch({
      event_type: 'daily_new_orders',
      subject: result.subject,
      text: result.text,
      recipients: farmAndAdminRecipients(),
    });
    return ok({ summary: result.summary, dispatch: dispatchResult });
  } catch (err) {
    return serverErr('daily digest failed', err.message);
  }
});
