/**
 * Evolution API Webhook Receiver — Vercel Serverless Function
 *
 * Receives real-time events from Evolution API (MESSAGES_UPSERT, etc.)
 * Stores new messages in Supabase for the chat viewer to poll.
 */

import { insert } from '../../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', service: 'Evolution Webhook' });
  }

  if (req.method !== 'POST') return res.status(405).end();

  try {
    const payload = req.body;
    const event = payload.event;

    // Only process message events
    if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
      const data = payload.data;
      if (!data) return res.status(200).json({ status: 'ok', event, processed: false });

      // Evolution sends single message or array
      const messages = Array.isArray(data) ? data : [data];

      for (const msg of messages) {
        const key = msg.key || {};
        const remoteJid = key.remoteJid || '';

        // Skip status broadcasts and groups for now
        if (!remoteJid.includes('@s.whatsapp.net')) continue;

        const phone = remoteJid.replace('@s.whatsapp.net', '');
        const fromMe = key.fromMe || false;

        // Extract text
        const m = msg.message || {};
        let text = m.conversation
          || m.extendedTextMessage?.text
          || m.imageMessage?.caption
          || m.videoMessage?.caption
          || m.documentMessage?.fileName
          || null;

        // Determine type
        let msgType = 'chat';
        if (m.imageMessage) msgType = 'image';
        else if (m.audioMessage || m.pttMessage) msgType = 'ptt';
        else if (m.videoMessage) msgType = 'video';
        else if (m.documentMessage) msgType = 'file';
        else if (m.stickerMessage) msgType = 'sticker';
        else if (m.contactMessage) msgType = 'contact';
        else if (m.locationMessage) msgType = 'location';

        if (!text && msgType !== 'chat') {
          text = `[${msgType}]`;
        }

        // Store in Supabase
        await insert('rhf_messages', {
          phone,
          direction: fromMe ? 'outbound' : 'inbound',
          content: text || '',
          message_type: msgType,
          chatguru_message_id: key.id || null,
          chatguru_chat_id: remoteJid,
          raw_webhook: {
            event,
            key,
            pushName: msg.pushName,
            messageType: msg.messageType,
            timestamp: msg.messageTimestamp,
          },
        }, false);
      }

      return res.status(200).json({ status: 'ok', event, processed: true, count: messages.length });
    }

    // Other events — just acknowledge
    return res.status(200).json({ status: 'ok', event, processed: false });

  } catch (error) {
    console.error('[Evolution Webhook] Error:', error);
    return res.status(200).json({ status: 'error', message: error.message });
  }
}
