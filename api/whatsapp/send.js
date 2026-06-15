/**
 * WhatsApp Send — Vercel Serverless Function
 *
 * POST /api/whatsapp/send
 * Body: { phone, text }
 *
 * Sends via ChatGuru API (safe, official) — NOT Evolution.
 * Also stores the outbound message in Supabase rhf_messages.
 */

import { insert } from '../../lib/supabase.js';
import { sendMessage as chatguruSend } from '../../lib/chatguru.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { phone, text } = req.body;

    if (!phone || !text) {
      return res.status(400).json({ status: 'error', message: 'phone and text are required' });
    }

    // Send via ChatGuru
    const chatguruResult = await chatguruSend(phone, text);

    // Store outbound message in Supabase
    await insert('rhf_messages', {
      phone,
      direction: 'outbound',
      content: text,
      message_type: 'chat',
      chatguru_message_id: chatguruResult.message_id || null,
    });

    // Log the action
    await insert('sync_log', {
      source: 'whatsapp-chat',
      action: 'message_sent',
      entity_type: 'message',
      entity_id: chatguruResult.message_id || phone,
      status: chatguruResult.result === 'success' ? 'success' : 'error',
      payload: { phone, text: text.substring(0, 100), chatguru_response: chatguruResult },
    });

    return res.status(200).json({
      status: 'ok',
      chatguru: chatguruResult,
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
