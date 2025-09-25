# v2 Flux Bonus Upgrade

## Goals
- Carve a configurable slice of borrower interest for Flux-qualified depositors without breaking existing LST economics.
- Keep the core accrual logic centralized while layering Flux rewards as an additive module.
- Ensure rewards follow LST balances for qualifying users, pause when they lose the tier, and remain claimable thereafter.

## New Protocol State
- `flux_bonus_share_bps` (global): Basis-points share taken from depositor interest before it boosts `total_deposits`.
- `flux_bonus_pool` (global): Accumulates siphoned interest that has not yet been claimed.
- `flux_bonus_index_wad` (global): Wide index tracking bonus per eligible LST unit (`INDEX_SCALE` precision).
- `eligible_lst_supply` (global): Sum of LST balances for accounts currently meeting the Flux tier requirement.
- `flux_carry_wad` (global): Stores unassignable index growth while `eligible_lst_supply == 0`, released once an account qualifies.
- `flux_reward_records` (box map keyed by depositor):
  - `lst_balance`: Copies their on-ledger LST shares for reward math.
  - `accrued_flux`: Pending claimable bonus.
  - `last_index_wad`: Snapshot of `flux_bonus_index_wad` from the last sync.
  - `is_eligible`: Cached flag for quick deltas (derived from oracle tier at sync time).

## Oracle Tier Gating
- Define a constant `flux_tier_threshold` (global or config parameter).
- Introduce helper `meetsFluxTier(account) -> bool` that ABI-calls the oracle to fetch the account’s tier and compares with threshold.
- Always re-evaluate eligibility immediately before any reward sync or accrual affecting the account.

## Accrual Pipeline Changes
1. **Market Accrual (`accrueMarket`)**
   - After computing `depositorInterest`, siphon `fluxInterest = depositorInterest * flux_bonus_share_bps / BASIS_POINTS`.
   - Reduce `depositorInterest` by `fluxInterest` before updating `total_deposits`.
   - Add `fluxInterest` into `flux_bonus_pool`; if `eligible_lst_supply > 0`, also grow the index:
     ```ts
     const [hi, lo] = mulw(fluxInterest, INDEX_SCALE)
     const deltaIndex = divw(hi, lo, this.eligible_lst_supply.value)
     this.flux_bonus_index_wad.value += deltaIndex
     ```
   - If no eligible supply, convert the prospective delta into `flux_carry_wad` for later distribution.

2. **Carry Release**
   - Whenever `eligible_lst_supply` transitions from 0 to non-zero, apply the stored `flux_carry_wad` to the index:
     ```ts
     const deltaIndex = divw(this.flux_carry_wad.value, INDEX_SCALE, this.eligible_lst_supply.value)
     this.flux_bonus_index_wad.value += deltaIndex
     this.flux_carry_wad.value = 0
     ```
   - `flux_carry_wad` should accumulate `fluxInterest * INDEX_SCALE` while the pool is empty.

## Depositor Lifecycle Hooks
- **Sync Helper** `syncFluxRewards(account)`:
  1. Load reward record (create default on first use).
  2. Determine latest eligibility via oracle call.
  3. If `record.lst_balance > 0` and `eligible_lst_supply > 0`, accrue pending bonus:
     ```ts
     const deltaIndex = this.flux_bonus_index_wad.value - record.last_index_wad
     if (deltaIndex > 0) {
       const [hi, lo] = mulw(record.lst_balance, deltaIndex)
       record.accrued_flux += divw(hi, lo, INDEX_SCALE)
     }
     ```
  4. Update `record.last_index_wad` to current index.
  5. If eligibility state changed, adjust `eligible_lst_supply` accordingly and update `record.is_eligible`.
  6. Persist record.

- **Deposits (`depositASA` / `depositAlgo`)**:
  - After minting LST, call `syncFluxRewards(sender)`.
  - Add the minted LST amount to `record.lst_balance`.
  - If newly eligible, increase `eligible_lst_supply` and, if coming from zero, flush carry.

- **Withdrawals (`withdrawASA` / `withdrawAlgo`)**:
  - `syncFluxRewards(sender)` first.
  - Subtract burned LST from `record.lst_balance` and, if eligible, adjust `eligible_lst_supply`.

- **Loan Repay / Borrow Interactions**:
  - Before actions that call `accrueMarket`, consider syncing actors to maintain up-to-date balances when their LST may change (optional if LST unaffected).

## Claim Flow
- Add ABI method `claimFluxBonus()`:
  - `syncFluxRewards(sender)`.
  - Require `record.accrued_flux > 0`.
  - Transfer min(record.accrued_flux, `flux_bonus_pool`) of base asset to sender.
  - Decrement `flux_bonus_pool` by transferred amount and reset `record.accrued_flux`.
  - Persist updated record.

## Safety & Edge Cases
- Cap `flux_bonus_share_bps` to ensure `flux_bonus_share_bps <= BASIS_POINTS` and `protocol_share_bps + flux_bonus_share_bps <= BASIS_POINTS`.
- When LST balances go to zero for all holders, keep accruals in `flux_carry_wad` to avoid division-by-zero.
- Ensure oracle failures revert the transaction, preserving state integrity.
- Guard against reentrancy by sequencing state writes before ITXNs.

## Configuration & Deployment
- Update deployment scripts to provide `flux_bonus_share_bps` and `flux_tier_threshold`.
- Migrate existing state on upgrade: initialize new globals to zero; run a post-upgrade management call to set configuration.

## Testing Strategy
- Unit tests for `accrueMarket` covering:
  - No eligible supply → carry accrues.
  - Eligible supply present → index increments and pool grows.
  - Transition from empty to non-empty supply releasing carry.
- Scenario tests for deposit/withdraw:
  - Tier upgrade mid-flight causes backpay with new index delta.
  - Tier loss stops new accrual but preserves prior rewards.
- Claim flow tests ensuring pool/record consistency and multiple claims.
- Regression tests verifying original APR, LST exchange rate, and protocol fee math remain unchanged when `flux_bonus_share_bps = 0`.
