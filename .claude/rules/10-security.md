# Security rules (AgentGate)

## Auth / transport / replay protection
- Any remotely reachable endpoint must be protected against replay.
- Nonce use must be single-use (or time-bounded with strict semantics) and logged.
- Avoid “temporary insecure” changes.

## Secrets
- Never hardcode secrets.
- Never commit .env, tokens, keys, or identity JSON that contains sensitive info.
- Prefer example files + documented env vars.

## Logging
- Log security-relevant events (nonce consumed/rejected, auth failures).
- Logs must not leak secrets.