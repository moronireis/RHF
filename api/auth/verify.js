/**
 * Auth: Verify — Vercel Serverless Function
 *
 * POST /api/auth/verify
 * Body: { token }
 * Returns: { user } on success
 * Returns: 401 { error } on failure
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body || {};

  if (!token) {
    return res.status(400).json({ error: 'Token é obrigatório.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Configuração de servidor inválida.' });
  }

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${token}`,
      },
    });

    const data = await response.json();

    if (!response.ok || data.error || !data.id) {
      return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }

    return res.status(200).json({
      user: {
        id: data.id,
        email: data.email,
      },
    });
  } catch (err) {
    console.error('[auth/verify] error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
}
