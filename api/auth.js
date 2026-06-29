/**
 * Auth: Unified handler
 *
 * POST /api/auth?action=login          → { email, password }
 * POST /api/auth?action=verify         → { token }
 * POST /api/auth?action=create-admin   → { email, password, role?, full_name?, ... } + Bearer token (admin) or secret
 * POST /api/auth?action=update-profile → { user_id, role?, full_name?, ... } + Bearer token (admin) or secret
 * POST /api/auth?action=disable-user   → { user_id } + Bearer token (admin)
 * GET  /api/auth?action=list-users     → Bearer token (admin)
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || req.body?.action;

  if (action === 'login' && req.method === 'POST') return handleLogin(req, res);
  if (action === 'verify' && req.method === 'POST') return handleVerify(req, res);
  if (action === 'create-admin' && req.method === 'POST') return handleCreateAdmin(req, res);
  if (action === 'update-profile' && req.method === 'POST') return handleUpdateProfile(req, res);
  if (action === 'list-users' && req.method === 'GET') return handleListUsers(req, res);
  if (action === 'disable-user' && req.method === 'POST') return handleDisableUser(req, res);

  return res.status(400).json({ error: 'Ação inválida.' });
}

// ─── Helper: verify Bearer token is admin ────────────────────────────────────

async function requireAdmin(req, supabaseUrl, supabaseKey, serviceKey) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok || !data.id) return null;

    const profile = serviceKey ? await fetchUserProfile(data.id, supabaseUrl, serviceKey) : null;
    if (!profile || profile.role !== 'admin') return null;
    return { userId: data.id, email: data.email };
  } catch {
    return null;
  }
}

// ─── Helper: fetch user profile from user_profiles table ───────────────────

async function fetchUserProfile(userId, supabaseUrl, serviceKey) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/user_profiles?id=eq.${userId}&limit=1`, {
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

// ─── Login ──────────────────────────────────────────────────────────────────

async function handleLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Configuração de servidor inválida.' });

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok || data.error) return res.status(401).json({ error: 'Email ou senha incorretos.' });

    const userId = data.user?.id;
    const profile = serviceKey ? await fetchUserProfile(userId, supabaseUrl, serviceKey) : null;

    return res.status(200).json({
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      expires_in: data.expires_in,
      user: { id: userId, email: data.user?.email },
      profile: profile ? {
        role: profile.role,
        full_name: profile.full_name,
        chatguru_agent_id: profile.chatguru_agent_id,
        pandape_manager_id: profile.pandape_manager_id,
      } : { role: 'recrutador', full_name: null, chatguru_agent_id: null, pandape_manager_id: null },
    });
  } catch (err) {
    console.error('[auth/login] error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}

// ─── Verify ─────────────────────────────────────────────────────────────────

async function handleVerify(req, res) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token é obrigatório.' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Configuração de servidor inválida.' });

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok || data.error || !data.id) return res.status(401).json({ error: 'Token inválido ou expirado.' });

    const profile = serviceKey ? await fetchUserProfile(data.id, supabaseUrl, serviceKey) : null;

    return res.status(200).json({
      user: { id: data.id, email: data.email },
      profile: profile ? {
        role: profile.role,
        full_name: profile.full_name,
        chatguru_agent_id: profile.chatguru_agent_id,
        pandape_manager_id: profile.pandape_manager_id,
      } : { role: 'recrutador', full_name: null, chatguru_agent_id: null, pandape_manager_id: null },
    });
  } catch (err) {
    console.error('[auth/verify] error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}

// ─── Create Admin/User ───────────────────────────────────────────────────────

async function handleCreateAdmin(req, res) {
  const { email, password, secret, role = 'recrutador', full_name, chatguru_agent_id, pandape_manager_id } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios.' });

  // Authorization: JWT admin OR ADMIN_SECRET
  const adminSecret = process.env.ADMIN_SECRET;
  const jwtAdmin = await requireAdmin(req, supabaseUrl, supabaseKey, serviceKey);
  if (!jwtAdmin && (!adminSecret || secret !== adminSecret)) {
    return res.status(403).json({ error: 'Acesso negado. Requer admin autenticado.' });
  }

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Create auth user
    const userRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const userData = await userRes.json();
    if (!userRes.ok || userData.error) {
      return res.status(400).json({ error: userData.error?.message || userData.msg || 'Erro ao criar usuário.' });
    }

    // 2. Insert user_profiles row
    const profileRes = await fetch(`${supabaseUrl}/rest/v1/user_profiles`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        id: userData.id,
        role: ['admin', 'recrutador'].includes(role) ? role : 'recrutador',
        full_name: full_name || null,
        chatguru_agent_id: chatguru_agent_id || null,
        pandape_manager_id: pandape_manager_id || null,
      }),
    });

    if (!profileRes.ok) {
      const profErr = await profileRes.text();
      console.warn('[auth/create-admin] profile insert warning:', profErr);
    }

    return res.status(201).json({
      message: 'Usuário criado com sucesso.',
      user: { id: userData.id, email: userData.email, role },
    });
  } catch (err) {
    console.error('[auth/create-admin] error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}

// ─── List Users (admin-only via JWT) ────────────────────────────────────────

async function handleListUsers(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Configuração inválida.' });

  const admin = await requireAdmin(req, supabaseUrl, supabaseKey, serviceKey);
  if (!admin) return res.status(403).json({ error: 'Acesso negado.' });

  try {
    // List all auth users
    const usersRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=200`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
    });
    if (!usersRes.ok) return res.status(500).json({ error: 'Erro ao listar usuários.' });
    const usersData = await usersRes.json();
    const authUsers = usersData.users || [];

    // Get all profiles
    const profilesRes = await fetch(`${supabaseUrl}/rest/v1/user_profiles?select=*`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` },
    });
    const profiles = profilesRes.ok ? await profilesRes.json() : [];
    const profileMap = {};
    if (Array.isArray(profiles)) profiles.forEach(p => { profileMap[p.id] = p; });

    const users = authUsers.map(u => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      is_banned: u.banned_until ? new Date(u.banned_until) > new Date() : false,
      ...(profileMap[u.id] || { role: 'recrutador', full_name: null, chatguru_agent_id: null, pandape_manager_id: null }),
    }));

    return res.status(200).json({ status: 'ok', users });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── Disable User (admin-only via JWT) ──────────────────────────────────────

async function handleDisableUser(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Configuração inválida.' });

  const admin = await requireAdmin(req, supabaseUrl, supabaseKey, serviceKey);
  if (!admin) return res.status(403).json({ error: 'Acesso negado.' });

  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id é obrigatório.' });
  if (user_id === admin.userId) return res.status(400).json({ error: 'Não é possível desativar sua própria conta.' });

  try {
    // Ban user indefinitely via Supabase Admin API
    const banUntil = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString(); // 100 years
    const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user_id}`, {
      method: 'PUT',
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ban_duration: '876000h' }),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(400).json({ error: err });
    }
    return res.status(200).json({ status: 'ok', message: 'Usuário desativado.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── Update Profile (admin-only via ADMIN_SECRET) ───────────────────────────

async function handleUpdateProfile(req, res) {
  const { user_id, secret, role, full_name, chatguru_agent_id, pandape_manager_id } = req.body || {};

  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || secret !== adminSecret) return res.status(403).json({ error: 'Secret incorreto.' });
  if (!user_id) return res.status(400).json({ error: 'user_id é obrigatório.' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Configuração inválida.' });

  const updates = {};
  if (role && ['admin', 'recrutador'].includes(role)) updates.role = role;
  if (full_name !== undefined) updates.full_name = full_name;
  if (chatguru_agent_id !== undefined) updates.chatguru_agent_id = chatguru_agent_id;
  if (pandape_manager_id !== undefined) updates.pandape_manager_id = pandape_manager_id;

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

  try {
    const res2 = await fetch(`${supabaseUrl}/rest/v1/user_profiles?id=eq.${user_id}`, {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(updates),
    });

    if (!res2.ok) {
      const errText = await res2.text();
      return res.status(400).json({ error: errText });
    }

    const updated = await res2.json();
    return res.status(200).json({ status: 'ok', profile: Array.isArray(updated) ? updated[0] : updated });
  } catch (err) {
    console.error('[auth/update-profile] error:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
}
