/**
 * Auth: Unified handler — login, verify, create-admin
 *
 * POST /api/auth?action=login      → { email, password }
 * POST /api/auth?action=verify     → { token }
 * POST /api/auth?action=create-admin → { email, password, secret }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = req.query.action || req.body?.action;

  if (action === 'login') return handleLogin(req, res);
  if (action === 'verify') return handleVerify(req, res);
  if (action === 'create-admin') return handleCreateAdmin(req, res);

  return res.status(400).json({ error: 'Ação inválida. Use action=login|verify|create-admin' });
}

async function handleLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Configuração de servidor inválida.' });

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok || data.error) return res.status(401).json({ error: 'Email ou senha incorretos.' });

    return res.status(200).json({
      access_token: data.access_token,
      expires_in: data.expires_in,
      user: { id: data.user?.id, email: data.user?.email },
    });
  } catch (err) {
    console.error('[auth/login] error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}

async function handleVerify(req, res) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token é obrigatório.' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Configuração de servidor inválida.' });

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok || data.error || !data.id) return res.status(401).json({ error: 'Token inválido ou expirado.' });

    return res.status(200).json({ user: { id: data.id, email: data.email } });
  } catch (err) {
    console.error('[auth/verify] error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}

async function handleCreateAdmin(req, res) {
  const { email, password, secret } = req.body || {};

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return res.status(500).json({ error: 'ADMIN_SECRET env var não configurada.' });
  if (secret !== adminSecret) return res.status(403).json({ error: 'Secret incorreto.' });
  if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios.' });

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      console.error('[auth/create-admin] supabase error:', data);
      return res.status(400).json({ error: data.error?.message || data.msg || 'Erro ao criar usuário.' });
    }

    return res.status(201).json({
      message: 'Usuário admin criado com sucesso.',
      user: { id: data.id, email: data.email },
    });
  } catch (err) {
    console.error('[auth/create-admin] error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
