/**
 * Pandapé Webhook Receiver — Vercel Serverless Function
 *
 * Receives "Candidato mudou de estágio em uma vaga" events from Pandapé.
 * Fetches full match + vacancy data, upserts candidate in Supabase, logs event.
 * URL: https://rhf-proposta.vercel.app/api/webhook/pandape
 *
 * Pandapé webhook payload:
 * {
 *   "IdMatch": 602649148,
 *   "IdVacancy": 2656804,
 *   "IdVacancyFolderFrom": 17098398,
 *   "IdVacancyFolderTo": 17098395,
 *   "EventDate": "2025-12-18T14:36:24.3750583"
 * }
 */

import { insert, upsert } from '../../lib/supabase.js';
import { getMatch, getVacancy } from '../../lib/pandape.js';

/**
 * Verify optional webhook secret.
 * Pandapé may send a token in the Authorization header or a custom header.
 * If PANDAPE_WEBHOOK_SECRET is not set, verification is skipped.
 * @param {object} req
 * @returns {boolean}
 */
function verifySecret(req) {
  const secret = process.env.PANDAPE_WEBHOOK_SECRET;
  if (!secret) return true; // not configured — skip

  // Check Authorization: Bearer <secret>
  const authHeader = req.headers['authorization'] || '';
  if (authHeader === `Bearer ${secret}`) return true;

  // Check X-Pandape-Secret header as fallback
  const customHeader = req.headers['x-pandape-secret'] || '';
  if (customHeader === secret) return true;

  return false;
}

/**
 * Normalize candidate fields from a Pandapé match object.
 * Pandapé field names may vary — we handle the most common casing conventions.
 * @param {object} match - Full match object from GET /v2/matches/{id}
 * @param {object} vacancy - Vacancy object from GET /v2/vacancies/{id}
 * @param {object} payload - Original webhook payload
 * @returns {object} Normalized candidate row
 */
function normalizeCandidate(match, vacancy, payload) {
  // Pandapé uses PascalCase for most fields
  const name = match.CandidateName ?? match.candidateName ?? match.Name ?? match.name ?? null;
  const email = match.CandidateEmail ?? match.candidateEmail ?? match.Email ?? match.email ?? null;
  const phone = match.CandidatePhone ?? match.candidatePhone ?? match.Phone ?? match.phone ?? null;

  const vacancyName = vacancy?.Title ?? vacancy?.title ?? vacancy?.Name ?? vacancy?.name ?? null;

  return {
    name,
    email,
    phone: phone ? String(phone).replace(/\D/g, '') : null,
    match_id: payload.IdMatch,
    vacancy_id: payload.IdVacancy,
    vacancy_name: vacancyName,
    stage: 'pandape_sync',
    raw_data: match,
  };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Pandape-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Health check
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      service: 'RHF Talentos — Pandapé Webhook',
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const receivedAt = new Date().toISOString();

  try {
    const payload = req.body;
    console.log('[Pandapé Webhook] Received:', JSON.stringify(payload));

    // Optional secret verification
    if (!verifySecret(req)) {
      console.warn('[Pandapé Webhook] Invalid webhook secret — rejecting');
      // Still return 200 to avoid Pandapé retry storm, but log the rejection
      await insert('sync_log', {
        source: 'pandape',
        action: 'webhook_rejected',
        entity_type: 'match',
        entity_id: String(payload?.IdMatch ?? 'unknown'),
        status: 'error',
        error_message: 'Invalid webhook secret',
        payload,
      }).catch(() => {});
      return res.status(200).json({ status: 'rejected', reason: 'invalid_secret' });
    }

    // Validate required fields
    const { IdMatch, IdVacancy, IdVacancyFolderTo, EventDate } = payload ?? {};
    if (!IdMatch || !IdVacancy) {
      console.warn('[Pandapé Webhook] Missing required fields IdMatch or IdVacancy');
      return res.status(200).json({ status: 'skipped', reason: 'missing_required_fields' });
    }

    // Fetch full data from Pandapé
    console.log(`[Pandapé Webhook] Fetching match ${IdMatch}...`);
    const [match, vacancy] = await Promise.all([
      getMatch(IdMatch),
      getVacancy(IdVacancy),
    ]);

    console.log(`[Pandapé Webhook] Match fetched. Candidate: ${match?.CandidateName ?? match?.name ?? 'unknown'}`);

    // Upsert candidate into Supabase (conflict on match_id)
    const candidateRow = normalizeCandidate(match, vacancy, payload);
    const upserted = await upsert('candidates', candidateRow, 'match_id');
    const candidateId = Array.isArray(upserted) && upserted[0] ? upserted[0].id : null;

    console.log(`[Pandapé Webhook] Candidate upserted. DB id: ${candidateId}`);

    // Log the sync event
    await insert('sync_log', {
      source: 'pandape',
      action: 'stage_changed',
      entity_type: 'match',
      entity_id: String(IdMatch),
      status: 'success',
      payload: {
        IdMatch,
        IdVacancy,
        IdVacancyFolderTo,
        EventDate,
        vacancy_name: candidateRow.vacancy_name,
        candidate_name: candidateRow.name,
        candidate_id: candidateId,
        received_at: receivedAt,
      },
    });

    return res.status(200).json({
      status: 'ok',
      match_id: IdMatch,
      vacancy_id: IdVacancy,
      candidate_id: candidateId,
    });

  } catch (error) {
    console.error('[Pandapé Webhook] Error:', error);

    // Log the error but always return 200 to prevent Pandapé retry loops
    try {
      await insert('sync_log', {
        source: 'pandape',
        action: 'webhook_error',
        entity_type: 'match',
        entity_id: String(req.body?.IdMatch ?? 'unknown'),
        status: 'error',
        error_message: error.message || String(error),
        payload: req.body,
      });
    } catch (_) { /* ignore secondary logging failures */ }

    return res.status(200).json({ status: 'error', message: error.message });
  }
}
