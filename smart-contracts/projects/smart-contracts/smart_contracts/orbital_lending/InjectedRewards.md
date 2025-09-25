# Injected Rewards Entry Point

## Goals
- Allow external incentives (denominated in `base_token_id`) to flow directly into depositor earnings.
- Preserve existing borrower accounting; injected rewards should behave like additional interest credited to LST holders.
- Keep the implementation modular so it coexists with the Flux bonus upgrade and future reward modules.

## Contract Additions
- ABI method `injectYield(assetTransferTxn | paymentTxn, amount)` depending on whether `base_token_id` is an ASA or ALGO.
- Optional `reward_injector` global to restrict who can call the method (e.g., admin, distributor multisig).
- Optional logging opcode to emit the injected amount for easier off-chain indexing.

## Flow Outline
1. **Preconditions**
   - Call `accrueMarket()` first to settle outstanding borrower interest (`OrbitalLending.algo.ts:1004`).
   - Assert the incoming transaction targets `Global.currentApplicationAddress` with the correct asset (`depositASA` at `:620` and `depositAlgo` at `:666` show reference assertions).
   - Enforce `amount > 0` and authorization checks if a dedicated injector is mandated.

2. **State Updates**
   - Increase `total_deposits` by `amount` to raise the LST exchange rate, mirroring depositor-interest crediting (`OrbitalLending.algo.ts:1035`).
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
   - Add a revert path if the transfer was missing or amount mismatched to avoid accidental underfunding.
   - Update documentation and deployment scripts to introduce the new ABI, including injector permissions.

## Testing Strategy
- Unit test that injecting rewards increases `total_deposits` and the LST exchange rate without altering `total_borrows`.
- Scenario test combining an injection with Flux bonuses to confirm pool/index growth and accurate depositor accrual.
- Regression test with `flux_bonus_share_bps = 0` to ensure behaviour reduces to a simple LST boost.
