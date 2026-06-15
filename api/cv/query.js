/**
 * CV Query API — Vercel Serverless Function
 *
 * GET /api/cv/query?id=uuid           — fetch a single CV by ID
 * GET /api/cv/query                   — list all CVs (default limit 20)
 * GET /api/cv/query?candidate_id=uuid — list CVs for a specific candidate
 * GET /api/cv/query?limit=10          — list with custom limit
 */

import { select } from '../../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  try {
    const { id, candidate_id, limit = '20' } = req.query;

    // Single CV by ID
    if (id) {
      const rows = await select('generated_cvs', `id=eq.${id}&limit=1`);

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({ status: 'error', message: `CV ${id} not found` });
      }

      return res.status(200).json({ status: 'ok', data: rows[0] });
    }

    // List CVs
    const parsedLimit = Math.min(parseInt(limit, 10) || 20, 100);

    const parts = [`order=created_at.desc&limit=${parsedLimit}`];
    if (candidate_id) parts.push(`candidate_id=eq.${candidate_id}`);

    const cvs = await select('generated_cvs', parts.join('&'));

    return res.status(200).json({
      status: 'ok',
      count: Array.isArray(cvs) ? cvs.length : 0,
      data: Array.isArray(cvs) ? cvs : [],
    });

  } catch (error) {
    console.error('[CV Query] Error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
