/**
 * WhatsApp Chat Messages — Vercel Serverless Function
 *
 * GET /api/whatsapp/chat-messages?phone=5511967615987&limit=100
 * Returns messages for a specific phone from Supabase (Meta webhook data).
 */

import { select } from '../../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const phone = req.query.phone;
  const limit = req.query.limit || '100';

  if (!phone) {
    return res.status(400).json({ status: 'error', message: 'phone query param required' });
  }

  try {
    // Fetch messages for this phone from Supabase, ordered oldest first
    const messages = await select(
      'rhf_messages',
      `phone=eq.${phone}&order=created_at.asc&limit=${limit}&select=id,phone,direction,content,message_type,chatguru_message_id,raw_webhook,created_at`
    );

    if (!Array.isArray(messages)) {
      return res.status(200).json({ status: 'ok', phone, count: 0, data: [] });
    }

    // Normalize to frontend format
    const normalized = messages.map(msg => {
      const timestamp = Math.floor(new Date(msg.created_at).getTime() / 1000);
      let contactName = null;
      if (msg.raw_webhook && typeof msg.raw_webhook === 'object') {
        contactName = msg.raw_webhook.contact_name;
      }

      return {
        id: msg.chatguru_message_id || msg.id,
        remoteJid: phone,
        fromMe: msg.direction === 'outbound',
        body: msg.content || '[mensagem]',
        timestamp,
        type: msg.message_type || 'chat',
        status: null,
        contactName,
      };
    });

    return res.status(200).json({
      status: 'ok',
      phone,
      count: normalized.length,
      data: normalized,
    });

  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
