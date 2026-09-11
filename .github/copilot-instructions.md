# Coding Agent Guardrails — a8l-os

These instructions apply to every agent session working in this repository.

## Git workflow
- Never commit or push directly to `main`. Create a feature branch first
  (e.g. `agent/<short-description>`) before making any changes.
- Show a summary of the changes made and wait for explicit approval before
  pushing to any remote branch.
- Never use `git push --force` or `git reset --hard` without explicit
  confirmation first.

## Database (Supabase)
- Never run `supabase db push` or apply migrations against the linked
  project without first showing the migration diff and getting explicit
  confirmation.
- Prefer `supabase db diff` to preview changes before applying anything.

## Deployment (Netlify)
- Never run `netlify deploy --prod`. Use plain `netlify deploy` (draft /
  preview deploy) by default. Only promote to production when explicitly
  asked to.

## General
- Ask before running any command that deletes files, force-overwrites
  data, or is otherwise irreversible.
- When unsure whether a change is safe, explain the risk and ask rather
  than proceeding.
