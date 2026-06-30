/**
 * Pandapé Webhook Receiver — Vercel Serverless Function
 *
 * Receives "Candidato mudou de estágio em uma vaga" events from Pandapé.
 * Fetches full match + vacancy data, upserts candidate in Supabase, logs event.
 * URL: https://rhf-talentos-plataforma.vercel.app/api/webhook/pandape
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
import { getMatch, getVacancy, resolveFolderName } from '../../lib/pandape.js';

function verifySecret(req) {
  const secret = process.env.PANDAPE_WEBHOOK_SECRET;
  if (!secret) return true;
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${secret}`) return true;
  const custom = req.headers['x-pandape-secret'] || '';
  if (custom === secret) return true;
  return false;
}

/**
 * Extract a field by trying multiple PascalCase / camelCase / snake_case variants.
 */
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

/**
 * Map Pandapé match + vacancy into our candidates row.
 * Covers all known Pandapé API field name conventions.
 */
function normalizeCandidate(match, vacancy, payload) {
  const name   = pick(match, 'CandidateName', 'candidateName', 'Name', 'name', 'NomeCandidato');
  const email  = pick(match, 'CandidateEmail', 'candidateEmail', 'Email', 'email', 'EmailCandidato');
  const rawPhone = pick(match, 'CandidatePhone', 'candidatePhone', 'Phone', 'phone', 'TelefoneCandidato', 'Celular');
  const phone  = rawPhone ? String(rawPhone).replace(/\D/g, '') : null;

  const vacancyName   = pick(vacancy, 'Title', 'title', 'Name', 'name', 'NomeVaga', 'Titulo');
  const cvUrl         = pick(match, 'CurriculumUrl', 'curriculum_url', 'CvUrl', 'cv_url', 'ResumUrl');
  const linkedinUrl   = pick(match, 'LinkedinUrl', 'linkedin_url', 'Linkedin');
  const salaryRaw     = pick(match, 'SalaryExpectation', 'salary_expectation', 'PretensaoSalarial');
  const city          = pick(match, 'City', 'city', 'Cidade', 'CandidateCity');
  const education     = pick(match, 'Education', 'education', 'Escolaridade');
  const experience    = pick(match, 'ExperienceYears', 'experience_years', 'AnosExperiencia');

  // Stage name: resolved by the caller via resolveFolderName() before normalizeCandidate is called.
  // Injected as payload._stageName to avoid an extra async call inside this sync function.
  const stageName = payload._stageName ?? `etapa_${payload.IdVacancyFolderTo ?? 'unknown'}`;

  return {
    name,
    email,
    phone: phone || null,
    match_id: payload.IdMatch ?? null,
    vacancy_id: payload.IdVacancy ?? null,
    vacancy_name: vacancyName,
    stage: stageName,
    stage_id: payload.IdVacancyFolderTo ?? null,
    stage_updated_at: payload.EventDate ? new Date(payload.EventDate).toISOString() : new Date().toISOString(),
    cv_url: cvUrl,
    linkedin_url: linkedinUrl,
    salary_expectation: salaryRaw ? parseFloat(String(salaryRaw).replace(/[^\d.]/g, '')) || null : null,
    city,
    education: education ?? null,
    experience_years: experience ? parseInt(experience, 10) || null : null,
    status: 'pandape_sync',
    raw_data: match,
    updated_at: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Pandape-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      service: 'RHF Talentos — Pandapé Webhook',
      webhook_url: 'https://rhf-talentos-plataforma.vercel.app/api/webhook/pandape',
      timestamp: new Date().toISOString(),
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const receivedAt = new Date().toISOString();

  try {
    const payload = req.body;
    console.log('[Pandapé Webhook] Received:', JSON.stringify(payload));

    if (!verifySecret(req)) {
      await insert('sync_log', {
        source: 'pandape', action: 'webhook_rejected', entity_type: 'match',
        entity_id: String(payload?.IdMatch ?? 'unknown'), status: 'error',
        error_message: 'Invalid webhook secret', payload,
      }).catch(() => {});
      return res.status(200).json({ status: 'rejected', reason: 'invalid_secret' });
    }

    const { IdMatch, IdVacancy, IdVacancyFolderFrom, IdVacancyFolderTo, EventDate } = payload ?? {};

    if (!IdMatch || !IdVacancy) {
      console.warn('[Pandapé Webhook] Missing IdMatch or IdVacancy');
      await insert('sync_log', {
        source: 'pandape', action: 'webhook_skipped', entity_type: 'match',
        entity_id: 'unknown', status: 'skipped',
        error_message: 'Missing IdMatch or IdVacancy', payload,
      }).catch(() => {});
      return res.status(200).json({ status: 'skipped', reason: 'missing_required_fields' });
    }

    // Fetch full data from Pandapé API + resolve destination stage name
    console.log(`[Pandapé Webhook] Fetching match ${IdMatch} + vacancy ${IdVacancy} + stage name...`);
    const [match, vacancy, stageName] = await Promise.all([
      getMatch(IdMatch),
      getVacancy(IdVacancy),
      IdVacancyFolderTo ? resolveFolderName(IdVacancy, IdVacancyFolderTo) : Promise.resolve(null),
    ]);

    const candidateName = match?.CandidateName ?? match?.name ?? 'unknown';
    console.log(`[Pandapé Webhook] Fetched: ${candidateName} → stage: ${stageName}`);

    // Inject resolved stage name into payload so normalizeCandidate can use it
    const enrichedPayload = { ...payload, _stageName: stageName };

    // Upsert candidate — conflict on match_id (unique per Pandapé match)
    const candidateRow = normalizeCandidate(match, vacancy, enrichedPayload);
    const upserted = await upsert('candidates', candidateRow, 'match_id');
    const candidateId = Array.isArray(upserted) && upserted[0] ? upserted[0].id : null;

    console.log(`[Pandapé Webhook] Upserted candidate id=${candidateId}`);

    await insert('sync_log', {
      source: 'pandape',
      action: 'stage_changed',
      entity_type: 'match',
      entity_id: String(IdMatch),
      status: 'success',
      payload: {
        IdMatch, IdVacancy,
        stage_from: IdVacancyFolderFrom,
        stage_to: IdVacancyFolderTo,
        EventDate,
        vacancy_name: candidateRow.vacancy_name,
        candidate_name: candidateRow.name,
        candidate_phone: candidateRow.phone,
        candidate_id: candidateId,
        received_at: receivedAt,
      },
    });

    return res.status(200).json({
      status: 'ok',
      match_id: IdMatch,
      vacancy_id: IdVacancy,
      candidate_id: candidateId,
      candidate_name: candidateRow.name,
    });

  } catch (error) {
    console.error('[Pandapé Webhook] Error:', error);
    try {
      await insert('sync_log', {
        source: 'pandape', action: 'webhook_error', entity_type: 'match',
        entity_id: String(req.body?.IdMatch ?? 'unknown'),
        status: 'error', error_message: error.message || String(error), payload: req.body,
      });
    } catch (_) {}
    return res.status(200).json({ status: 'error', message: error.message });
  }
}
