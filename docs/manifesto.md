# I Can't Code. I Built a Security-Critical System Anyway.

I'm 60 years old. I have zero coding experience. Not "I took a class once" zero — I mean I have never written a line of code in my life.

Over the past few weeks, I built AgentGate: a collateralized execution engine for AI agents. It has Ed25519 cryptographic signing. Replay protection with nonce stores. An auto-slash sweeper that punishes expired bonds. A prediction market that settles positions economically. Five phases of red-team adversarial testing. A live deployment with TLS, firewall rules, and process management. Fifty-six tests, all passing. CI on GitHub Actions.

I didn't write any of it. And I architected all of it.

---

## What AgentGate Actually Is

Before I tell you how I built it, let me tell you what it does — because the problem it solves is real.

As AI agents get better, they're going to start doing things in the world: placing trades, making API calls, sending money, negotiating contracts. The systems they interact with were designed for humans, and humans are slow. Humans have friction. That friction was a feature — it kept bad behavior expensive.

AI agents remove that friction. An agent can send a thousand bids in the time it takes a person to type one. Rate limits can cap volume, but they don't make bad actions *costly*. Auth tokens can verify identity, but they don't require skin in the game.

AgentGate fixes this. Before an agent can execute a high-impact action, it has to post a bond — real economic collateral. If the action succeeds, the bond is released. If the agent behaves maliciously, the bond is slashed. It makes bad behavior economically irrational.

That's the thesis. Now here's the part that surprised me.

---

## I'm Not a Coder. I'm an Investor.

I've spent my career analyzing systems. Figuring out where the risk is, where the leverage is, where the misalignment between incentives and outcomes creates opportunity. That's what investors do.

When I looked at the AI agent landscape, I saw a gap: there was no economic accountability layer. Agents could act, but they couldn't be held financially responsible for acting badly. That's a structural problem, and I understood it the way I understand any structural problem — not through code, but through incentives.

The problem was, I couldn't build anything. I could see the architecture in my head — the bond model, the exposure lifecycle, the settlement logic — but I had no way to turn that into software.

Then I started using AI coding agents.

---

## How It Actually Worked

I'm going to be honest about what this looked like, because I think people have a distorted picture of what "building with AI" means.

It was not: "Hey Claude, build me a security system." It was not a weekend project. It was not easy.

It was twelve sessions of patient, methodical work. One baby step at a time. Every step, I'd describe what I wanted in plain English. The AI would make the changes. I'd verify them. If something broke, we'd fix it before moving on. We never skipped ahead. We never took two steps at once.

I started with the simplest possible thing — a single endpoint that accepted a request and returned a response. Then I added identity. Then bonds. Then actions. Then resolution logic. Then the exposure model. Then replay protection. Then the sweeper. Then the dashboard. Then deployment. Then authentication. Then TLS. Then adversarial testing.

Each layer was small enough that I could understand what changed and verify it worked. That constraint was everything. It meant I was never confused about what the system was doing. It meant bugs got caught immediately, not three features later when they'd be impossible to trace.

The AI wrote the code. I decided what to build, in what order, and when something was good enough to move on.

---

## The Multi-AI Thing

Here's something that worked better than I expected: I used multiple AI models as auditors.

My primary coding tool was Claude Code — it made the actual changes to files, ran tests, committed and pushed code. But after every major phase, I'd take a snapshot of the entire project and hand it to a different AI (ChatGPT, in my case) and say: "Audit this. What's wrong? What's missing? What should I do next?"

Then I'd take that audit back to my primary tool and say: "Here's what the other AI found. Do you agree? What should we actually do?"

This created a kind of adversarial collaboration. Neither AI was checking its own work. Neither was invested in defending its earlier decisions. One would build, the other would critique, and I'd make the final call on what to prioritize.

I'm not going to pretend this was some genius innovation. It was common sense. If you're a beginner building something security-sensitive, you want more than one set of eyes on it. The fact that those eyes belong to AI models instead of human engineers is just the reality of my situation.

But it worked. The ChatGPT audits caught real issues — exposed ports, missing auth on endpoints, the need for adversarial test phases that I wouldn't have thought of on my own.

---

## The Red Team Phase

This is the part I'm most proud of, and it's also the part that best illustrates what I mean by "I architected it but didn't code it."

After the core system was working and deployed, I directed a five-phase red team exercise. Twenty attack scenarios across five categories: bond math attacks, sweeper edge cases, replay attacks, SQLite concurrency exploits, and outbound HTTP abuse.

I didn't write the attack code. But I understood what each attack was trying to do, because the attacks map directly to the economic model I designed. Can you over-commit exposure beyond what a bond can cover? Can you double-resolve an action to get your bond back twice? Can you replay a signed request to execute the same action again? Can you redirect an outbound HTTP call to hit an internal service?

Three real bugs got found and fixed. One was a genuine SSRF vulnerability — if an attacker crafted a redirect, they could bypass the outbound HTTP allowlist and hit internal services. That's a serious security hole, and it was found because I insisted on testing for it.

I didn't know the term "SSRF" before this project. But I understood the concept: "what if the system follows a redirect to somewhere it shouldn't go?" That's not a coding question. That's a systems thinking question.

---

## What I Learned About AI-Assisted Building

There are a few things I now believe that I didn't believe before I started.

**The constraint is the product.** The reason AgentGate works isn't that AI is powerful. It's that I imposed brutal constraints on the process: one step at a time, verify before moving on, never skip ahead, always test, always audit. Without those constraints, I'd have had a mess of code that sort of worked and was riddled with bugs I couldn't find. The discipline came from me. The execution came from AI.

**Architecture is not code.** I can't write a for loop. But I can look at a bond model and tell you whether the exposure accounting is sound. I can tell you whether the settlement logic handles edge cases. I can tell you whether the nonce store properly prevents replay attacks. Those are design decisions, and they're separable from implementation. Most software discourse conflates the two. They shouldn't.

**Multiple models are better than one.** Not because any single model is bad, but because a single model checking its own work has the same blindness as a human checking their own work. An external audit — even from another AI — catches things that the builder missed. This is just good practice, whether you're working with humans or machines.

**Beginners have an advantage in one specific way.** Because I don't know how things are "supposed" to be done, I ask very basic questions: "What happens if this fails?" "What if someone tries to do this twice?" "What if the bond expires while an action is still running?" Those questions turned out to be more valuable than technical sophistication. They led directly to the sweeper, the nonce store, and the identity governance system.

---

## What AgentGate Is Now

The technical arc is complete. AgentGate is a working, tested, adversarially hardened prototype that demonstrates economic accountability for AI agents. It has:

- Cryptographic identity with Ed25519 signing
- A reusable bond model with exposure tracking
- Automatic slashing of expired bonds
- Replay protection via nonce stores
- Identity governance with auto-ban logic
- A prediction market that demonstrates multi-party economic settlement
- Outbound HTTP safety rails (allowlist, timeout, size limits, redirect protection)
- Five phases of red-team testing (20 attack scenarios, 3 bugs found and fixed)
- A live dashboard, TLS, CI, and 56 passing tests

It's open source under the MIT license. You can read the code, run it, fork it, extend it. The repo is at [github.com/selfradiance/agentgate](https://github.com/selfradiance/agentgate).

I'm not building a company around it. I'm 60 and I don't want the grind. What I wanted was to prove — to myself, mostly — that the gap between understanding a system and building a system has fundamentally changed. It has.

---

## The Real Point

I said at the top that I can't code. That's still true. If you sat me down in front of an empty file and told me to write a function, I'd stare at it.

But I can tell you what a function should do, verify that it does it, and catch when it doesn't. I can decompose a complex system into layers and decide the order in which they should be built. I can think adversarially about what could go wrong. I can impose discipline on a process that would otherwise produce garbage.

It turns out, those skills have a name. They're called architecture.

I spent decades thinking I was on the wrong side of a wall — that the people who could code were the ones who could build things, and the rest of us could only talk about building things. AI didn't tear down that wall. But it gave me a door.

I walked through it. AgentGate is what's on the other side.

---

*James Toole, March 2026*
*[github.com/selfradiance/agentgate](https://github.com/selfradiance/agentgate)*
