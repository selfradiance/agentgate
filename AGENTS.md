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
- Keep diffs under ~100 lines per change. If a change exceeds 300 lines, stop and break it into smaller pieces before proceeding.
- When uncertain, propose 2 options with tradeoffs and default to safer.
- Do not claim something is verified unless you list what you ran/checked.

## Anti-Rationalization

| Excuse | Rebuttal |
|--------|----------|
| "I'll add tests later" | Tests are not optional. Write them now. |
| "It's just a prototype" | Prototypes become production. Build it right. |
| "This change is too small to break anything" | Small changes cause subtle bugs. Run the tests. |
| "I already know this works" | You don't. Verify it. |
| "Cleaning up this adjacent code will save time" | Stay in scope. File it for later. |
| "The user probably meant X" | Don't assume. Ask. |
| "Skipping the audit since it's straightforward" | Straightforward changes still need verification. |
| "I'll commit everything at the end" | Commit after each verified change. No batching. |

### Slicing Strategies

- **Vertical slice**: implement one complete feature top to bottom (route, logic, test) before starting another
- **Risk-first slice**: tackle the riskiest or most uncertain piece first to surface problems early
- **Contract-first slice**: define the API contract or interface first, then implement behind it

## One-step-at-a-time rule (critical)
- Never give more than ONE step at a time.
- After giving a single step, STOP and wait for the user to say "done".
- Do not provide future steps, and do not include multi-step lists.

## Process Template v3 Requirements

The project context file must include three sections:

### Assumptions & Unknowns
- What we know for sure
- What we're assuming without proof
- What we don't know yet
- What would break this design if it turned out to be wrong

### Confidence Tags
Tag milestones and claims with one of: Idea (sounds right, haven't tested), Prototype (built it, works in demo path), Tested (tests exist and pass), Production (deployed, hardened, verified from outside), Security-verified (red-teamed and survived).

### Decision Log
For each significant decision: what was decided, why, what was rejected, what would cause reconsideration.

## Before Starting Any New Feature or Phase (Part 1C)

Before writing any code, define: what we're building, what problem it solves, what the smallest version is, and what's out of scope. No code until this is written down.

## Files That Must Never Be Committed

The following file types are private and must be listed in .gitignore from the first commit:

- `*_PROJECT_CONTEXT.md` (e.g., AGENTGATE_PROJECT_CONTEXT.md) — private session context
- Build logs (e.g., marketgate_build_log.md) — internal development notes
- `AGENT_OPERATING_CONTRACT.md` — private working agreement
- `process-template*.md` — personal development playbook
- `agent-identity*.json` — contain private keys

If any of these files exist but are not in .gitignore, add them immediately before making any other changes. If any have already been committed, remove them from tracking with `git rm --cached` before proceeding.
