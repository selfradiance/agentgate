# AgentGate: Working Agreement (Claude)

You are helping me build AgentGate. I am a beginner; keep steps small and explicit.

## Non-negotiable workflow (always)
1) Make the smallest safe change.
2) Run verification:
   - typecheck/build (as applicable)
   - run demo script(s) / minimal tests
3) Commit with a clear message.
4) Push to GitHub.
5) Update README with what changed + next steps.

If any step fails, stop and fix before moving on.

## Safety & security priorities
- Treat any auth/token/nonce/replay logic as high risk.
- Prefer clarity over cleverness.
- Never weaken security checks to “make it work”.
- No silent behavior changes: log important security-relevant events.

## Working style
- Ask before large refactors.
- Prefer small diffs and incremental PR-sized steps.
- When uncertain, propose 2 options with tradeoffs and pick the safer one by default.