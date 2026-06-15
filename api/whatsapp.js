/**
 * WhatsApp Unified Handler — Vercel Serverless Function
 *
 * GET  /api/whatsapp?action=chats                        → list conversations
 * GET  /api/whatsapp?action=messages&phone=XX&limit=100  → messages for a phone
 * POST /api/whatsapp?action=send                         → { phone, text }
 */

import { select, insert } from '../lib/supabase.js';
import { sendMessage as chatguruSend } from '../lib/chatguru.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  if (action === 'chats' && req.method === 'GET') return handleChats(req, res);
  if (action === 'messages' && req.method === 'GET') return handleMessages(req, res);
  if (action === 'send' && req.method === 'POST') return handleSend(req, res);

  return res.status(400).json({ error: 'Use action=chats|messages|send' });
}

async function handleChats(req, res) {
  try {
    const messages = await select(
      'rhf_messages',
      'order=created_at.desc&limit=2000&select=phone,direction,content,message_type,created_at,raw_webhook'
    );
    if (!Array.isArray(messages)) return res.status(200).json({ status: 'ok', count: 0, data: [] });

    const candidates = await select('candidates', 'select=phone,name&limit=500');
    const nameMap = {};
    if (Array.isArray(candidates)) candidates.forEach(c => { if (c.phone && c.name) nameMap[c.phone] = c.name; });

    const chatMap = {};
    messages.forEach(msg => {
      const phone = msg.phone;
      if (!phone) return;
      let contactName = null;
      if (msg.raw_webhook && typeof msg.raw_webhook === 'object') contactName = msg.raw_webhook.contact_name;
      if (!contactName) contactName = nameMap[phone];
      if (!contactName) contactName = phone;

      if (!chatMap[phone]) {
        chatMap[phone] = {
          id: phone, phone, name: contactName,
          lastMessage: msg.content || '', lastMessageTimestamp: msg.created_at,
          direction: msg.direction, unreadCount: 0, isGroup: false, messageCount: 0,
        };
      }
      chatMap[phone].messageCount++;
      if (msg.direction === 'inbound') chatMap[phone].unreadCount++;
      if (contactName && contactName !== phone && chatMap[phone].name === phone) chatMap[phone].name = contactName;
    });

    const chats = Object.values(chatMap);
    chats.sort((a, b) => new Date(b.lastMessageTimestamp || 0) - new Date(a.lastMessageTimestamp || 0));

    return res.status(200).json({ status: 'ok', count: chats.length, data: chats });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}

async function handleMessages(req, res) {
  const phone = req.query.phone;
  const limit = req.query.limit || '100';
  if (!phone) return res.status(400).json({ status: 'error', message: 'phone query param required' });

  try {
    const messages = await select(
      'rhf_messages',
      `phone=eq.${phone}&order=created_at.asc&limit=${limit}&select=id,phone,direction,content,message_type,chatguru_message_id,raw_webhook,created_at`
    );
    if (!Array.isArray(messages)) return res.status(200).json({ status: 'ok', phone, count: 0, data: [] });

    const normalized = messages.map(msg => {
      const timestamp = Math.floor(new Date(msg.created_at).getTime() / 1000);
      let contactName = null;
      if (msg.raw_webhook && typeof msg.raw_webhook === 'object') contactName = msg.raw_webhook.contact_name;
      return {
        id: msg.chatguru_message_id || msg.id, remoteJid: phone,
        fromMe: msg.direction === 'outbound', body: msg.content || '[mensagem]',
        timestamp, type: msg.message_type || 'chat', status: null, contactName,
      };
    });

    return res.status(200).json({ status: 'ok', phone, count: normalized.length, data: normalized });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}

async function handleSend(req, res) {
  try {
    const { phone, text } = req.body;
    if (!phone || !text) return res.status(400).json({ status: 'error', message: 'phone and text are required' });

    const chatguruResult = await chatguruSend(phone, text);

    await insert('rhf_messages', {
      phone, direction: 'outbound', content: text, message_type: 'chat',
      chatguru_message_id: chatguruResult.message_id || null,
    });

    await insert('sync_log', {
      source: 'whatsapp-chat', action: 'message_sent', entity_type: 'message',
      entity_id: chatguruResult.message_id || phone,
      status: chatguruResult.result === 'success' ? 'success' : 'error',
      payload: { phone, text: text.substring(0, 100), chatguru_response: chatguruResult },
    });

    return res.status(200).json({ status: 'ok', chatguru: chatguruResult });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
