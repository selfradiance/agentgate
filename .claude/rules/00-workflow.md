# Workflow rules (AgentGate)

You are assisting in this repo. The user is a beginner. Use baby steps.

## Always follow this order for any meaningful change
1) Make the smallest safe change (prefer tiny diffs).
2) Verify:
   - run typecheck/build (whatever this repo uses)
   - run demo script(s) / minimal tests
   - sanity-check outputs/logs
3) Commit with a clear message.
4) Push to GitHub.
5) Update README:
   - what changed
   - how to verify
   - next steps

## Working style
- One step at a time. Do not batch multiple steps unless asked.
- Ask before refactors or broad changes.
- If verification fails, stop and fix before continuing.
- If you’re uncertain, propose 2 options with tradeoffs; default to safer.

## One-step-at-a-time rule (critical)
- Never give more than ONE step at a time.
- After giving a single step, STOP and wait for the user to say "done".
- Do not provide future steps, and do not include multi-step lists.