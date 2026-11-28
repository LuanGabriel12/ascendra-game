# CARBON Codex audit handoff — gate remains blocked

Do not begin Session 07 until the independent audit is completed, PostgreSQL 16 CI is green at the audited commit, and critical authorization, inventory, idempotency, concurrency and snapshot paths have been verified.

- A textual bounty funding reference is not monetary collateral. Do not settle legacy claims as funded. Require a real, sufficient, verifiable reservation tied to a double-entry ledger in the same transaction as payment; account explicitly for mint and sink.
- Restrict or correct the current unverified active bounty/claim path and add regressions before approving the gate.
- Resolve the contradictory lock-order documents by mapping actual code and proving critical cross-operation ordering with controlled barriers. Shared economic operations need a single transaction across wallet, inventory, escrow and inbox/outbox.
- Keep authoritative idempotency keys or durable tombstones; do not allow late retries to mint assets twice.
- Preserve Genesis isolation, ownership, ranked restrictions, atomic custody and material conservation.
- Complete all 11 independent findings, full schema differential checks, snapshot version/mutation analysis and remote Go validation. No production readiness without authentication and transport.
- Never modify published migrations 0001–0012; use incremental migrations. The historical checksum backfill is not proof of original bytes.
- Preserve relic/Relíquia until a joint decision. Do not merge an intermediate version with known P0/P1 defects into main.
## Follow-up status

Application-level creation of funded/active bounties and all claims now fails closed. Unfunded Draft proposals remain; legacy bounties and claims are unchanged, and active listings omit unverified legacy rows. Existing outbox events and privileged SQL access are not converted into proof of reserves. Consumers must quarantine legacy settlement commitments and independently reconcile historical events before any payment.

Before removing the guard, require a real, sufficient, unconsumed reservation linked to issuer, bounty and currency and recorded in a ledger, verified and consumed atomically with settlement and a retained idempotency key. Re-enable and independently test same-account, race and duplicate-claim behavior when a provider exists. Full lock graph, controlled barrier tests, snapshot version audit, full classification of 001–010, repeated full runs and CI at the latest head remain outstanding. Session 07 remains blocked.