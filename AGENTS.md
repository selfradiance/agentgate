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
