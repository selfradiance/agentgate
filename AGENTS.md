# AGENTS.md

## Commands

- `npm install` installs project dependencies
- `npm run dev` starts the local Fastify server with reload
- `npm run build` compiles TypeScript
- `npm run test` runs the automated test suite
- `npm run lint` runs the TypeScript typecheck used as linting

## Conventions

- Keep the implementation minimal and local-first
- Use Fastify route handlers with zod parsing for request validation
- Use SQLite through `better-sqlite3`; prefer `:memory:` in tests
- Keep bond settlement logic in `src/service.ts`
- Add tests for state transitions through Fastify injection rather than only unit-level helpers

# AgentGate: Instructions for Any AI Assistant

This repository is developed with help from AI. These rules apply regardless of model or tool.

## User skill level
- The user is a beginner.
- Use baby steps.
- Provide clear, small, actionable steps.

## Non-negotiable workflow (always)
For any meaningful change:
1) Make the smallest safe change.
2) Verify:
   - run typecheck/build (as applicable)
   - run demo script(s) / minimal tests
3) Commit with a clear message.
4) Push to GitHub immediately after committing. Do not leave commits unpushed unless explicitly told to hold off.
5) Update README with:
   - what changed
   - how to verify
   - next steps

If verification fails, stop and fix before proceeding.

## Security priorities
- Treat auth/token/nonce/replay/transport logic as high risk.
- Prefer safety and clarity over speed.
- Never weaken security checks to “make it work”.
- Log security-relevant events (without leaking secrets).

## Secrets and sensitive data
- Never hardcode secrets.
- Never commit tokens/keys/.env.
- Use example files and documented env vars instead.

## Working style
- Ask before large refactors.
- Prefer small diffs and incremental steps.
- When uncertain, propose 2 options with tradeoffs and default to safer.
- Do not claim something is verified unless you list what you ran/checked.

## One-step-at-a-time rule (critical)
- Never give more than ONE step at a time.
- After giving a single step, STOP and wait for the user to say "done".
- Do not provide future steps, and do not include multi-step lists.
