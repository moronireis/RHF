/**
 * Auth: Create Admin — ONE-TIME endpoint
 *
 * POST /api/auth/create-admin
 * Body: { email, password, secret }
 * The `secret` must match env var ADMIN_SECRET.
 * Uses Supabase service role key to bypass email confirmation.
 *
 * Disable this endpoint after first use by removing from vercel.json or
 * returning 404 unconditionally.
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, secret } = req.body || {};

  // Guard: secret must match env var
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return res.status(500).json({ error: 'ADMIN_SECRET env var não configurada.' });
  }
  if (secret !== adminSecret) {
    return res.status(403).json({ error: 'Secret incorreto.' });
  }

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  // Service role key required for admin user creation (bypasses email confirmation)
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios.' });
  }

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true, // skip email confirmation
      }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      console.error('[auth/create-admin] supabase error:', data);
      return res.status(400).json({ error: data.error?.message || data.msg || 'Erro ao criar usuário.' });
    }

    return res.status(201).json({
      message: 'Usuário admin criado com sucesso.',
      user: {
        id: data.id,
        email: data.email,
      },
    });
  } catch (err) {
    console.error('[auth/create-admin] error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
