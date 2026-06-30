/**
 * Pandapé API client — OAuth2 (client_credentials), fetch-based, no npm dependency.
 *
 * Env vars required:
 *   PANDAPE_CLIENT_ID       — OAuth2 client ID ("Client ID" from Pandapé settings)
 *   PANDAPE_CLIENT_SECRET   — OAuth2 client secret
 *   PANDAPE_API_URL         — Base API URL (default: https://api.pandape.com.br)
 *   PANDAPE_TOKEN_URL       — Token endpoint (default: https://api.pandape.com.br/oauth/token)
 *
 * Key facts from Pandapé integration meeting (03/06/2026):
 *  - Bearer token expires in 7 days (604800 seconds). expires_in is returned in the token response.
 *  - Full candidate data (phone, CV, etc.) is ONLY available via API for candidates in
 *    "Finalistas" or "Contratados" stages. Earlier stages return incomplete data.
 *  - Webhook fires on "Candidato mudou de estágio em uma vaga" event. Configure in:
 *    Pandapé gear icon → Webhooks → select event → set stage = Finalistas AND Contratados.
 *  - Webhook auth must be Bearer type (not Basic/Base64).
 *  - To move a candidate between stages, use the MAT/match endpoint with a PUT/PATCH.
 *  - Use getVacancyFolders(vacancyId) to resolve IdVacancyFolderTo → folder name.
 */

/** Module-level token cache — survives across requests in the same warm Lambda instance. */
let _cache = {
  token: null,
  expiresAt: 0, // epoch ms
};

/** How many ms before expiry to proactively refresh (60 seconds). */
const REFRESH_BUFFER_MS = 60_000;

function getConfig() {
  const clientId = process.env.PANDAPE_CLIENT_ID;
  const clientSecret = process.env.PANDAPE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PANDAPE_CLIENT_ID and PANDAPE_CLIENT_SECRET env vars are required');
  }
  return {
    clientId,
    clientSecret,
    apiUrl: (process.env.PANDAPE_API_URL || 'https://api.pandape.com.br').replace(/\/$/, ''),
    tokenUrl: process.env.PANDAPE_TOKEN_URL || 'https://api.pandape.com.br/oauth/token',
  };
}

/**
 * Fetch a fresh token from Pandapé's OAuth2 token endpoint.
 * Uses the standard client_credentials grant with application/x-www-form-urlencoded body.
 * @returns {Promise<{ token: string, expiresAt: number }>}
 */
async function fetchToken() {
  const { clientId, clientSecret, tokenUrl } = getConfig();

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pandapé token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  // Standard OAuth2 response: { access_token, token_type, expires_in (seconds) }
  const expiresIn = data.expires_in ?? 3600; // default 1 hour if not provided
  return {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/**
 * Returns a valid Bearer token, reusing the cached one if still fresh.
 * @returns {Promise<string>}
 */
export async function getToken() {
  const now = Date.now();
  if (_cache.token && _cache.expiresAt - REFRESH_BUFFER_MS > now) {
    return _cache.token;
  }

  console.log('[Pandapé] Fetching new OAuth2 token...');
  const { token, expiresAt } = await fetchToken();
  _cache = { token, expiresAt };
  console.log(`[Pandapé] Token cached, expires in ${Math.round((expiresAt - now) / 1000)}s`);
  return token;
}

/**
 * Make an authenticated GET request to the Pandapé API.
 * @param {string} path - API path (e.g. "/v2/matches/602649148")
 * @param {object} queryParams - optional query parameters
 * @returns {Promise<object>}
 */
async function apiGet(path, queryParams = {}) {
  const { apiUrl } = getConfig();
  const token = await getToken();

  const qs = Object.keys(queryParams).length
    ? '?' + new URLSearchParams(queryParams).toString()
    : '';
  const url = `${apiUrl}${path}${qs}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pandapé GET ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Fetch full candidate+vacancy match data.
 * @param {number|string} idMatch
 * @returns {Promise<object>} Full match object from Pandapé
 */
export async function getMatch(idMatch) {
  return apiGet(`/v2/matches/${idMatch}`);
}

/**
 * Fetch vacancy details by ID.
 * @param {number|string} idVacancy
 * @returns {Promise<object>} Vacancy object from Pandapé
 */
export async function getVacancy(idVacancy) {
  return apiGet(`/v2/vacancies/${idVacancy}`);
}

/**
 * List vacancies with optional filters.
 * @param {object} params - { status, companyId, page, limit, managerId }
 * @returns {Promise<object>} Vacancy list from Pandapé
 */
export async function listVacancies({ status, companyId, page = 1, limit = 50, managerId } = {}) {
  const query = { page: String(page), limit: String(limit) };
  if (status) query.status = status;
  if (companyId) query.companyId = String(companyId);
  if (managerId) query.managerId = String(managerId);
  return apiGet('/v2/vacancies', query);
}

/**
 * List candidates (matches) for a vacancy, optionally filtered by stage folder.
 * @param {number|string} vacancyId
 * @param {object} params - { stage, folderId, page, limit }
 * @returns {Promise<object>} Match list from Pandapé
 */
export async function listMatches(vacancyId, { stage, folderId, page = 1, limit = 100 } = {}) {
  const query = { idVacancy: String(vacancyId), page: String(page), limit: String(limit) };
  if (stage) query.stage = stage;
  if (folderId) query.idVacancyFolder = String(folderId); // filter by specific stage folder
  return apiGet('/v2/matches', query);
}

/**
 * List all matches where the given manager is responsible.
 * Fetches vacancies by manager, then matches for each.
 * @param {string} managerId - Pandapé manager/recruiter ID
 * @returns {Promise<Array>} Combined match list
 */
export async function listMatchesByManager(managerId) {
  const vacanciesRes = await listVacancies({ managerId, limit: 100 });
  const vacancies = vacanciesRes?.data ?? vacanciesRes?.items ?? (Array.isArray(vacanciesRes) ? vacanciesRes : []);

  if (!vacancies.length) return [];

  const matchArrays = await Promise.allSettled(
    vacancies.map(v => listMatches(v.id ?? v.IdVacancy ?? v.vacancyId))
  );

  const allMatches = [];
  matchArrays.forEach(r => {
    if (r.status === 'fulfilled') {
      const items = r.value?.data ?? r.value?.items ?? (Array.isArray(r.value) ? r.value : []);
      allMatches.push(...items);
    }
  });

  return allMatches;
}

/**
 * Get all stages (folders) for a vacancy, including their IDs and names.
 * Use this to resolve IdVacancyFolderTo / IdVacancyFolderFrom webhook fields to names.
 * @param {number|string} vacancyId
 * @returns {Promise<Array<{ id, name, order }>>}
 */
export async function getVacancyFolders(vacancyId) {
  const res = await apiGet(`/v2/vacancies/${vacancyId}/folders`);
  // Response may be array or { data: [...] }
  return res?.data ?? res?.items ?? (Array.isArray(res) ? res : []);
}

/**
 * Resolve a folder ID to its name for a given vacancy.
 * Falls back to `etapa_${folderId}` if not found.
 * @param {number|string} vacancyId
 * @param {number|string} folderId - IdVacancyFolderTo or IdVacancyFolderFrom
 * @returns {Promise<string>}
 */
export async function resolveFolderName(vacancyId, folderId) {
  try {
    const folders = await getVacancyFolders(vacancyId);
    const folder = folders.find(f => String(f.id ?? f.Id ?? f.IdFolder) === String(folderId));
    return folder?.name ?? folder?.Name ?? folder?.Title ?? `etapa_${folderId}`;
  } catch {
    return `etapa_${folderId}`;
  }
}

/**
 * Move a candidate (match) to a different stage (folder) within the same vacancy.
 * Per Pandapé integration docs: only possible for candidates already in Finalistas or Contratados.
 * @param {number|string} idMatch
 * @param {number|string} idVacancyFolderTo - destination folder/stage ID
 * @returns {Promise<object>}
 */
export async function moveCandidate(idMatch, idVacancyFolderTo) {
  const { apiUrl } = getConfig();
  const token = await getToken();

  const res = await fetch(`${apiUrl}/v2/matches/${idMatch}/folder`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ IdVacancyFolder: Number(idVacancyFolderTo) }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pandapé moveCandidate ${idMatch}→${idVacancyFolderTo} failed (${res.status}): ${text}`);
  }

  return res.json();
}
