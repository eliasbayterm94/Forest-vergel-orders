/**
 * Scheduled function: daily digest de pedidos nuevos.
 *
 * Cron: "0 12 * * *" → 12 UTC = 07:00 America/Bogota (sin DST).
 * Corre todos los dias. Si en las ultimas 24h no hubo pedidos nuevos,
 * no envia email (skip silencioso).
 */

'use strict';

const { schedule } = require('@netlify/functions');
const { getSupabase } = require('./_lib/supabase');
const { composeDailyNewOrdersDigest } = require('./_lib/dailyDigest');
const { dispatch, farmAndAdminRecipients } = require('./_lib/notifications');

const handler = async () => {
  try {
    const sb = getSupabase();
    const result = await composeDailyNewOrdersDigest({ sb });
    if (result.skip) {
      // eslint-disable-next-line no-console
      console.log('daily-new-orders-digest: skipped (no new orders in last 24h)');
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
    }
    const dispatchResult = await dispatch({
      event_type: 'daily_new_orders',
      subject: result.subject,
      text: result.text,
      recipients: farmAndAdminRecipients(),
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, summary: result.summary, dispatch: dispatchResult }),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('daily-new-orders-digest failed:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

exports.handler = schedule('0 12 * * *', handler);
