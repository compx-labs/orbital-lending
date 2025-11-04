# Orbital Lending Testing Coverage

## Current Coverage Highlights
- Configuration flow now exercises both lending markets for admin paths (`initApplication`, `setRateParams`, access control) using `OrbitalLending-config.e2e.spec.ts`.
- Deposit/borrow suites cover native ALGO flows end-to-end (deposits, borrows, accrual, fee withdrawals) across several scenarios.
- Liquidation, buyout, migration, and rewards specs validate the ALGO market logic, ensuring collateral accounting and protocol fee mechanics maintain integrity.
- ASA borrowing paths are partially covered for positive flows (deposit, borrow, fee withdrawal) via `OrbitalLending-deposit-asa.e2e.spec.ts`.

## Notable Gaps
- **ASA repay/buyout/liquidation**  
  - `OrbitalLendingASA.algo.ts:1183`, `1275`, `1701` never execute in tests; need an ASA lifecycle (repay, `buyoutSplitASA`, `liquidatePartialASA`) to confirm parity with ALGO implementations.
- **Withdrawable collateral helper**  
  - `OrbitalLending.algo.ts:1399`, `OrbitalLendingASA.algo.ts:1440` lack coverage. Add a scenario that oscillates LTV around the threshold to verify `maxWithdrawableCollateralLST`.
- **Loan status read API**  
  - `OrbitalLending.algo.ts:1827` remains untested, leaving `getLoanStatus` ratios/flags unchecked in automated runs.
- **Flux-tier fee discounts**  
  - `OrbitalLending.algo.ts:779` logic is dormant; tests never configure `fluxOracleAppId`, so origination fee reductions per tier are unverified.
- **Contract state gating**  
  - `OrbitalLending.algo.ts:375` is only tested for non-admin rejection. Missing regression that pauses/migrates the contract and asserts operational entrypoints revert (`CONTRACT_NOT_ACTIVE`).

## Suggested Next Steps
1. Extend ASA e2e coverage: deposit → borrow → partial repay → `buyoutSplitASA` and `liquidatePartialASA`.
2. Add focused spec validating `maxWithdrawableCollateralLST` and `getLoanStatus` boundary behaviors.
3. Stand up a Flux oracle stub in tests to assert tier-based fee reductions and state updates.
4. Introduce a pause-state regression test covering at least deposit and borrow rejections while inactive.

