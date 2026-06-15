---
name: Anthropic API — direct HTTP pattern
description: How to call Claude API via fetch with no SDK in this project (headers, model, error handling)
type: reference
---

Endpoint: `https://api.anthropic.com/v1/messages`

Required headers:
- `x-api-key: process.env.ANTHROPIC_API_KEY`
- `anthropic-version: 2023-06-01`
- `Content-Type: application/json`

Pinned model for CV generation: `claude-sonnet-4-20250514`

Response path for text: `data.content[0].text`
Token usage: `data.usage.input_tokens` / `data.usage.output_tokens`

Error handling: check `res.ok`, then `await res.text()` for the error body (not `.json()` — Anthropic errors are plain text on some status codes).

Env var: `ANTHROPIC_API_KEY` — add to `.env.example` and provision in Vercel via devops-agent.
