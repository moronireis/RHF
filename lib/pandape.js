/**
 * Pandapé API client — OAuth2 (client_credentials), fetch-based, no npm dependency.
 *
 * Env vars required:
 *   PANDAPE_CLIENT_ID       — OAuth2 client ID
 *   PANDAPE_CLIENT_SECRET   — OAuth2 client secret
 *   PANDAPE_API_URL         — Base API URL (default: https://api.pandape.com.br)
 *   PANDAPE_TOKEN_URL       — Token endpoint (default: https://api.pandape.com.br/oauth/token)
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
 * Thread-safe for a single-process serverless context (no concurrent refreshes issue).
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
 * @returns {Promise<object>}
 */
async function apiGet(path) {
  const { apiUrl } = getConfig();
  const token = await getToken();
  const url = `${apiUrl}${path}`;

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
