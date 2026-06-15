---
name: RHF MVP Data Layer — mvp.html wiring
description: How mvp.html connects to real Supabase data via fetch() calls to existing API endpoints
type: project
---

## API Endpoints used (no new files created — Vercel 12-function limit respected)
- `GET /api/contacts?limit=500` → candidates count, recent list, CV tab candidate picker
- `GET /api/cv/query?limit=500` → total CVs generated count
- `GET /api/whatsapp/chats` → total conversations count
- `POST /api/cv/generate` → real AI CV generation (requires ANTHROPIC_API_KEY in Vercel)

## DOM IDs added to mvp.html
- `#stat-candidates` — dashboard candidate count card
- `#stat-cvs` — dashboard CVs generated count
- `#stat-chats` — dashboard conversations count
- `#dashboard-activity` — recent activity feed panel
- `#candidatos-grid` — candidate cards grid (fully replaced by JS)
- `#candidatos-stats` — candidate stage stats row (replaced by JS)
- `#candidatos-filters` — filter pills (replaced by JS)
- `#candidatos-header-count` — topbar tag
- `#curriculo-candidate-list` — CV tab candidate picker list (replaced by JS)
- `#curriculo-queue-waiting` — candidate count in queue panel
- `#curriculo-queue-sent` — CVs generated count in queue panel
- `#cv-field-nome`, `#cv-field-cargo`, `#cv-field-phone`, `#cv-field-email`, `#cv-field-stage` — Pandapé source panel fields

## Lazy-load pattern
`tabLoaded{}` guard: each tab's data loads exactly once (on first activation). Dashboard loads on init.

## Vagas tab
Keep hardcoded + add amber warning banner: "Integração Pandapé pendente". Real data needs OAuth2 credentials from client.

**Why:** Pandapé API requires client credentials not yet provided.
**How to apply:** When Pandapé credentials are configured, add a `/api/pandape/matches` fetch to this tab.

## CV generation flow
- `selectedCandidateId` global tracks which candidate is selected
- `generateCV()` POSTs to `/api/cv/generate` with `candidate_id`
- Error handling: shows red box if ANTHROPIC_API_KEY missing; shows connection error otherwise
- Success: `renderGeneratedCV(cv)` builds the preview from `cv.sections` (XML-parsed by backend)
