# AgentGate v0.2.0 — Red Team Plan

**Status:** Draft
**Goal:** Systematically attack AgentGate's core enforcement mechanisms before expanding features.

The value proposition of AgentGate is: "bad behavior is economically irrational." If any of the mechanisms below can be bypassed, that claim is false. This plan tests whether the bedrock cracks.

---

## How This Works

Each attack scenario describes:
- **What we try** — the attack, in plain English
- **What "broken" looks like** — the outcome if the system is vulnerable
- **What "passing" looks like** — the outcome if the system is sound
- **Priority** — P0 (core guarantee at risk), P1 (enforcement edge case), P2 (defense in depth)

Tests will be written in Vitest and added to a new file: `test/red-team.test.ts`

---

## Phase 0: Invariant Assertions (Build First)

Before writing any attack tests, we build a validator function that checks the "laws of physics" of AgentGate after every state-changing operation. Every attack test will call this validator after the attack attempt.

### Invariants (must always be true)

1. `bond.amount_cents >= 0` — a bond can never go negative
2. `bond.outstanding_exposure_cents >= 0` — outstanding exposure can never go negative
3. `bond.outstanding_exposure_cents <= bond.amount_cents` — you can't owe more than you posted
4. Every action with status `open` must reference a bond that exists and has status `active` or `occupied`
5. Every action with status `resolved_success` or `resolved_failed` must have had its exposure released (bond's outstanding_exposure_cents decreased by the right amount)
6. Every action with status `resolved_malicious` must have its bond's amount_cents reduced by the slashed amount
7. Sum of all open actions' exposure_cents for a bond must equal that bond's outstanding_exposure_cents
8. No two actions for the same identity can share the same nonce

### Implementation

Write a `validateInvariants(db)` function that queries the database and throws if any invariant is violated. Call it at the end of every red team test.

---

## Phase 1: Bond Capacity & Exposure Math (P0)

This is the heart of AgentGate. If exposure accounting is wrong, agents can execute without real collateral.

### Attack 1.1 — Over-commit exposure beyond bond capacity

**What we try:** Lock a bond for 1000 cents. Execute multiple actions whose combined effective exposure (with the 1.2x multiplier) exceeds 1000 cents.

**Broken:** All actions are accepted. Agent has more exposure than collateral.

**Passing:** The system rejects the action that would exceed capacity with INSUFFICIENT_BOND_CAPACITY.

**Priority:** P0

### Attack 1.2 — Rapid resolve-then-execute cycle

**What we try:** Lock a bond for 1000 cents. Execute an action for 800 cents exposure. Immediately resolve it as success. Immediately execute another action for 800 cents. Repeat rapidly. Check that exposure accounting stays correct after each cycle.

**Broken:** Exposure doesn't fully release on resolve, so capacity slowly leaks. Or exposure releases twice, allowing over-commitment.

**Passing:** Each resolve cleanly frees the exact exposure amount. Invariants hold after every cycle.

**Priority:** P0

### Attack 1.3 — Resolve an already-resolved action

**What we try:** Execute an action, resolve it as success, then try to resolve it again (as malicious this time).

**Broken:** The second resolve succeeds. Bond gets slashed even though the action was already settled.

**Passing:** The second resolve is rejected. The action's outcome is final.

**Priority:** P0

### Attack 1.4 — Execute against a burned/released bond

**What we try:** Lock a bond. Execute an action. Resolve as malicious (bond gets burned). Try to execute another action against the same bond.

**Broken:** The new action is accepted against a burned bond.

**Passing:** The system rejects the action because the bond is no longer active/occupied.

**Priority:** P0

### Attack 1.5 — Negative or zero exposure declaration

**What we try:** Execute an action with `exposure_cents: 0` or `exposure_cents: -100`.

**Broken:** The system accepts it, and the agent gets a free ride (action with no economic stake).

**Passing:** The system either rejects non-positive exposure or correctly handles 0 exposure as a no-op (this is a design decision — document which behavior is correct).

**Priority:** P1

### Attack 1.6 — Extremely large exposure value

**What we try:** Execute an action with `exposure_cents: Number.MAX_SAFE_INTEGER` or a very large number.

**Broken:** Integer overflow, NaN, or the 1.2x multiplier wraps around to a small number.

**Passing:** The system either rejects the oversized value or correctly calculates that it exceeds bond capacity.

**Priority:** P1

---

## Phase 2: Sweeper Edge Cases (P0)

The sweeper auto-slashes expired bonds. If it misfires, innocent agents lose money or guilty agents escape.

### Attack 2.1 — Sweeper runs during active resolve

**What we try:** Create a bond with a very short TTL. Execute an action. Start resolving it as success at the exact moment the sweeper would fire. Check that the action isn't both resolved-success AND slashed.

**Broken:** The action gets double-settled — resolved as success by the API and as malicious by the sweeper. Bond amount goes haywire.

**Passing:** One settlement wins. Either the resolve completes first (success) or the sweeper wins (malicious), but not both.

**Priority:** P0

### Attack 2.2 — Sweeper double-slash prevention

**What we try:** Create multiple expired actions on the same bond. Run the sweeper twice in a row.

**Broken:** The second sweep slashes the same actions again, reducing the bond below zero.

**Passing:** The second sweep finds no open expired actions and does nothing. Bond amount stays correct.

**Priority:** P0

### Attack 2.3 — Expiry during execution

**What we try:** Lock a bond with a 1-second TTL. Wait 2 seconds. Try to execute an action against the now-expired bond.

**Broken:** The action is accepted against an expired bond.

**Passing:** The system rejects the action because the bond has expired.

**Priority:** P1

---

## Phase 3: Replay Attack Deep Audit (P0)

Replay protection prevents an attacker from re-submitting a signed request to execute actions without new authorization.

### Attack 3.1 — Exact duplicate request

**What we try:** Send a valid signed request. Send the exact same request again (same nonce, same signature, same timestamp).

**Broken:** The second request succeeds.

**Passing:** The second request is rejected with 409 DUPLICATE_NONCE.

**Priority:** P0

### Attack 3.2 — Replay just inside the 60-second timestamp window

**What we try:** Send a valid request with a timestamp 55 seconds ago. Then replay it with the same nonce 4 seconds later (timestamp is now 59 seconds old — still within window).

**Broken:** The replay succeeds because the timestamp is still valid.

**Passing:** The replay is rejected because the nonce was already consumed, regardless of timestamp validity.

**Priority:** P0

### Attack 3.3 — Replay after nonce TTL cleanup

**What we try:** Send a valid request. Wait for the nonce cleanup to run (nonces older than 5 minutes are purged). Send the same nonce again with a fresh timestamp.

**Broken:** The nonce was cleaned up, so the duplicate check passes, and the replayed request succeeds.

**Passing:** Even though the nonce was cleaned up, the fresh timestamp means this is effectively a new valid request — but the original action was already settled, so there's no double-execution. (This is a design analysis — document whether this is actually exploitable or benign.)

**Priority:** P1 (this is more of an analysis than a test — we need to understand the interaction between nonce TTL and the timestamp window)

**Result: Safe by design.** The 60-second timestamp window closes long before the 5-minute nonce TTL cleanup runs. After nonce cleanup, any replay attempt would fail the timestamp check. The two defenses overlap — the nonce covers the first 60 seconds, the timestamp covers everything after. No test needed.

### Attack 3.4 — Parallel duplicate nonce submission

**What we try:** Send two requests with the same nonce at the exact same time (concurrent).

**Broken:** Both requests succeed because the nonce check has a race window.

**Passing:** Exactly one request succeeds and the other gets 409.

**Priority:** P0

---

## Phase 4: SQLite Concurrency (P1)

AgentGate uses better-sqlite3, which is synchronous. But under rapid parallel HTTP requests, we need to verify that the exposure math doesn't break.

### Attack 4.1 — 50 parallel execute requests

**What we try:** Lock a bond for 10,000 cents. Fire 50 simultaneous execute requests, each for 200 cents exposure (effective: 240 cents each). Only 41 should fit (41 × 240 = 9,840 ≤ 10,000). The 42nd should fail.

**Broken:** All 50 succeed, meaning total exposure exceeds bond amount.

**Passing:** Exactly 41 (or fewer) succeed. The rest get INSUFFICIENT_BOND_CAPACITY. Invariants hold.

**Priority:** P1

### Attack 4.2 — Parallel resolve and execute on same bond

**What we try:** Lock a bond. Execute action A. In parallel: resolve action A (freeing capacity) and execute action B (consuming capacity). Verify the final state is consistent.

**Broken:** Both succeed but exposure accounting is wrong (e.g., action B's exposure wasn't properly added, or action A's wasn't properly released).

**Passing:** Final bond state has correct outstanding_exposure_cents. Invariants hold.

**Priority:** P1

---

## Phase 5: Outbound HTTP Attack Simulation (P2)

These test the allowlist and safety rails for outbound HTTP calls. Lower priority because outbound calls aren't the core economic mechanism, but important for defense in depth.

### Attack 5.1 — Localhost bypass via IPv6

**What we try:** Execute a bonded action with an outbound call to `http://[::1]:3000/` or `http://0:0:0:0:0:0:0:1:3000/` (IPv6 localhost).

**Broken:** The call goes through, bypassing the allowlist.

**Passing:** The allowlist blocks it.

**Priority:** P2

### Attack 5.2 — Localhost bypass via encoded variants

**What we try:** Execute a bonded action with outbound calls to `http://0x7f000001/`, `http://2130706433/` (decimal IP for 127.0.0.1), `http://127.0.0.1.nip.io/`.

**Broken:** Any of these bypass the allowlist.

**Passing:** All blocked.

**Priority:** P2

### Attack 5.3 — Non-HTTP schemes

**What we try:** Execute a bonded action with outbound calls using `file:///etc/passwd`, `ftp://evil.com/`, `gopher://evil.com/`.

**Broken:** The system attempts to fetch non-HTTP resources.

**Passing:** Only `http://` and `https://` schemes are allowed.

**Priority:** P2

### Attack 5.4 — Redirect to localhost

**What we try:** Execute a bonded action with an outbound call to an external URL that 302-redirects to `http://127.0.0.1:3000/`.

**Broken:** The HTTP client follows the redirect to localhost.

**Passing:** Redirects are either disabled or the redirect target is checked against the allowlist.

**Priority:** P2

### Attack 5.5 — Slow response / large response

**What we try:** Execute a bonded action with an outbound call to a server that sends data very slowly (1 byte per second) or sends a 500MB response.

**Broken:** The server hangs indefinitely or runs out of memory.

**Passing:** Timeout and max response size limits kill the connection.

**Priority:** P2

---

## Execution Plan

### Step 1: Build invariant validator
Write `validateInvariants(db)` and a helper to call it. This is the foundation.

### Step 2: Phase 1 tests (bond/exposure)
These protect the core economic guarantee. 6 tests.

### Step 3: Phase 2 tests (sweeper)
These protect the enforcement mechanism. 3 tests.

### Step 4: Phase 3 tests (replay)
These protect identity integrity. 4 tests.

### Step 5: Phase 4 tests (concurrency)
These protect data integrity under load. 2 tests.

### Step 6: Phase 5 tests (outbound HTTP)
Defense in depth. 5 tests.

### Step 7: Tag v0.2.0
All tests green. Update AGENTGATE_PROJECT_CONTEXT.md, README.md, threat model.

---

## Total: ~20 attack scenarios across 5 phases

Each phase builds on the invariant validator from Phase 0. We go one phase at a time, one test at a time.
