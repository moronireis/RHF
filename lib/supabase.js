/**
 * Supabase REST API client — fetch-based, no npm dependency.
 * Uses process.env.SUPABASE_URL and process.env.SUPABASE_KEY.
 */

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY env vars are required');
  return { url, key };
}

function headers(key, extras = {}) {
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extras,
  };
}

/**
 * SELECT rows from a table.
 * @param {string} table - Table name
 * @param {string} query - Query string e.g. "phone=eq.5511...&order=created_at.desc&limit=50"
 * @returns {Promise<Array>}
 */
export async function select(table, query = '') {
  const { url, key } = getClient();
  const qs = query ? `?${query}` : '';
  const res = await fetch(`${url}/rest/v1/${table}${qs}`, {
    headers: headers(key),
  });
  return res.json();
}

/**
 * INSERT a row into a table.
 * @param {string} table - Table name
 * @param {object} data - Row data
 * @param {boolean} returning - Whether to return the inserted row (default: true)
 * @returns {Promise<Array|boolean>}
 */
export async function insert(table, data, returning = true) {
  const { url, key } = getClient();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers(key, {
      'Prefer': returning ? 'return=representation' : 'return=minimal',
    }),
    body: JSON.stringify(data),
  });
  return returning ? res.json() : res.ok;
}

/**
 * UPSERT a row into a table (insert or update on conflict).
 * @param {string} table - Table name
 * @param {object} data - Row data
 * @param {string} onConflict - Column(s) to match on conflict e.g. "phone"
 * @returns {Promise<Array>}
 */
export async function upsert(table, data, onConflict = '') {
  const { url, key } = getClient();
  const prefer = onConflict
    ? `return=representation,resolution=merge-duplicates`
    : 'return=representation';
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  const res = await fetch(`${url}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: headers(key, { 'Prefer': prefer }),
    body: JSON.stringify(data),
  });
  return res.json();
}
