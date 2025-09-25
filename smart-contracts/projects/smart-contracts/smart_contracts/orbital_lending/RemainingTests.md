# Remaining Test Coverage

## Priority Scenarios
- **ASA borrowing lifecycle**: open, accrue, repay, and liquidate borrower positions using ASA base asset; ensure rate math and ledger updates match ALGO flow.
- **Multi-borrower concurrency**: simultaneous loans covering partial repayments, interest accrual, and liquidation thresholds to surface race conditions around `loan_record` snapshots.
- **Collateral rotation**: switching accepted collateral assets mid-loan or between borrowers, verifying oracle lookups and liquidation parameters stay consistent.
- **Protocol share updates**: dynamic changes to `protocol_share_bps` and APR parameters while loans exist; confirm accrual splits remain correct.
- **Paused / disabled assets**: rejected deposits or borrows after an accepted collateral or base asset is revoked; assert clean reverts and state remains intact.

## Flux Upgrade Add-ons
- **Eligibility flips**: depositors gaining/losing Flux tier mid-accrual, with backpay and pause behaviour validated across deposits, withdrawals, and claims.
- **Carry bucket transition**: empty-to-nonempty eligible supply transitions applying deferred flux rewards without precision loss.
- **Injected rewards with Flux siphon**: combine manual yield injections with active Flux distribution to ensure pool and index math balance.

## Reward Injection Tests
- **Direct yield top-up**: confirm `injectYield` boosts `total_deposits` and LST exchange rate while leaving borrower state untouched.
- **Unauthorized injector**: enforce revert paths when the caller lacks permission or transfer txn is malformed.

## Regression Checks
- **Initial deployment invariants**: first deposit, borrow, repay sequences with default params to catch regressions from new features.
- **Zero-share edge cases**: operations when all LST supply is withdrawn, ensuring accrual, injection, and Flux carry logic remain safe.
- **Liquidation path**: integrate Flux and injected rewards into existing liquidation tests to ensure payouts and accounting still reconcile.
