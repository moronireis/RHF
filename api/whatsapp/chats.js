/**
 * WhatsApp Chats — Vercel Serverless Function
 *
 * GET /api/whatsapp/chats
 * Returns conversations from Supabase (populated by Meta Cloud API webhook).
 * Groups messages by phone number, shows last message and contact name.
 */

import { select } from '../../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Fetch all messages ordered by most recent
    const messages = await select(
      'rhf_messages',
      'order=created_at.desc&limit=2000&select=phone,direction,content,message_type,created_at,raw_webhook'
    );

    if (!Array.isArray(messages)) {
      return res.status(200).json({ status: 'ok', count: 0, data: [] });
    }

    // Also fetch candidates for name resolution
    const candidates = await select('candidates', 'select=phone,name&limit=500');
    const nameMap = {};
    if (Array.isArray(candidates)) {
      candidates.forEach(c => { if (c.phone && c.name) nameMap[c.phone] = c.name; });
    }

    // Group by phone number — build conversation list
    const chatMap = {};
    messages.forEach(msg => {
      const phone = msg.phone;
      if (!phone) return;

      // Get contact name from webhook payload or candidates table
      let contactName = null;
      if (msg.raw_webhook && typeof msg.raw_webhook === 'object') {
        contactName = msg.raw_webhook.contact_name;
      }
      if (!contactName) contactName = nameMap[phone];
      if (!contactName) contactName = phone;

      if (!chatMap[phone]) {
        chatMap[phone] = {
          id: phone,
          phone,
          name: contactName,
          lastMessage: msg.content || '',
          lastMessageTimestamp: msg.created_at,
          direction: msg.direction,
          unreadCount: 0,
          isGroup: false,
          messageCount: 0,
        };
      }

      chatMap[phone].messageCount++;

      // Count unread (inbound messages)
      if (msg.direction === 'inbound') {
        chatMap[phone].unreadCount++;
      }

      // Use the best name we can find (prefer webhook contact_name)
      if (contactName && contactName !== phone && chatMap[phone].name === phone) {
        chatMap[phone].name = contactName;
      }
    });

    // Convert to array and sort by most recent
    const chats = Object.values(chatMap);
    chats.sort((a, b) =>
      new Date(b.lastMessageTimestamp || 0) - new Date(a.lastMessageTimestamp || 0)
    );

    return res.status(200).json({
      status: 'ok',
      count: chats.length,
      data: chats,
    });

  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
