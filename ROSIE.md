What I need from you
Paste both keys here in this format and I'll drop them into .env.local:


COMPOSIO_API_KEY=...
ANTHROPIC_API_KEY=sk-ant-...
Signup if you don't have them yet:

Service	URL	What to grab
Composio	https://platform.composio.dev → Settings → API Keys	The generated key
Anthropic	https://console.anthropic.com → Settings → API Keys → Create Key	New key + confirm Claude Sonnet 4.6 (claude-sonnet-4-6) is enabled and you have credit
Once you paste them I'll:

Write .env.local (auto-gitignored — Next.js's .gitignore already has .env*)
Run npx tsx scripts/spike-composio.ts
Confirm pass criteria (we'll see → tool_call SEARCH_FURNITURE appear in the log before ← tool_result and before the final assistant message — that ordering proves the per-tool-call seam works, which is what enables SSE per-tool-call events on the frontend)
Then move to PRD §9.7 step 6: wrap it in a Next.js /api/chat route with real SSE and verify in a browser
