# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in AgentGate, please **do not open a public issue**.

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](../../security) of this repository
2. Click **"Report a vulnerability"**
3. Include:
   - A clear description of the vulnerability
   - Steps to reproduce
   - Potential impact (what an attacker could do)

This keeps the details private until a fix is in place.

## What to Expect

This is a solo-maintained open-source project. Here's how the process works:

- **Acknowledgment** within 72 hours of your report
- **Fix or detailed response** within 30 days
- You'll be credited in the fix commit unless you prefer otherwise

There is no bug bounty program.

## Scope

**In scope:**

- AgentGate core engine (everything in `src/`)
- REST API endpoints (`/v1/*`)
- MCP server and endpoints (`/mcp`)
- Admin dashboard
- Deployment and configuration (`.env`, Caddy, pm2, firewall rules)

**Out of scope:**

- Third-party dependencies (report those to the upstream maintainer)
- Demo and example scripts
- Social engineering

## Disclosure Policy

AgentGate follows coordinated disclosure. If you report a vulnerability, please give reasonable time (at least 30 days) to fix it before disclosing publicly. If you're unsure about timing, just ask — we'll work it out.

## Supported Versions

Only the latest release on the `main` branch is supported. If you're running an older version, please update before reporting.
