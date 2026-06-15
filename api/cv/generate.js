/**
 * CV Generation API — Vercel Serverless Function
 *
 * POST /api/cv/generate
 *
 * Body: { candidate_id: "uuid", vacancy_id?: 2656804 }
 *
 * Flow:
 *   1. Fetch candidate from Supabase `candidates`
 *   2. Fetch last 20 messages from `rhf_messages` (conversation context)
 *   3. Optionally fetch vacancy from Pandapé (graceful skip on failure)
 *   4. Build structured prompt and call Claude API
 *   5. Parse structured CV sections from the response
 *   6. Save to `generated_cvs` table
 *   7. Return the generated CV
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY — Anthropic Claude API key
 *   SUPABASE_URL, SUPABASE_KEY — Supabase REST
 *   PANDAPE_CLIENT_ID, PANDAPE_CLIENT_SECRET — optional (graceful skip)
 */

import { select, insert } from '../../lib/supabase.js';
import { getVacancy } from '../../lib/pandape.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2000;

// ---------------------------------------------------------------------------
// Anthropic API call
// ---------------------------------------------------------------------------

/**
 * Call Claude via direct HTTP — no SDK dependency.
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<{ text: string, promptTokens: number, completionTokens: number }>}
 */
async function callClaude(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var is required');

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error (${res.status}): ${body}`);
  }

  const data = await res.json();
  const text = data?.content?.[0]?.text ?? '';
  const promptTokens = data?.usage?.input_tokens ?? 0;
  const completionTokens = data?.usage?.output_tokens ?? 0;

  return { text, promptTokens, completionTokens };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Você é um especialista em recrutamento e seleção brasileiro, com 15 anos de experiência no mercado de RH. Sua tarefa é gerar currículos profissionais em Português (PT-BR) a partir de dados brutos de candidatos e histórico de conversas WhatsApp.

Diretrizes:
- Escreva em Português brasileiro formal, mas natural — adequado para o mercado de recrutamento brasileiro
- Quando os dados forem incompletos, redija o que for possível com base no que está disponível
- Extraia informações relevantes do histórico de conversa WhatsApp (experiências, habilidades, disponibilidade mencionadas casualmente)
- Se houver contexto de vaga, adapte o Resumo Profissional para destacar experiências relevantes para a posição
- Seja conciso e objetivo — recrutadores leem currículos em 6 segundos
- Use bullet points nas seções de experiência e competências
- Nunca invente informações que não estejam nos dados fornecidos — se não há dado, indique "Não informado"

Formato de saída OBRIGATÓRIO (use exatamente estas tags XML para facilitar o parsing):
<resumo>
[2-4 frases sobre o perfil profissional do candidato]
</resumo>

<experiencia>
[Experiências profissionais formatadas como bullet points. Inclua empresa, cargo, período se disponível]
</experiencia>

<competencias>
[Lista de competências técnicas e comportamentais identificadas]
</competencias>

<formacao>
[Formação acadêmica. Se não informada, escreva "Não informada"]
</formacao>

<observacoes>
[Observações relevantes para o recrutador: disponibilidade, pretensão salarial, localização, observações da conversa WhatsApp]
</observacoes>`;

/**
 * Build the user prompt from candidate data + conversation + vacancy context.
 * @param {object} candidate - Row from `candidates` table
 * @param {Array} messages - Last 20 rows from `rhf_messages`
 * @param {object|null} vacancy - Vacancy from Pandapé (or null)
 * @returns {string}
 */
function buildUserPrompt(candidate, messages, vacancy) {
  const lines = [];

  lines.push('=== DADOS DO CANDIDATO ===');
  lines.push(`Nome: ${candidate.name ?? 'Não informado'}`);
  lines.push(`Email: ${candidate.email ?? 'Não informado'}`);
  lines.push(`Telefone: ${candidate.phone ?? 'Não informado'}`);
  lines.push(`Vaga de origem: ${candidate.vacancy_name ?? 'Não informada'}`);
  lines.push(`Estágio atual: ${candidate.stage ?? 'Não informado'}`);

  // Pandapé raw_data may contain skills, experience, education fields
  if (candidate.raw_data && typeof candidate.raw_data === 'object') {
    const raw = candidate.raw_data;

    // Common Pandapé field names (PascalCase and camelCase variants)
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

    // Include the full raw_data as JSON for any other useful fields
    lines.push(`\nDados completos do Pandapé (JSON):\n${JSON.stringify(raw, null, 2)}`);
  }

  // Conversation history from WhatsApp
  if (messages && messages.length > 0) {
    lines.push('\n=== HISTÓRICO DE CONVERSA WHATSAPP (últimas mensagens) ===');
    lines.push('(Extraia informações profissionais relevantes mencionadas pelo candidato)\n');

    for (const msg of messages) {
      const direction = msg.direction === 'inbound' ? 'Candidato' : 'RHF';
      const date = msg.created_at
        ? new Date(msg.created_at).toLocaleDateString('pt-BR')
        : '';
      const content = msg.content ?? msg.text ?? '';
      if (content) {
        lines.push(`[${date}] ${direction}: ${content}`);
      }
    }
  } else {
    lines.push('\n=== HISTÓRICO DE CONVERSA ===');
    lines.push('Nenhuma conversa registrada no sistema.');
  }

  // Vacancy context
  if (vacancy) {
    lines.push('\n=== CONTEXTO DA VAGA (adapte o currículo para esta posição) ===');
    lines.push(`Título: ${vacancy.Title ?? vacancy.title ?? vacancy.Name ?? vacancy.name ?? 'Não informado'}`);
    const description = vacancy.Description ?? vacancy.description ?? null;
    const requirements = vacancy.Requirements ?? vacancy.requirements ?? null;
    const city = vacancy.City ?? vacancy.city ?? null;
    if (description) lines.push(`Descrição: ${description}`);
    if (requirements) lines.push(`Requisitos: ${JSON.stringify(requirements)}`);
    if (city) lines.push(`Localização: ${city}`);
  }

  lines.push('\n=== INSTRUÇÃO FINAL ===');
  lines.push('Gere o currículo completo seguindo rigorosamente o formato XML especificado no seu system prompt.');
  lines.push('Use apenas as informações fornecidas acima. Seja profissional e objetivo.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CV parsing
// ---------------------------------------------------------------------------

/**
 * Extract sections from Claude's XML-tagged response.
 * Falls back to empty string if a tag is missing.
 * @param {string} text - Raw Claude response
 * @returns {{ resumo, experiencia, competencias, formacao, observacoes, full_text }}
 */
function parseCvSections(text) {
  const extract = (tag) => {
    const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return match ? match[1].trim() : '';
  };

  const resumo = extract('resumo');
  const experiencia = extract('experiencia');
  const competencias = extract('competencias');
  const formacao = extract('formacao');
  const observacoes = extract('observacoes');

  // Build a clean full-text version with section headers
  const parts = [];
  if (resumo) {
    parts.push('RESUMO PROFISSIONAL');
    parts.push(resumo);
  }
  if (experiencia) {
    parts.push('\nEXPERIÊNCIA PROFISSIONAL');
    parts.push(experiencia);
  }
  if (competencias) {
    parts.push('\nCOMPETÊNCIAS');
    parts.push(competencias);
  }
  if (formacao) {
    parts.push('\nFORMAÇÃO ACADÊMICA');
    parts.push(formacao);
  }
  if (observacoes) {
    parts.push('\nOBSERVAÇÕES');
    parts.push(observacoes);
  }

  const full_text = parts.join('\n');

  return { resumo, experiencia, competencias, formacao, observacoes, full_text };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { candidate_id, vacancy_id } = req.body ?? {};

    if (!candidate_id) {
      return res.status(400).json({ status: 'error', message: 'candidate_id is required' });
    }

    // 1. Fetch candidate from Supabase
    console.log(`[CV Generate] Fetching candidate ${candidate_id}...`);
    const candidates = await select('candidates', `id=eq.${candidate_id}&limit=1`);

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return res.status(404).json({ status: 'error', message: `Candidate ${candidate_id} not found` });
    }

    const candidate = candidates[0];
    console.log(`[CV Generate] Candidate found: ${candidate.name ?? 'unnamed'}`);

    // 2. Fetch conversation history (last 20 messages ordered newest-first, then reverse)
    let messages = [];
    if (candidate.phone) {
      try {
        const rawMessages = await select(
          'rhf_messages',
          `phone=eq.${candidate.phone}&order=created_at.desc&limit=20`
        );
        if (Array.isArray(rawMessages)) {
          // Reverse so conversation reads chronologically
          messages = rawMessages.reverse();
        }
      } catch (err) {
        console.warn('[CV Generate] Could not fetch messages:', err.message);
      }
    }

    console.log(`[CV Generate] Loaded ${messages.length} messages from conversation history`);

    // 3. Optionally fetch vacancy from Pandapé (graceful skip)
    let vacancy = null;
    const vacancyId = vacancy_id ?? candidate.vacancy_id ?? null;
    if (vacancyId) {
      try {
        console.log(`[CV Generate] Fetching vacancy ${vacancyId} from Pandapé...`);
        vacancy = await getVacancy(vacancyId);
        console.log(`[CV Generate] Vacancy: ${vacancy?.Title ?? vacancy?.name ?? 'fetched'}`);
      } catch (err) {
        console.warn(`[CV Generate] Pandapé vacancy fetch skipped: ${err.message}`);
        // non-fatal — proceed without vacancy context
      }
    }

    // 4. Build prompt and call Claude
    const userPrompt = buildUserPrompt(candidate, messages, vacancy);
    console.log(`[CV Generate] Calling Claude (${MODEL})...`);

    const { text: rawResponse, promptTokens, completionTokens } = await callClaude(
      SYSTEM_PROMPT,
      userPrompt
    );

    console.log(`[CV Generate] Claude responded. Tokens: ${promptTokens} in / ${completionTokens} out`);

    // 5. Parse structured sections
    const sections = parseCvSections(rawResponse);

    const vacancyName =
      vacancy?.Title ?? vacancy?.title ?? vacancy?.Name ?? vacancy?.name ??
      candidate.vacancy_name ?? null;

    // 6. Save to generated_cvs table
    const cvRow = {
      candidate_id,
      vacancy_id: vacancyId ?? null,
      vacancy_name: vacancyName,
      candidate_name: candidate.name ?? 'Não informado',
      cv_content: {
        resumo: sections.resumo,
        experiencia: sections.experiencia,
        competencias: sections.competencias,
        formacao: sections.formacao,
        observacoes: sections.observacoes,
      },
      full_text: sections.full_text,
      model_used: MODEL,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    };

    let savedCv = null;
    try {
      const inserted = await insert('generated_cvs', cvRow);
      savedCv = Array.isArray(inserted) ? inserted[0] : inserted;
      console.log(`[CV Generate] Saved to generated_cvs. id: ${savedCv?.id ?? 'unknown'}`);
    } catch (err) {
      // Table may not exist yet — log and continue so the API still returns the CV
      console.error('[CV Generate] Could not save to generated_cvs (table may not exist):', err.message);
    }

    return res.status(200).json({
      status: 'ok',
      cv: {
        id: savedCv?.id ?? null,
        candidate_id,
        candidate_name: cvRow.candidate_name,
        vacancy_name: vacancyName,
        sections: cvRow.cv_content,
        full_text: sections.full_text,
        model_used: MODEL,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        generated_at: savedCv?.created_at ?? new Date().toISOString(),
      },
    });

  } catch (error) {
    console.error('[CV Generate] Unhandled error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
