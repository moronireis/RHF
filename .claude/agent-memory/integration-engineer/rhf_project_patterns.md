---
name: RHF Talentos — project integration patterns
description: Stable conventions for all API files in rhf-proposta: module format, HTTP client, routing, table names
type: project
---

All API files use ESM (`export default async function handler(req, res)`). No CommonJS.

No npm dependencies beyond what Vercel provides — native `fetch` only everywhere.

Shared libs live in `api/lib/`:
- `supabase.js` — `select(table, queryString)`, `insert(table, data)`, `upsert(table, data, onConflict)`
- `pandape.js` — `getToken()`, `getMatch(id)`, `getVacancy(id)` — OAuth2 client_credentials, module-level token cache
- `chatguru.js` — `sendMessage(phone, text)`, `createContact({chatNumber, name})`

Supabase query strings are raw PostgREST format: `"column=eq.value&order=col.desc&limit=N"`.

Vercel routing: `vercel.json` has a catch-all `/api/:path*` rewrite — new files under `api/` are auto-routed. No need to add explicit entries for standard paths.

Key DB tables (as of Phase 2):
- `candidates` — id (uuid), name, email, phone, match_id, vacancy_id, vacancy_name, stage, raw_data (jsonb)
- `rhf_messages` — phone, direction (inbound/outbound), content, message_type, created_at
- `sync_log` — source, action, entity_type, entity_id, status, error_message, payload (jsonb)
- `generated_cvs` — id (uuid), candidate_id (uuid FK), vacancy_id (bigint), vacancy_name, candidate_name, cv_content (jsonb), full_text (text), model_used, prompt_tokens (int), completion_tokens (int), created_at — **table must be created in Supabase before CV inserts work**

CORS pattern used on every handler:
```js
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); // or GET
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
if (req.method === 'OPTIONS') return res.status(200).end();
```

Pandapé field names are PascalCase (CandidateName, CandidateEmail, etc.). Always check both PascalCase and camelCase variants when reading raw_data.
