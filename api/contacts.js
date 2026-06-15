/**
 * Contacts API — Vercel Serverless Function
 *
 * GET /api/contacts — list all candidates
 * GET /api/contacts?status=new — filter by status
 */

import { select } from '../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { status, limit = '50' } = req.query;
    let query = `order=created_at.desc&limit=${limit}`;
    if (status) query += `&status=eq.${status}`;

    const data = await select('candidates', query);
    return res.status(200).json({ status: 'ok', data });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
