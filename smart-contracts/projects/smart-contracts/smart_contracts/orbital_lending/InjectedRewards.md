# Injected Rewards Entry Point

## Goals
- Allow external incentives (denominated in `base_token_id`) to flow directly into depositor earnings.
- Surface consensus staking rewards earned by the app account as automatic yield injections without circulating a second injector account.
- Preserve existing borrower accounting; injected rewards should behave like additional interest credited to LST holders.
- Keep the implementation modular so it coexists with the Flux bonus upgrade and future reward modules.

## Contract Additions
- ABI method `injectYield(assetTransferTxn | paymentTxn, amount)` depending on whether `base_token_id` is an ASA or ALGO.
- ABI method `pickupAlgoRewards()` gated to `adminAddress` that converts unaccounted native ALGO balance (consensus rewards) into protocol deposits.
- Trackers: `totalConsensusRewards`, `commisionPercentage`, `commisionAmount`, and `minimumBalance` as guardrails for the pickup logic.
- Optional `reward_injector` global to restrict who can call `injectYield` (e.g., admin, distributor multisig).
- Optional logging opcode to emit the injected amount for easier off-chain indexing.

## Consensus Rewards Flow
1. **Trigger**
   - `pickupAlgoRewards()` callable only by the admin.
   - Always run `accrueMarket()` beforehand to keep indices consistent with borrower interest.
2. **Amount Discovery**
   - Compute the newly arrived rewards as the `app.address.balance` minus `minimumBalance`, `totalConsensusRewards`, `totalStaked`, and `commisionAmount`.
   - Guard that `amount > MINIMUM_ALGO_REWARD` to avoid dust and round-trip fees.
3. **Commission Handling**
   - Derive `newCommisionPayment = (amount / 100) * commisionPercentage` and accumulate into `commisionAmount`.
   - Reduce `amount` by the commission slice; if no commission is configured, the branch is skipped.
4. **Reward Injection**
   - Add the net `amount` to `totalConsensusRewards` so subsequent accounting can treat it identically to external injections.
   - Immediately call the shared reward-apportioning helper that increases `total_deposits` (and Flux siphons, if enabled) using `amount` as the delta.

## Flow Outline
1. **Preconditions**
   - Call `accrueMarket()` first to settle outstanding borrower interest (`OrbitalLending.algo.ts:1004`).
   - For external injections, assert the incoming transaction targets `Global.currentApplicationAddress` with the correct asset (`depositASA` at `:620` and `depositAlgo` at `:666` show reference assertions).
   - For consensus rewards, ensure `pickupAlgoRewards()` revalidates admin authority and minimum payout threshold before continuing.
   - Enforce `amount > 0` and authorization checks if a dedicated injector is mandated.

2. **State Updates**
   - Share a single helper that takes the resolved `amount` (from either external injections or consensus pickup) and increases `total_deposits` to raise the LST exchange rate, mirroring depositor-interest crediting (`OrbitalLending.algo.ts:1035`).
   - Leave `circulating_lst` unchanged so existing LST holders receive the reward pro rata.
   - Do **not** touch borrower state (`total_borrows`, `borrow_index_wad`), since no borrower interest was generated.

3. **Flux Bonus Interaction (future v2)**
   - If `flux_bonus_share_bps > 0`, route the injected amount through the same siphon used in `accrueMarket`:
     ```ts
     const [hi, lo] = mulw(amount, this.flux_bonus_share_bps.value)
     const fluxInterest = divw(hi, lo, BASIS_POINTS)
     ```
   - Grow `flux_bonus_index_wad` and `flux_bonus_pool` with the siphoned slice, applying carry logic when `eligible_lst_supply == 0`.
   - Credit only the remainder to `total_deposits` so main LST yield stays consistent with Flux distribution.

4. **Bookkeeping & Safety**
   - Ensure `protocol_share_bps + flux_bonus_share_bps <= BASIS_POINTS`; injected rewards should not bypass those invariants.
   - Add assertions around `amount >= 0` in `pickupAlgoRewards()` so defensive math or micro-rewards do not underflow the helper.
   - Add a revert path if the transfer was missing or amount mismatched to avoid accidental underfunding.
   - Update documentation and deployment scripts to introduce the new ABIs, including injector permissions and admin-only reward pickup.

## Testing Strategy
- Unit test that injecting rewards increases `total_deposits` and the LST exchange rate without altering `total_borrows`.
- Unit test `pickupAlgoRewards()` scenarios (no rewards, dust rewards, commission applied) to confirm balance calculations and invariants when consensus payouts arrive.
- Scenario test combining an injection with Flux bonuses to confirm pool/index growth and accurate depositor accrual.
- Regression test with `flux_bonus_share_bps = 0` to ensure behaviour reduces to a simple LST boost.
