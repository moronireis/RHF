/**
 * Messages API — Vercel Serverless Function
 *
 * GET /api/messages?phone=5511967615987 — fetch conversation history
 * GET /api/messages — fetch all recent messages
 * POST /api/messages — send a message via ChatGuru
 */

import { select, insert } from '../lib/supabase.js';
import { sendMessage as chatguruSend } from '../lib/chatguru.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — fetch messages
  if (req.method === 'GET') {
    try {
      const { phone, limit = '50' } = req.query;
      let query = `order=created_at.desc&limit=${limit}`;
      if (phone) query += `&phone=eq.${phone}`;

      const messages = await select('rhf_messages', query);
      return res.status(200).json({ status: 'ok', data: messages });
    } catch (error) {
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  // POST — send message via ChatGuru + store in DB
  if (req.method === 'POST') {
    try {
      const { phone, text } = req.body;
      if (!phone || !text) {
        return res.status(400).json({ status: 'error', message: 'phone and text required' });
      }

      // Send via ChatGuru
      const chatguruResult = await chatguruSend(phone, text);

      // Store outbound message in DB
      await insert('rhf_messages', {
        phone,
        direction: 'outbound',
        content: text,
        message_type: 'chat',
        chatguru_message_id: chatguruResult.message_id || null,
      });

      // Log
      await insert('sync_log', {
        source: 'system',
        action: 'message_sent',
        entity_type: 'message',
        entity_id: chatguruResult.message_id || phone,
        status: chatguruResult.result === 'success' ? 'success' : 'error',
        payload: { phone, text: text.substring(0, 100), chatguru_response: chatguruResult },
      });

      return res.status(200).json({ status: 'ok', chatguru: chatguruResult });
    } catch (error) {
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
