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

/**
 * List chats from ChatGuru.
 * @param {object} params - optional filters: { agentId, status, limit, page }
 * @returns {Promise<object>} ChatGuru API response with chat list
 */
export async function listChats({ agentId, status, limit = 100, page = 1 } = {}) {
  const { key, endpoint, accountId, phoneId } = getConfig();
  const params = {
    key,
    account_id: accountId,
    phone_id: phoneId,
    action: 'chat_list',
    limit: String(limit),
    page: String(page),
  };
  if (agentId) params.agent_id = agentId;
  if (status) params.status = status;

  const body = new URLSearchParams(params);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return res.json();
}

/**
 * Get details for a specific chat (custom fields, status, process, tags).
 * @param {string} chatNumber
 * @returns {Promise<object>} ChatGuru API response with chat details
 */
export async function getChatDetails(chatNumber) {
  const { key, endpoint, accountId, phoneId } = getConfig();
  const body = new URLSearchParams({
    key,
    account_id: accountId,
    phone_id: phoneId,
    action: 'chat_info',
    chat_number: chatNumber,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return res.json();
}

/**
 * Get messages for a specific chat from ChatGuru.
 * @param {string} chatNumber
 * @param {number} limit
 * @returns {Promise<object>} ChatGuru API response with messages
 */
export async function getChatMessages(chatNumber, limit = 50) {
  const { key, endpoint, accountId, phoneId } = getConfig();
  const body = new URLSearchParams({
    key,
    account_id: accountId,
    phone_id: phoneId,
    action: 'chat_read',
    chat_number: chatNumber,
    limit: String(limit),
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return res.json();
}

/**
 * Send a file (PDF, image, etc.) to a chat in ChatGuru via base64.
 * @param {string} chatNumber
 * @param {string} fileBase64 - base64-encoded file content
 * @param {string} fileName - file name with extension (e.g. "curriculo-joao.pdf")
 * @param {string} mimeType - MIME type (e.g. "application/pdf")
 * @returns {Promise<object>} ChatGuru API response
 */
export async function sendFile(chatNumber, fileBase64, fileName, mimeType = 'application/pdf') {
  const { key, endpoint, accountId, phoneId } = getConfig();
  const body = new URLSearchParams({
    key,
    account_id: accountId,
    phone_id: phoneId,
    action: 'file_send',
    chat_number: chatNumber,
    file_name: fileName,
    file_type: mimeType,
    file_data: fileBase64,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return res.json();
}
