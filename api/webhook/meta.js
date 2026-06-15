/**
 * Meta WhatsApp Cloud API Webhook — Vercel Serverless Function
 */

import { insert } from '../../lib/supabase.js';

export default async function handler(req, res) {
  // GET: Webhook Verification
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: 'Verification failed' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const results = [];

  try {
    if (!body || body.object !== 'whatsapp_business_account') {
      return res.status(200).json({ status: 'ok', ignored: true });
    }

    const entries = body.entry || [];

    for (let i = 0; i < entries.length; i++) {
      const changes = entries[i].changes || [];

      for (let j = 0; j < changes.length; j++) {
        const value = changes[j].value || {};
        const field = changes[j].field;

        if (field === 'messages' && value.messages) {
          const contacts = value.contacts || [];
          const contactMap = {};
          for (let k = 0; k < contacts.length; k++) {
            contactMap[contacts[k].wa_id] =
              (contacts[k].profile && contacts[k].profile.name) || contacts[k].wa_id;
          }

          for (let m = 0; m < value.messages.length; m++) {
            const msg = value.messages[m];
            const phone = msg.from;
            const contactName = contactMap[phone] || phone;

            // Extract text
            let text = '';
            let msgType = 'chat';
            if (msg.text && msg.text.body) { text = msg.text.body; msgType = 'chat'; }
            else if (msg.image) { text = msg.image.caption || '[Imagem]'; msgType = 'image'; }
            else if (msg.audio) { text = '[Audio]'; msgType = 'ptt'; }
            else if (msg.video) { text = msg.video.caption || '[Video]'; msgType = 'file'; }
            else if (msg.document) { text = msg.document.filename || '[Documento]'; msgType = 'file'; }
            else if (msg.sticker) { text = '[Sticker]'; msgType = 'image'; }
            else if (msg.reaction) { text = '[Reação]'; msgType = 'chat'; }
            else { text = '[' + (msg.type || 'mensagem') + ']'; msgType = 'chat'; }

            // Detect ChatGuru signed messages (outbound sent by team via ChatGuru)
            // ChatGuru adds "*AgentName:*\n" prefix when signMsg is enabled
            let direction = 'inbound';
            const signMatch = text.match(/^\*([^*]+):\*\s*/);
            if (signMatch) {
              direction = 'outbound';
              text = text.replace(/^\*[^*]+:\*\s*/, '').trim();
            }

            // Insert message
            const inserted = await insert('rhf_messages', {
              phone,
              direction,
              content: text,
              message_type: msgType,
              chatguru_message_id: msg.id || null,
              chatguru_chat_id: phone,
              raw_webhook: {
                source: 'meta_cloud_api',
                contact_name: contactName,
                wamid: msg.id,
                type: msg.type,
              },
            });

            results.push({ phone, status: 'ok' });
          }
        }
      }
    }
  } catch (err) {
    results.push({ error: err.message });
  }

  return res.status(200).json({ status: 'ok', results });
}
