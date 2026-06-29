/**
 * Pandapé Manual Sync — Vercel Serverless Function
 *
 * GET  /api/pandape/sync?vacancy_id=XXX   → pull all matches for a vacancy
 * POST /api/pandape/sync                  → { vacancy_id } same as above
 *
 * Fetches all candidates from a Pandapé vacancy and upserts into Supabase.
 * Useful for initial backfill or re-sync without waiting for webhooks.
 */

import { upsert, insert } from '../../lib/supabase.js';
import { listMatches, getVacancy, listVacancies } from '../../lib/pandape.js';

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

function normalizeCandidate(match, vacancy) {
  const name    = pick(match, 'CandidateName', 'candidateName', 'Name', 'name');
  const email   = pick(match, 'CandidateEmail', 'candidateEmail', 'Email', 'email');
  const rawPhone = pick(match, 'CandidatePhone', 'candidatePhone', 'Phone', 'phone', 'Celular');
  const phone   = rawPhone ? String(rawPhone).replace(/\D/g, '') : null;

  const matchId   = pick(match, 'IdMatch', 'id', 'Id') ?? null;
  const vacancyId = pick(match, 'IdVacancy', 'vacancyId') ?? pick(vacancy, 'id', 'Id') ?? null;

  return {
    name,
    email,
    phone: phone || null,
    match_id: matchId ? Number(matchId) : null,
    vacancy_id: vacancyId ? Number(vacancyId) : null,
    vacancy_name: pick(vacancy, 'Title', 'title', 'Name', 'name'),
    stage: pick(match, 'FolderName', 'folderName', 'Stage', 'stage') ?? 'pandape_sync',
    stage_id: pick(match, 'IdVacancyFolder', 'folderId') ? Number(pick(match, 'IdVacancyFolder', 'folderId')) : null,
    stage_updated_at: new Date().toISOString(),
    cv_url: pick(match, 'CurriculumUrl', 'cv_url', 'CvUrl'),
    linkedin_url: pick(match, 'LinkedinUrl', 'linkedin_url'),
    city: pick(match, 'City', 'city', 'Cidade'),
    education: pick(match, 'Education', 'education', 'Escolaridade'),
    experience_years: (() => {
      const v = pick(match, 'ExperienceYears', 'experience_years');
      return v ? parseInt(v, 10) || null : null;
    })(),
    status: 'pandape_sync',
    raw_data: match,
    updated_at: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Simple admin guard
  const authHeader = req.headers['authorization'] || '';
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && authHeader !== `Bearer ${adminSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const vacancyId = req.query.vacancy_id ?? req.body?.vacancy_id ?? null;
  const syncAll   = req.query.all === 'true' || req.body?.all === true;

  try {
    const startedAt = new Date().toISOString();
    let synced = 0;
    let errors = 0;
    const details = [];

    if (syncAll || !vacancyId) {
      // Pull all open vacancies then sync each
      const vacRes = await listVacancies({ status: 'open', limit: 100 });
      const vacancies = vacRes?.data ?? vacRes?.items ?? (Array.isArray(vacRes) ? vacRes : []);
      console.log(`[Pandapé Sync] Found ${vacancies.length} open vacancies`);

      for (const vac of vacancies) {
        const vid = vac.id ?? vac.Id ?? vac.IdVacancy;
        try {
          const matchRes = await listMatches(vid, { limit: 200 });
          const matches = matchRes?.data ?? matchRes?.items ?? (Array.isArray(matchRes) ? matchRes : []);
          for (const m of matches) {
            const row = normalizeCandidate(m, vac);
            if (!row.match_id) continue;
            await upsert('candidates', row, 'match_id');
            synced++;
          }
          details.push({ vacancy_id: vid, name: vac.Title ?? vac.title, matches: matches.length });
        } catch (e) {
          errors++;
          details.push({ vacancy_id: vid, error: e.message });
        }
      }
    } else {
      // Single vacancy sync
      const [matchRes, vacancy] = await Promise.all([
        listMatches(vacancyId, { limit: 200 }),
        getVacancy(vacancyId),
      ]);
      const matches = matchRes?.data ?? matchRes?.items ?? (Array.isArray(matchRes) ? matchRes : []);
      console.log(`[Pandapé Sync] Vacancy ${vacancyId}: ${matches.length} matches`);

      for (const m of matches) {
        try {
          const row = normalizeCandidate(m, vacancy);
          if (!row.match_id) continue;
          await upsert('candidates', row, 'match_id');
          synced++;
        } catch (e) {
          errors++;
        }
      }
      details.push({ vacancy_id: vacancyId, name: vacancy?.Title ?? vacancy?.title, matches: matches.length, synced });
    }

    await insert('sync_log', {
      source: 'pandape', action: 'manual_sync', entity_type: 'batch',
      entity_id: vacancyId ? String(vacancyId) : 'all',
      status: errors === 0 ? 'success' : 'partial',
      payload: { synced, errors, vacancy_id: vacancyId, started_at: startedAt, details },
    });

    return res.status(200).json({ status: 'ok', synced, errors, details });

  } catch (error) {
    console.error('[Pandapé Sync] Error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
