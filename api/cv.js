/**
 * CV Unified Handler — Vercel Serverless Function
 *
 * POST /api/cv?action=generate          → { candidate_id, vacancy_id? }
 * GET  /api/cv?action=query             → list/fetch CVs
 * GET  /api/cv?action=query&id=X        → single CV
 * POST /api/cv?action=send-email        → { cv_id, to, cc?, candidate_name? }
 * POST /api/cv?action=upload-chatguru   → { cv_id, phone, file_base64, file_name? }
 */

import { select, insert } from '../lib/supabase.js';
import { getVacancy } from '../lib/pandape.js';
import { sendFile as chatguruSendFile } from '../lib/chatguru.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  if (action === 'generate' && req.method === 'POST') return handleGenerate(req, res);
  if (action === 'query' && req.method === 'GET') return handleQuery(req, res);
  if (action === 'send-email' && req.method === 'POST') return handleSendEmail(req, res);
  if (action === 'upload-chatguru' && req.method === 'POST') return handleUploadChatguru(req, res);

  return res.status(400).json({ error: 'Use action=generate (POST) | query (GET) | send-email (POST) | upload-chatguru (POST)' });
}

// ─── Query ────────────────────────────────────────────────────────────────────

async function handleQuery(req, res) {
  try {
    const { id, candidate_id, limit = '20' } = req.query;

    if (id) {
      const rows = await select('cvs', `id=eq.${id}&limit=1`);
      if (!Array.isArray(rows) || rows.length === 0) return res.status(404).json({ status: 'error', message: `CV ${id} not found` });
      return res.status(200).json({ status: 'ok', data: rows[0] });
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const parts = [`order=created_at.desc&limit=${parsedLimit}`];
    if (candidate_id) parts.push(`candidate_id=eq.${candidate_id}`);
    const cvs = await select('cvs', parts.join('&'));

    return res.status(200).json({ status: 'ok', count: Array.isArray(cvs) ? cvs.length : 0, data: Array.isArray(cvs) ? cvs : [] });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}

// ─── Generate ─────────────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var is required');

  const r = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
  });
  if (!r.ok) { const body = await r.text(); throw new Error(`Claude API error (${r.status}): ${body}`); }
  const data = await r.json();
  return { text: data?.content?.[0]?.text ?? '', promptTokens: data?.usage?.input_tokens ?? 0, completionTokens: data?.usage?.output_tokens ?? 0 };
}

const SYSTEM_PROMPT = `Você é um especialista em recrutamento e seleção brasileiro, com 15 anos de experiência no mercado de RH. Sua tarefa é gerar currículos profissionais em Português (PT-BR) a partir de dados brutos de candidatos e histórico de conversas WhatsApp.

Diretrizes:
- Escreva em Português brasileiro formal, mas natural
- Quando os dados forem incompletos, redija o que for possível
- Extraia informações relevantes do histórico de conversa WhatsApp
- Se houver contexto de vaga, adapte o Resumo Profissional para a posição
- Seja conciso e objetivo — recrutadores leem currículos em 6 segundos
- Use bullet points nas seções de experiência e competências
- Nunca invente informações — se não há dado, indique "Não informado"

Formato de saída OBRIGATÓRIO (use estas tags XML):
<resumo>[2-4 frases sobre o perfil profissional]</resumo>
<experiencia>[Experiências como bullet points]</experiencia>
<competencias>[Lista de competências]</competencias>
<formacao>[Formação acadêmica]</formacao>
<observacoes>[Disponibilidade, pretensão salarial, localização]</observacoes>`;

function buildUserPrompt(candidate, messages, vacancy) {
  const lines = [];
  lines.push('=== DADOS DO CANDIDATO ===');
  lines.push(`Nome: ${candidate.name ?? 'Não informado'}`);
  lines.push(`Email: ${candidate.email ?? 'Não informado'}`);
  lines.push(`Telefone: ${candidate.phone ?? 'Não informado'}`);
  lines.push(`Vaga de origem: ${candidate.vacancy_name ?? 'Não informada'}`);
  lines.push(`Estágio atual: ${candidate.stage ?? 'Não informado'}`);

  if (candidate.raw_data && typeof candidate.raw_data === 'object') {
    const raw = candidate.raw_data;
    const skills = raw.Skills ?? raw.skills ?? raw.Competencias ?? null;
    const experience = raw.Experience ?? raw.experience ?? raw.Experiencia ?? null;
    const education = raw.Education ?? raw.education ?? raw.Formacao ?? null;
    const summary = raw.Summary ?? raw.summary ?? raw.Resumo ?? null;
    const linkedin = raw.LinkedIn ?? raw.linkedin ?? raw.LinkedInUrl ?? null;
    if (skills) lines.push(`\nCompetências (Pandapé): ${JSON.stringify(skills)}`);
    if (experience) lines.push(`\nExperiência (Pandapé): ${JSON.stringify(experience)}`);
    if (education) lines.push(`\nFormação (Pandapé): ${JSON.stringify(education)}`);
    if (summary) lines.push(`\nResumo (Pandapé): ${summary}`);
    if (linkedin) lines.push(`\nLinkedIn: ${linkedin}`);
    lines.push(`\nDados completos do Pandapé (JSON):\n${JSON.stringify(raw, null, 2)}`);
  }

  if (messages && messages.length > 0) {
    lines.push('\n=== HISTÓRICO DE CONVERSA WHATSAPP ===');
    for (const msg of messages) {
      const dir = msg.direction === 'inbound' ? 'Candidato' : 'RHF';
      const date = msg.created_at ? new Date(msg.created_at).toLocaleDateString('pt-BR') : '';
      const content = msg.content ?? msg.text ?? '';
      if (content) lines.push(`[${date}] ${dir}: ${content}`);
    }
  }

  if (vacancy) {
    lines.push('\n=== CONTEXTO DA VAGA ===');
    lines.push(`Título: ${vacancy.Title ?? vacancy.title ?? vacancy.Name ?? vacancy.name ?? 'Não informado'}`);
    if (vacancy.Description ?? vacancy.description) lines.push(`Descrição: ${vacancy.Description ?? vacancy.description}`);
    if (vacancy.Requirements ?? vacancy.requirements) lines.push(`Requisitos: ${JSON.stringify(vacancy.Requirements ?? vacancy.requirements)}`);
  }

  lines.push('\nGere o currículo completo seguindo o formato XML especificado.');
  return lines.join('\n');
}

function parseCvSections(text) {
  const extract = (tag) => { const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i')); return m ? m[1].trim() : ''; };
  const resumo = extract('resumo'), experiencia = extract('experiencia'), competencias = extract('competencias'), formacao = extract('formacao'), observacoes = extract('observacoes');
  const parts = [];
  if (resumo) { parts.push('RESUMO PROFISSIONAL', resumo); }
  if (experiencia) { parts.push('\nEXPERIÊNCIA PROFISSIONAL', experiencia); }
  if (competencias) { parts.push('\nCOMPETÊNCIAS', competencias); }
  if (formacao) { parts.push('\nFORMAÇÃO ACADÊMICA', formacao); }
  if (observacoes) { parts.push('\nOBSERVAÇÕES', observacoes); }
  return { resumo, experiencia, competencias, formacao, observacoes, full_text: parts.join('\n') };
}

async function handleGenerate(req, res) {
  try {
    const { candidate_id, vacancy_id } = req.body ?? {};
    if (!candidate_id) return res.status(400).json({ status: 'error', message: 'candidate_id is required' });

    const candidates = await select('candidates', `id=eq.${candidate_id}&limit=1`);
    if (!Array.isArray(candidates) || candidates.length === 0) return res.status(404).json({ status: 'error', message: `Candidate ${candidate_id} not found` });
    const candidate = candidates[0];

    let messages = [];
    if (candidate.phone) {
      try {
        const raw = await select('rhf_messages', `phone=eq.${candidate.phone}&order=created_at.desc&limit=20`);
        if (Array.isArray(raw)) messages = raw.reverse();
      } catch (err) { console.warn('[CV] messages fetch failed:', err.message); }
    }

    let vacancy = null;
    const vid = vacancy_id ?? candidate.vacancy_id ?? null;
    if (vid) { try { vacancy = await getVacancy(vid); } catch (err) { console.warn('[CV] vacancy skip:', err.message); } }

    const userPrompt = buildUserPrompt(candidate, messages, vacancy);
    const { text: rawResponse, promptTokens, completionTokens } = await callClaude(SYSTEM_PROMPT, userPrompt);
    const sections = parseCvSections(rawResponse);

    const vacancyName = vacancy?.Title ?? vacancy?.title ?? vacancy?.Name ?? vacancy?.name ?? candidate.vacancy_name ?? null;

    const cvRow = {
      candidate_id, vacancy_id: vid, vacancy_name: vacancyName,
      candidate_name: candidate.name ?? 'Não informado',
      cv_content: { resumo: sections.resumo, experiencia: sections.experiencia, competencias: sections.competencias, formacao: sections.formacao, observacoes: sections.observacoes },
      full_text: sections.full_text, model_used: MODEL, prompt_tokens: promptTokens, completion_tokens: completionTokens,
    };

    let savedCv = null;
    try { const ins = await insert('cvs', cvRow); savedCv = Array.isArray(ins) ? ins[0] : ins; } catch (err) { console.error('[CV] save failed:', err.message); }

    return res.status(200).json({
      status: 'ok',
      cv: {
        id: savedCv?.id ?? null, candidate_id, candidate_name: cvRow.candidate_name, vacancy_name: vacancyName,
        candidate_phone: candidate.phone ?? null,
        sections: cvRow.cv_content, full_text: sections.full_text, model_used: MODEL,
        prompt_tokens: promptTokens, completion_tokens: completionTokens,
        generated_at: savedCv?.created_at ?? new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[CV Generate] Error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}

// ─── Send Email ───────────────────────────────────────────────────────────────

async function handleSendEmail(req, res) {
  const { cv_id, to, cc, candidate_name } = req.body || {};
  if (!cv_id || !to) return res.status(400).json({ status: 'error', message: 'cv_id e to são obrigatórios.' });

  const resendKey = process.env.RESEND_API_KEY;
  const smtpFrom = process.env.SMTP_FROM || process.env.EMAIL_FROM || 'rhf@rhftalentos.com.br';

  if (!resendKey) {
    return res.status(500).json({ status: 'error', message: 'RESEND_API_KEY não configurada. Configure no painel do Vercel.' });
  }

  try {
    // Fetch CV data
    const rows = await select('cvs', `id=eq.${cv_id}&limit=1`);
    if (!Array.isArray(rows) || rows.length === 0) return res.status(404).json({ status: 'error', message: 'CV não encontrado.' });
    const cv = rows[0];

    const name = candidate_name || cv.candidate_name || 'Candidato';
    const sections = cv.cv_content || {};

    function nl2p(text) {
      if (!text) return '<p><em>Não informado</em></p>';
      return text.split('\n').filter(Boolean).map(l => `<p>${l}</p>`).join('');
    }

    const htmlBody = `
<!DOCTYPE html>
<html lang="pt-BR">
<body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:24px;color:#222;">
  <div style="background:#FF6B35;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;">Currículo — ${name}</h1>
    ${cv.vacancy_name ? `<p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;">Vaga: ${cv.vacancy_name}</p>` : ''}
  </div>
  <div style="border:1px solid #eee;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    ${sections.resumo ? `<h2 style="color:#FF6B35;font-size:14px;text-transform:uppercase;letter-spacing:.05em;">Resumo Profissional</h2>${nl2p(sections.resumo)}` : ''}
    ${sections.experiencia ? `<h2 style="color:#FF6B35;font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin-top:20px;">Experiência Profissional</h2>${nl2p(sections.experiencia)}` : ''}
    ${sections.competencias ? `<h2 style="color:#FF6B35;font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin-top:20px;">Competências</h2>${nl2p(sections.competencias)}` : ''}
    ${sections.formacao ? `<h2 style="color:#FF6B35;font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin-top:20px;">Formação Acadêmica</h2>${nl2p(sections.formacao)}` : ''}
    ${sections.observacoes ? `<h2 style="color:#FF6B35;font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin-top:20px;">Observações</h2>${nl2p(sections.observacoes)}` : ''}
    <hr style="border:none;border-top:1px solid #eee;margin-top:24px;">
    <p style="font-size:12px;color:#999;">Currículo gerado automaticamente pela Plataforma RHF Talentos IA</p>
  </div>
</body>
</html>`;

    const emailPayload = {
      from: smtpFrom,
      to: Array.isArray(to) ? to : [to],
      subject: `Currículo — ${name}${cv.vacancy_name ? ` | ${cv.vacancy_name}` : ''}`,
      html: htmlBody,
    };
    if (cc) emailPayload.cc = Array.isArray(cc) ? cc : [cc];

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailPayload),
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok) {
      return res.status(400).json({ status: 'error', message: emailData.message || 'Erro ao enviar email.' });
    }

    return res.status(200).json({ status: 'ok', message: 'Email enviado com sucesso.', email_id: emailData.id });
  } catch (error) {
    console.error('[CV send-email] error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}

// ─── Upload to ChatGuru ───────────────────────────────────────────────────────

async function handleUploadChatguru(req, res) {
  const { cv_id, phone, file_base64, file_name } = req.body || {};
  if (!cv_id || !phone) return res.status(400).json({ status: 'error', message: 'cv_id e phone são obrigatórios.' });
  if (!file_base64) return res.status(400).json({ status: 'error', message: 'file_base64 é obrigatório.' });

  try {
    const rows = await select('cvs', `id=eq.${cv_id}&limit=1`);
    const cv = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    const candidateName = cv?.candidate_name || 'candidato';
    const fileName = file_name || `curriculo-${candidateName.replace(/\s+/g, '-').toLowerCase()}.pdf`;

    const result = await chatguruSendFile(phone, file_base64, fileName, 'application/pdf');

    if (result?.result === 'success' || result?.status === 'ok' || result?.message_id) {
      return res.status(200).json({ status: 'ok', message: 'Currículo enviado para o ChatGuru.', chatguru: result });
    } else {
      return res.status(400).json({ status: 'error', message: 'ChatGuru não confirmou o upload.', chatguru: result });
    }
  } catch (error) {
    console.error('[CV upload-chatguru] error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
