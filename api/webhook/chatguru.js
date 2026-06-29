/**
 * ChatGuru Webhook Receiver — Vercel Serverless Function
 *
 * Receives webhook POSTs from ChatGuru and stores in Supabase.
 * URL: https://rhf-talentos-plataforma.vercel.app/api/webhook/chatguru
 *
 * Supports: text, image, audio, video, document/file messages
 */

import { select, insert } from '../../lib/supabase.js';

// Map ChatGuru tipo_mensagem values to our content_type
function mapContentType(tipo) {
  if (!tipo) return 'text';
  const t = String(tipo).toLowerCase();
  if (t === 'imagem' || t === 'image' || t === 'photo') return 'image';
  if (t === 'audio' || t === 'ptt' || t === 'voice') return 'audio';
  if (t === 'video') return 'video';
  if (t === 'arquivo' || t === 'document' || t === 'file' || t === 'pdf') return 'document';
  if (t === 'sticker') return 'sticker';
  return 'text';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      service: 'RHF Talentos — ChatGuru Webhook',
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;
    console.log('[Webhook/ChatGuru] Received:', JSON.stringify(payload));

    // ChatGuru sends various field names depending on version — handle all
    const nome          = payload.nome ?? payload.contact_name ?? payload.name ?? null;
    const celular       = payload.celular ?? payload.phone ?? payload.chat_number ?? '';
    const textoMensagem = payload.texto_mensagem ?? payload.message ?? payload.text ?? payload.body ?? null;
    const tipoMensagem  = payload.tipo_mensagem ?? payload.type ?? payload.message_type ?? 'texto';
    const phoneId       = payload.phone_id ?? null;
    const chatId        = payload.chat_id ?? payload.id ?? null;
    const email         = payload.email ?? null;
    // Media URL — ChatGuru uses different field names
    const urlArquivo    = payload.url_arquivo ?? payload.file_url ?? payload.media_url ?? payload.url ?? null;
    // ChatGuru message ID for dedup
    const messageId     = payload.message_id ?? payload.id_mensagem ?? chatId ?? null;

    const phone = String(celular || '').replace(/\D/g, '');
    if (!phone) {
      console.log('[Webhook/ChatGuru] No phone — skipping');
      return res.status(200).json({ status: 'skipped', reason: 'no_phone' });
    }

    const contentType = mapContentType(tipoMensagem);
    const isMedia = contentType !== 'text';

    // Dedup: skip if we already have this message
    if (messageId) {
      const existing = await select('rhf_messages', `chatguru_message_id=eq.${messageId}&select=id`);
      if (Array.isArray(existing) && existing.length > 0) {
        console.log(`[Webhook/ChatGuru] Duplicate message ${messageId} — skipping`);
        return res.status(200).json({ status: 'skipped', reason: 'duplicate' });
      }
    }

    // Upsert candidate
    const existingCandidates = await select('candidates', `phone=eq.${phone}&select=id`);
    let candidateId = null;
    if (Array.isArray(existingCandidates) && existingCandidates.length > 0) {
      candidateId = existingCandidates[0].id;
    } else if (nome && phone) {
      const inserted = await insert('candidates', {
        name: nome,
        phone,
        email: email || null,
        chatguru_chat_id: chatId || null,
        chatguru_phone_id: phoneId || null,
        status: 'new',
        raw_data: payload,
      });
      candidateId = Array.isArray(inserted) && inserted[0] ? inserted[0].id : null;
    }

    // Store message with proper content_type and media_url
    await insert('rhf_messages', {
      phone,
      direction: 'inbound',
      content: isMedia ? (textoMensagem || '') : (textoMensagem || ''),
      content_type: contentType,
      message_type: tipoMensagem || 'chat',
      media_url: urlArquivo || null,
      chatguru_message_id: messageId || null,
      chatguru_chat_id: chatId || null,
      candidate_id: candidateId || null,
      raw_webhook: payload,
    });

    // Sync log
    await insert('sync_log', {
      source: 'chatguru',
      action: 'webhook_received',
      entity_type: 'message',
      entity_id: chatId || phone,
      status: 'success',
      payload: {
        nome, phone,
        content_type: contentType,
        has_media: isMedia,
        media_url: urlArquivo ? urlArquivo.substring(0, 100) : null,
        texto: (textoMensagem || '').substring(0, 100),
      },
    });

    console.log(`[Webhook/ChatGuru] Stored: ${nome} (${phone}) — ${contentType}${isMedia ? ' + media' : ''}`);
    return res.status(200).json({ status: 'ok', candidate_id: candidateId, content_type: contentType });

  } catch (error) {
    console.error('[Webhook/ChatGuru] Error:', error);
    try {
      await insert('sync_log', {
        source: 'chatguru', action: 'webhook_error', entity_type: 'message',
        status: 'error', error_message: error.message || String(error), payload: req.body,
      });
    } catch (_) {}
    return res.status(200).json({ status: 'error', message: error.message });
  }
}
