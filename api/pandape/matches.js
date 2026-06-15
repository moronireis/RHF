/**
 * Pandapé Match Proxy — Vercel Serverless Function
 *
 * Proxies Pandapé match data to the frontend (mvp.html dashboard).
 * Avoids exposing Pandapé credentials to the browser.
 * URL: GET /api/pandape/matches?id=602649148
 */

import { getMatch } from '../../lib/pandape.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Missing required query param: id' });
  }

  try {
    const match = await getMatch(id);
    return res.status(200).json({ status: 'ok', data: match });
  } catch (error) {
    console.error(`[Pandapé Matches] Error fetching match ${id}:`, error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
