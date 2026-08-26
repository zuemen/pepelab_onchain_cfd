---
status: accepted
---

# Screening recommends, a Reviewer decides — no key can approve KYC on its own

Real-world KYC is automation-first: document authenticity, liveness, and sanctions screening run unattended, clear submissions are approved in seconds, and only the ambiguous ones reach a human analyst. This project implements the human lane only, and puts the automated part in front of it as *advice*. Screening runs in the frontend when the Review Queue loads, tags each pending Submission as clean or as needing a closer look with a reason, and stops there. Every `approveKYC` transaction originates from a Reviewer pressing a button.

The reason is what an automated approver would require: a hot key holding verifier rights on a live deployment, able to open the regulated markets for any address that submits. M8's whole point was that `submitKYC` used to grant verification in the same call, which made the exchange's RWA gate decorative — any address could clear it in one transaction with made-up data. An unattended key that flips the same boolean on a schedule hands that property straight back, just with more moving parts to explain.

## Considered options

**An auto-approving keeper, mirroring how real KYC providers work.** Rejected on custody, not on fidelity. The project already runs keeper keys for price feeds and has had one live key-management incident; adding a key whose compromise silently opens every KYC-gated market is a poor trade for a testnet proof of concept. If the automation is ever wanted, `setVerifier` grants it without touching any of this code.

**A plain manual queue with no screening at all.** Rejected because it misrepresents the domain — it teaches a reader that KYC is a person reading forms — and it discards the most interesting part of the demo, which is the triage: why *this* submission needs a human and that one does not.

## Consequences

- No `KYCVerified` event ever originates from anything but a human action. Anyone reading the chain can rely on that, and it is worth saying out loud when demonstrating the flow.
- Screening lives entirely in the frontend, so it is trivially bypassable by transacting with the registry directly. It is a triage aid, never a compliance control, and must never be described as one on screen or in a report.
- The watchlist and blocked-jurisdiction data are fictional by construction. Real sanctions lists name real people; a demo that flags one of them as a hit is a problem nobody needs.
- Introducing automated approval later is a permission grant plus a service, not a rewrite. Nothing decided here stands in its way.
