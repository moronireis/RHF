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

/**
 * Build CV sections directly from structured Pandapé data + WhatsApp messages.
 * No LLM involved — deterministic, instant, zero cost.
 */
function buildCvFromData(candidate, messages, vacancy) {
  const raw = (candidate.raw_data && typeof candidate.raw_data === 'object') ? candidate.raw_data : {};

  // ── helper to pick among multiple field name conventions ──
  function pick(...keys) {
    for (const k of keys) { if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k]; }
    return null;
  }

  // ── RESUMO ────────────────────────────────────────────────
  const summaryRaw = pick('Summary', 'summary', 'Resumo', 'Bio', 'bio', 'ProfessionalSummary');
  const vagaCtx = vacancy?.Title ?? vacancy?.title ?? candidate.vacancy_name ?? null;
  let resumo = '';
  if (summaryRaw) {
    resumo = String(summaryRaw).trim();
  } else {
    // Build a minimal summary from name + experience years + city
    const expYears = candidate.experience_years ?? pick('ExperienceYears', 'experience_years', 'AnosExperiencia');
    const city = candidate.city ?? pick('City', 'city', 'Cidade');
    const parts = [];
    if (candidate.name) parts.push(`${candidate.name} é um profissional`);
    if (expYears) parts.push(`com ${expYears} ${Number(expYears) === 1 ? 'ano' : 'anos'} de experiência`);
    if (city) parts.push(`localizado em ${city}`);
    if (vagaCtx) parts.push(`candidato à vaga de ${vagaCtx}`);
    resumo = parts.length > 0 ? parts.join(' ') + '.' : 'Perfil profissional não detalhado no cadastro.';
  }

  // ── EXPERIÊNCIA ──────────────────────────────────────────
  const experienceRaw = pick('Experience', 'experience', 'Experiences', 'Experiencia', 'WorkHistory', 'Jobs');
  const lines = [];
  if (Array.isArray(experienceRaw) && experienceRaw.length > 0) {
    for (const exp of experienceRaw) {
      const title = exp.JobTitle ?? exp.Title ?? exp.Cargo ?? exp.Role ?? exp.title ?? '';
      const company = exp.Company ?? exp.Empresa ?? exp.company ?? '';
      const start = exp.StartDate ?? exp.DataInicio ?? exp.start ?? '';
      const end = exp.EndDate ?? exp.DataFim ?? exp.end ?? 'Atual';
      const desc = exp.Description ?? exp.Descricao ?? exp.description ?? '';
      const period = [start, end].filter(Boolean).join(' – ');
      const header = [title, company, period].filter(Boolean).join(' | ');
      if (header) lines.push(`• ${header}`);
      if (desc) lines.push(`  ${String(desc).replace(/\n/g, ' ').trim()}`);
    }
  } else if (typeof experienceRaw === 'string' && experienceRaw.trim()) {
    lines.push(experienceRaw.trim());
  }
  const experiencia = lines.length > 0 ? lines.join('\n') : null;

  // ── COMPETÊNCIAS ─────────────────────────────────────────
  const skillsRaw = pick('Skills', 'skills', 'Competencias', 'Habilidades', 'Abilities', 'Competencies');
  const skillLines = [];
  if (Array.isArray(skillsRaw) && skillsRaw.length > 0) {
    for (const s of skillsRaw) {
      const name = (typeof s === 'string') ? s : (s.Name ?? s.name ?? s.Skill ?? s.skill ?? JSON.stringify(s));
      if (name) skillLines.push(`• ${name}`);
    }
  } else if (typeof skillsRaw === 'string' && skillsRaw.trim()) {
    skillLines.push(skillsRaw.trim());
  }

  // If no skills from Pandapé, try to extract from WhatsApp messages
  if (skillLines.length === 0 && messages && messages.length > 0) {
    const skillKeywords = ['experiência em', 'experiencia em', 'conhecimento em', 'habilidade em', 'trabalho com', 'trabalho na', 'trabalho no', 'sei trabalhar', 'domínio de', 'dominio de', 'curso de', 'formação em', 'formacao em'];
    const extracted = new Set();
    for (const m of messages) {
      const text = ((m.content ?? m.text ?? '')).toLowerCase();
      for (const kw of skillKeywords) {
        const idx = text.indexOf(kw);
        if (idx !== -1) {
          const snippet = text.slice(idx + kw.length, idx + kw.length + 60).replace(/[.!?,;].*/, '').trim();
          if (snippet.length > 2) extracted.add(snippet.charAt(0).toUpperCase() + snippet.slice(1));
        }
      }
    }
    for (const s of extracted) skillLines.push(`• ${s}`);
  }

  const competencias = skillLines.length > 0 ? skillLines.join('\n') : null;

  // ── FORMAÇÃO ─────────────────────────────────────────────
  const educationRaw = pick('Education', 'education', 'Formacao', 'Escolaridade', 'Educations');
  const eduLines = [];
  if (Array.isArray(educationRaw) && educationRaw.length > 0) {
    for (const ed of educationRaw) {
      const degree = ed.Degree ?? ed.degree ?? ed.Curso ?? ed.course ?? '';
      const inst = ed.Institution ?? ed.institution ?? ed.Instituicao ?? ed.School ?? ed.school ?? '';
      const year = ed.Year ?? ed.year ?? ed.ConclusionYear ?? ed.EndYear ?? '';
      const parts = [degree, inst, year].filter(Boolean);
      if (parts.length > 0) eduLines.push(`• ${parts.join(' | ')}`);
    }
  } else if (typeof educationRaw === 'string' && educationRaw.trim()) {
    // Single string like "Ensino Superior Completo"
    const edu = candidate.education ?? educationRaw;
    eduLines.push(String(edu).trim());
  } else if (candidate.education) {
    eduLines.push(String(candidate.education).trim());
  }
  const formacao = eduLines.length > 0 ? eduLines.join('\n') : null;

  // ── OBSERVAÇÕES ──────────────────────────────────────────
  const obsLines = [];
  const city2 = candidate.city ?? pick('City', 'city', 'Cidade');
  const salary = candidate.salary_expectation ?? pick('SalaryExpectation', 'salary_expectation', 'PretensaoSalarial');
  const linkedin = candidate.linkedin_url ?? pick('LinkedinUrl', 'linkedin_url', 'Linkedin');
  const availability = pick('Availability', 'availability', 'Disponibilidade');
  if (city2) obsLines.push(`Localização: ${city2}`);
  if (salary) obsLines.push(`Pretensão salarial: R$ ${Number(salary).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  if (availability) obsLines.push(`Disponibilidade: ${availability}`);
  if (candidate.stage) obsLines.push(`Etapa no processo: ${candidate.stage}`);
  if (linkedin) obsLines.push(`LinkedIn: ${linkedin}`);
  if (candidate.email) obsLines.push(`E-mail: ${candidate.email}`);
  if (candidate.phone) obsLines.push(`Telefone: ${String(candidate.phone).replace(/(\d{2})(\d{2})(\d{4,5})(\d{4})/, '+$1 ($2) $3-$4')}`);

  // Supplement with relevant WhatsApp messages (text only, inbound from candidate)
  if (messages && messages.length > 0) {
    const waMsgs = messages
      .filter(m => (m.direction === 'inbound' || m.from_me === false) && (m.content ?? m.text ?? '').trim().length > 10)
      .slice(0, 10)
      .map(m => (m.content ?? m.text ?? '').trim());
    if (waMsgs.length > 0) {
      obsLines.push('\nMensagens do candidato (WhatsApp):');
      waMsgs.forEach(t => obsLines.push(`"${t}"`));
    }
  }

  const observacoes = obsLines.length > 0 ? obsLines.join('\n') : null;

  // ── FULL TEXT ─────────────────────────────────────────────
  const ftParts = [];
  ftParts.push('RESUMO PROFISSIONAL', resumo);
  if (experiencia) ftParts.push('\nEXPERIÊNCIA PROFISSIONAL', experiencia);
  if (competencias) ftParts.push('\nCOMPETÊNCIAS', competencias);
  if (formacao) ftParts.push('\nFORMAÇÃO ACADÊMICA', formacao);
  if (observacoes) ftParts.push('\nOBSERVAÇÕES', observacoes);

  return { resumo, experiencia, competencias, formacao, observacoes, full_text: ftParts.join('\n') };
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

    const sections = buildCvFromData(candidate, messages, vacancy);

    const vacancyName = vacancy?.Title ?? vacancy?.title ?? vacancy?.Name ?? vacancy?.name ?? candidate.vacancy_name ?? null;

    const cvRow = {
      candidate_id, vacancy_id: vid, vacancy_name: vacancyName,
      candidate_name: candidate.name ?? 'Não informado',
      cv_content: { resumo: sections.resumo, experiencia: sections.experiencia, competencias: sections.competencias, formacao: sections.formacao, observacoes: sections.observacoes },
      full_text: sections.full_text,
    };

    let savedCv = null;
    try { const ins = await insert('cvs', cvRow); savedCv = Array.isArray(ins) ? ins[0] : ins; } catch (err) { console.error('[CV] save failed:', err.message); }

    return res.status(200).json({
      status: 'ok',
      cv: {
        id: savedCv?.id ?? null, candidate_id, candidate_name: cvRow.candidate_name, vacancy_name: vacancyName,
        candidate_phone: candidate.phone ?? null,
        sections: cvRow.cv_content, full_text: sections.full_text,
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
