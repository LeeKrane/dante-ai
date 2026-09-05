# Roadmap

One plan per feature the owner shortlisted from the council review of 2026-09-02
(`docs/feature-candidates.md`). Each plan is written for an implementing agent that has not seen
this conversation: it names the seams, the files, the tests that pin the change, the docs that
must move with it, and what "done" looks like. Numbers are the council's original numbers.

Every plan inherits the house rules in `CLAUDE.md`: no new dependencies, `node:test` only, pure
functions as the test seam, `server.js` stays wiring, deny layers and `lib/auth.js` are security
reviews, never `bypassPermissions` by voice. Commits are subject-line only, and nothing is pushed
without being asked.

| # | Plan | Verdict | Size |
|---|---|---|---|
| 4 | [Expired approvals surfaced, never decided](04-expired-approvals.md) | SHIP-NEXT | S |
| 5 | [Voice "what's blocked?"](05-whats-blocked.md) | SHIP-NEXT | S |
| 10 | [Notes query by voice](10-notes-query.md) | SOON | S to M |
| 11 | [Earcons](11-earcons.md) | SOON | S |
| 12 | [Needs-attention re-ping](12-attention-reping.md) | MEASURE-FIRST | S to M |
| 17 | ["Good morning" briefing](17-good-morning.md) | LATER | S to M |
| 18 | [State reasons in reports](18-state-reasons.md) | SOON | S |
| 19 | [Queued follow-ups shown in the roster](19-queued-followups.md) | SOON | S |
| 20 | [Cost and token query](20-cost-query.md) | LATER | S |
| 21 | [Session kinds, seven of them](21-session-kinds.md) | LATER | M to L |

Suggested order: 4 and 18 first (both add a field to the roster record and share the panel
change), then 19 (same seam), 5, 11, 10, 21, 12, 17, 20. Plan 21 builds on the brainstorm kind
already on main. Line numbers were re-checked against main `7874e57`.
