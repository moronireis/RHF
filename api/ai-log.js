/**
 * AI Suggestion Log — Vercel Serverless Function
 *
 * POST /api/ai-log   → { phone, candidate_name, suggestion_text, user_id?, user_name? }
 * GET  /api/ai-log   → list all (admin use)
 */

import { select, insert } from '../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') return handleLog(req, res);
  if (req.method === 'GET') return handleList(req, res);

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleLog(req, res) {
  const { phone, candidate_name, suggestion_text, user_id, user_name } = req.body || {};
  if (!suggestion_text) return res.status(400).json({ error: 'suggestion_text is required' });

  try {
    const row = {
      phone: phone || null,
      candidate_name: candidate_name || null,
      suggestion_text,
      user_id: user_id || null,
      user_name: user_name || null,
    };
    await insert('ai_suggestion_log', row);
    return res.status(201).json({ status: 'ok' });
  } catch (err) {
    console.error('[ai-log] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleList(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const rows = await select('ai_suggestion_log', `order=copied_at.desc&limit=${limit}`);
    return res.status(200).json({ status: 'ok', count: Array.isArray(rows) ? rows.length : 0, data: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error('[ai-log/list] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
