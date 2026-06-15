/**
 * ChatGuru API client — fetch-based, no npm dependency.
 * Uses process.env.CHATGURU_KEY, CHATGURU_ENDPOINT,
 * CHATGURU_ACCOUNT_ID, CHATGURU_PHONE_ID.
 */

function getConfig() {
  const key = process.env.CHATGURU_KEY;
  const endpoint = process.env.CHATGURU_ENDPOINT;
  const accountId = process.env.CHATGURU_ACCOUNT_ID;
  const phoneId = process.env.CHATGURU_PHONE_ID;
  if (!key || !endpoint || !accountId || !phoneId) {
    throw new Error('CHATGURU_KEY, CHATGURU_ENDPOINT, CHATGURU_ACCOUNT_ID, CHATGURU_PHONE_ID env vars are required');
  }
  return { key, endpoint, accountId, phoneId };
}

/**
 * Send a text message via ChatGuru.
 * @param {string} chatNumber - Recipient phone number (e.g. "5511967615987")
 * @param {string} text - Message text
 * @returns {Promise<object>} ChatGuru API response
 */
export async function sendMessage(chatNumber, text) {
  const { key, endpoint, accountId, phoneId } = getConfig();
  const body = new URLSearchParams({
    key,
    account_id: accountId,
    phone_id: phoneId,
    action: 'message_send',
    chat_number: chatNumber,
    text,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return res.json();
}

/**
 * Create a contact (chat) in ChatGuru.
 * @param {object} params - { chatNumber, name, ...extra fields }
 * @returns {Promise<object>} ChatGuru API response
 */
export async function createContact({ chatNumber, name, ...extra }) {
  const { key, endpoint, accountId, phoneId } = getConfig();
  const body = new URLSearchParams({
    key,
    account_id: accountId,
    phone_id: phoneId,
    action: 'chat_add',
    chat_number: chatNumber,
    ...(name ? { name } : {}),
    ...extra,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return res.json();
}
