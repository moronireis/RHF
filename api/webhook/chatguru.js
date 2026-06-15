/**
 * ChatGuru Webhook Receiver — Vercel Serverless Function
 *
 * Receives webhook POSTs from ChatGuru and stores in Supabase.
 * URL: https://rhf-proposta.vercel.app/api/webhook/chatguru
 */

import { select, insert } from '../../lib/supabase.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Health check
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      service: 'RHF Talentos Webhook',
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body;

    console.log('[Webhook] Received:', JSON.stringify(payload));

    // Extract fields from ChatGuru webhook
    const {
      nome,
      celular,
      texto_mensagem,
      tipo_mensagem = 'chat',
      phone_id,
      chat_id,
      email,
      url_arquivo,
    } = payload;

    // Normalize phone number
    const phone = (celular || '').replace(/\D/g, '');

    if (!phone) {
      console.log('[Webhook] No phone number in payload, skipping');
      return res.status(200).json({ status: 'skipped', reason: 'no phone' });
    }

    // 1. Upsert candidate
    const existing = await select('candidates', `phone=eq.${phone}&select=id`);

    let candidateId;
    if (Array.isArray(existing) && existing.length > 0) {
      candidateId = existing[0].id;
    } else if (nome && phone) {
      const inserted = await insert('candidates', {
        name: nome,
        phone,
        email: email || null,
        chatguru_chat_id: chat_id || null,
        chatguru_phone_id: phone_id || null,
        status: 'new',
        raw_data: payload,
      });
      candidateId = Array.isArray(inserted) && inserted[0] ? inserted[0].id : null;
    }

    // 2. Store message
    await insert('rhf_messages', {
      phone,
      direction: 'inbound',
      content: texto_mensagem || url_arquivo || '[media]',
      message_type: tipo_mensagem || 'chat',
      chatguru_chat_id: chat_id || null,
      candidate_id: candidateId || null,
      raw_webhook: payload,
    });

    // 3. Log sync event
    await insert('sync_log', {
      source: 'chatguru',
      action: 'webhook_received',
      entity_type: 'message',
      entity_id: chat_id || phone,
      status: 'success',
      payload: {
        nome,
        phone,
        tipo_mensagem,
        texto_mensagem: (texto_mensagem || '').substring(0, 100),
      },
    });

    console.log(`[Webhook] Processed: ${nome} (${phone}) — ${tipo_mensagem}`);

    return res.status(200).json({
      status: 'ok',
      candidate_id: candidateId,
      message_stored: true,
    });

  } catch (error) {
    console.error('[Webhook] Error:', error);

    // Log error but still return 200 to ChatGuru (avoid retries)
    try {
      await insert('sync_log', {
        source: 'chatguru',
        action: 'webhook_error',
        entity_type: 'message',
        status: 'error',
        error_message: error.message || String(error),
        payload: req.body,
      });
    } catch (_) { /* ignore logging errors */ }

    return res.status(200).json({ status: 'error', message: error.message });
  }
}
