/**
 * WhatsApp Unified Handler — Vercel Serverless Function
 *
 * GET  /api/whatsapp?action=chats                        → list conversations
 * GET  /api/whatsapp?action=messages&phone=XX&limit=100  → messages for a phone
 * POST /api/whatsapp?action=send                         → { phone, text }
 * POST /api/whatsapp?action=suggest                      → { phone, candidate_name? } → AI suggestion
 */

import { select, insert } from '../lib/supabase.js';
import { sendMessage as chatguruSend, listChats as chatguruListChats, getChatDetails as chatguruGetDetails, getChatMessages as chatguruGetMessages } from '../lib/chatguru.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const SUGGEST_MODEL = 'claude-haiku-4-5-20251001';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  if (action === 'chats' && req.method === 'GET') return handleChats(req, res);
  if (action === 'messages' && req.method === 'GET') return handleMessages(req, res);
  if (action === 'chat-details' && req.method === 'GET') return handleChatDetails(req, res);
  if (action === 'send' && req.method === 'POST') return handleSend(req, res);
  if (action === 'suggest' && req.method === 'POST') return handleSuggest(req, res);

  return res.status(400).json({ error: 'Use action=chats|messages|chat-details|send|suggest' });
}

// ─── Chats ───────────────────────────────────────────────────────────────────

async function handleChats(req, res) {
  const agentId = req.query.agent_id || null;

  // Try ChatGuru API first (gives real-time data + custom fields)
  try {
    const cgData = await chatguruListChats({ agentId: agentId || undefined, limit: 200 });
    if (cgData && (cgData.result === 'success' || Array.isArray(cgData.data) || Array.isArray(cgData.chats))) {
      const rawChats = cgData.data ?? cgData.chats ?? (Array.isArray(cgData) ? cgData : []);
      const chats = rawChats.map(c => ({
        id: c.chat_number ?? c.id ?? c.phone,
        phone: c.chat_number ?? c.phone ?? c.id,
        name: c.name ?? c.contact_name ?? c.chat_number ?? 'Sem nome',
        lastMessage: c.last_message ?? c.lastMessage ?? '',
        lastMessageTimestamp: c.last_message_time ?? c.lastMessageTimestamp ?? c.updated_at ?? null,
        direction: c.last_message_direction ?? 'inbound',
        unreadCount: c.unread_count ?? c.unreadCount ?? 0,
        status: c.status ?? null,
        processo: c.processo ?? c.process ?? c.custom_fields?.processo ?? null,
        tags: c.tags ?? c.labels ?? [],
        agentId: c.agent_id ?? c.assigned_agent ?? null,
        isGroup: false,
      }));
      chats.sort((a, b) => new Date(b.lastMessageTimestamp || 0) - new Date(a.lastMessageTimestamp || 0));
      return res.status(200).json({ status: 'ok', source: 'chatguru', count: chats.length, data: chats });
    }
  } catch (err) {
    console.warn('[whatsapp/chats] ChatGuru fallback triggered:', err.message);
  }

  // Fallback: build chat list from local Supabase messages
  try {
    const messages = await select(
      'rhf_messages',
      'order=created_at.desc&limit=2000&select=phone,direction,content,message_type,created_at,raw_webhook,sent_by_user_id'
    );
    if (!Array.isArray(messages)) return res.status(200).json({ status: 'ok', count: 0, data: [] });

    const candidates = await select('candidates', 'select=phone,name&limit=500');
    const nameMap = {};
    if (Array.isArray(candidates)) candidates.forEach(c => { if (c.phone && c.name) nameMap[c.phone] = c.name; });

    const chatMap = {};
    messages.forEach(msg => {
      const phone = msg.phone;
      if (!phone) return;
      // If agent filter is set, only include messages sent by that agent
      if (agentId && msg.sent_by_user_id && msg.sent_by_user_id !== agentId) return;

      let contactName = null;
      if (msg.raw_webhook && typeof msg.raw_webhook === 'object') contactName = msg.raw_webhook.contact_name;
      if (!contactName) contactName = nameMap[phone];
      if (!contactName) contactName = phone;

      if (!chatMap[phone]) {
        const raw = msg.raw_webhook || {};
        chatMap[phone] = {
          id: phone, phone, name: contactName,
          lastMessage: msg.content || '', lastMessageTimestamp: msg.created_at,
          direction: msg.direction, unreadCount: 0, isGroup: false, messageCount: 0,
          status: raw.status ?? raw.chat_status ?? null,
          processo: raw.processo ?? raw.process ?? raw.custom_fields?.processo ?? null,
          tags: raw.tags ?? raw.labels ?? [],
          agentId: raw.agent_id ?? null,
        };
      }
      chatMap[phone].messageCount++;
      if (msg.direction === 'inbound') chatMap[phone].unreadCount++;
      if (contactName && contactName !== phone && chatMap[phone].name === phone) chatMap[phone].name = contactName;
    });

    const chats = Object.values(chatMap);
    chats.sort((a, b) => new Date(b.lastMessageTimestamp || 0) - new Date(a.lastMessageTimestamp || 0));
    return res.status(200).json({ status: 'ok', source: 'supabase', count: chats.length, data: chats });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

function mapCGContentType(type) {
  if (!type) return 'text';
  const t = String(type).toLowerCase();
  if (t === 'imagem' || t === 'image' || t === 'photo') return 'image';
  if (t === 'audio' || t === 'ptt' || t === 'voice') return 'audio';
  if (t === 'video') return 'video';
  if (t === 'arquivo' || t === 'document' || t === 'file' || t === 'pdf') return 'document';
  if (t === 'sticker') return 'sticker';
  return 'text';
}

function normalizeCGTimestamp(ts) {
  if (!ts) return Math.floor(Date.now() / 1000);
  if (typeof ts === 'number') return ts < 1e12 ? ts : Math.floor(ts / 1000);
  return Math.floor(new Date(ts).getTime() / 1000);
}

function normalizeCGMessage(m, phone) {
  // Handle multiple ChatGuru field-name conventions
  const rawType   = m.type ?? m.tipo ?? m.message_type ?? m.tipo_mensagem ?? 'text';
  const contentType = mapCGContentType(rawType);
  const fromMe    = m.from_me ?? m.fromMe ?? m.outbound ?? m.direction === 'outbound' ?? false;
  const ts        = m.time ?? m.timestamp ?? m.data ?? m.created_at ?? null;
  const body      = m.text ?? m.body ?? m.content ?? m.caption ?? m.texto_mensagem ?? '';
  const mediaUrl  = m.file_url ?? m.url ?? m.media_url ?? m.url_arquivo ?? m.file ?? null;
  const mime      = m.mime ?? m.mimetype ?? m.file_type ?? null;
  const contactName = m.contact_name ?? m.nome ?? m.from_name ?? null;

  return {
    id: m.id ?? m.message_id ?? m.id_mensagem ?? null,
    remoteJid: phone,
    fromMe,
    body,
    timestamp: normalizeCGTimestamp(ts),
    contentType,
    mediaUrl,
    mime,
    contactName,
  };
}

async function handleMessages(req, res) {
  const phone = req.query.phone;
  const limit = parseInt(req.query.limit || '80', 10);
  if (!phone) return res.status(400).json({ status: 'error', message: 'phone query param required' });

  // ── 1. Try ChatGuru chat_read (real-time, includes media) ───────────────
  try {
    const cgData = await chatguruGetMessages(phone, limit);
    const rawList = cgData?.messages ?? cgData?.data ?? cgData?.chat_messages ?? (Array.isArray(cgData) ? cgData : null);
    if (rawList && rawList.length > 0) {
      const normalized = rawList.map(m => normalizeCGMessage(m, phone));
      // Sort ascending by timestamp
      normalized.sort((a, b) => a.timestamp - b.timestamp);
      return res.status(200).json({ status: 'ok', phone, count: normalized.length, data: normalized, source: 'chatguru' });
    }
  } catch (err) {
    console.warn('[whatsapp/messages] ChatGuru fallback:', err.message);
  }

  // ── 2. Fallback: Supabase rhf_messages ────────────────────────────────────
  try {
    const messages = await select(
      'rhf_messages',
      `phone=eq.${phone}&order=created_at.asc&limit=${limit}&select=id,phone,direction,content,content_type,message_type,media_url,chatguru_message_id,raw_webhook,created_at`
    );
    if (!Array.isArray(messages)) return res.status(200).json({ status: 'ok', phone, count: 0, data: [] });

    const normalized = messages.map(msg => {
      const ts = Math.floor(new Date(msg.created_at).getTime() / 1000);
      let contactName = null;
      if (msg.raw_webhook && typeof msg.raw_webhook === 'object') {
        contactName = msg.raw_webhook.contact_name ?? msg.raw_webhook.nome ?? null;
      }
      // Reconstruct mediaUrl from legacy rows where media was stored in content
      const mediaUrl = msg.media_url || (
        (msg.content_type !== 'text' && msg.content && msg.content.startsWith('http')) ? msg.content : null
      );
      return {
        id: msg.chatguru_message_id || msg.id,
        remoteJid: phone,
        fromMe: msg.direction === 'outbound',
        body: mediaUrl ? (msg.content && !msg.content.startsWith('http') ? msg.content : '') : (msg.content || ''),
        timestamp: ts,
        contentType: msg.content_type || mapCGContentType(msg.message_type) || 'text',
        mediaUrl,
        mime: null,
        contactName,
      };
    });

    return res.status(200).json({ status: 'ok', phone, count: normalized.length, data: normalized, source: 'supabase' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}

// ─── Chat Details (ChatGuru custom fields) ────────────────────────────────────

async function handleChatDetails(req, res) {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ status: 'error', message: 'phone required' });

  try {
    const details = await chatguruGetDetails(phone);
    const raw = details?.data ?? details ?? {};
    return res.status(200).json({
      status: 'ok',
      data: {
        phone,
        status: raw.status ?? raw.chat_status ?? null,
        processo: raw.processo ?? raw.process ?? raw.custom_fields?.processo ?? null,
        tags: raw.tags ?? raw.labels ?? [],
        agentId: raw.agent_id ?? raw.assigned_agent ?? null,
      },
    });
  } catch (error) {
    return res.status(200).json({ status: 'ok', data: { phone, status: null, processo: null, tags: [] } });
  }
}

// ─── Send ─────────────────────────────────────────────────────────────────────

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

// ─── AI Suggest ───────────────────────────────────────────────────────────────

async function handleSuggest(req, res) {
  const { phone, candidate_name } = req.body || {};
  if (!phone) return res.status(400).json({ status: 'error', message: 'phone is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ status: 'error', message: 'ANTHROPIC_API_KEY não configurada.' });

  try {
    // Get last 20 messages for context
    const messages = await select(
      'rhf_messages',
      `phone=eq.${phone}&order=created_at.desc&limit=20&select=direction,content,created_at`
    );

    const history = Array.isArray(messages) ? messages.reverse() : [];
    const historyText = history.map(m => {
      const who = m.direction === 'inbound' ? (candidate_name || 'Candidato') : 'RHF';
      return `${who}: ${m.content || ''}`;
    }).join('\n');

    const systemPrompt = `Você é um assistente de recrutamento da RHF Talentos. Sua tarefa é sugerir a melhor resposta para o recrutador enviar ao candidato via WhatsApp.

Diretrizes:
- Tom profissional mas acolhedor
- Português brasileiro claro e direto
- Resposta curta e objetiva (máximo 3 frases)
- Foco em avançar o processo seletivo
- Não invente informações — baseie-se apenas na conversa`;

    const userPrompt = `Histórico da conversa com ${candidate_name || 'o candidato'}:\n\n${historyText || '(sem mensagens anteriores)'}\n\nSugira a próxima mensagem do recrutador:`;

    const claudeRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SUGGEST_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const body = await claudeRes.text();
      return res.status(500).json({ status: 'error', message: `Claude error: ${body}` });
    }

    const claudeData = await claudeRes.json();
    const suggestion = claudeData?.content?.[0]?.text?.trim() || '';

    return res.status(200).json({ status: 'ok', suggestion, phone, candidate_name: candidate_name || null });
  } catch (error) {
    console.error('[suggest] error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
