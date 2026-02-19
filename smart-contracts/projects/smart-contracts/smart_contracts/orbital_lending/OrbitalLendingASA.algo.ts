/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/explicit-member-accessibility */
import { Account, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  abimethod,
  Application,
  assert,
  assertMatch,
  Asset,
  BoxMap,
  contract,
  Contract,
  err,
  Global,
  GlobalState,
  itxn,
  op,
} from '@algorandfoundation/algorand-typescript'
import { abiCall, Address, DynamicArray, UintN64, UintN8 } from '@algorandfoundation/algorand-typescript/arc4'
import { divw, mulw } from '@algorandfoundation/algorand-typescript/op'
import {
  AcceptedCollateral,
  AcceptedCollateralKey,
  DebtChange,
  DepositRecord,
  DepositRecordKey,
  INDEX_SCALE,
  LoanRecord,
  MINIMUM_ADDITIONAL_REWARD,
} from './config.algo'
import { TokenPrice } from '../Oracle/config.algo'
import { STANDARD_TXN_FEE, BASIS_POINTS, EXCHANGE_PRECISION, SECONDS_PER_YEAR } from './config.algo'

const CONTRACT_VERSION: uint64 = 4000

@contract({ name: 'orbital-lending-asa', avmVersion: 11 })
export class OrbitalLending extends Contract {
  // ═══════════════════════════════════════════════════════════════════════
  // CORE TOKEN CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════

  /** The main lending token used for deposits and borrowing (0 for ALGO) */
  base_token_id = GlobalState<UintN64>()

  /** Decimal precision for the base lending token (atomic units per token). */
  base_token_decimals = GlobalState<uint64>()

  /** LST (Liquidity Staking Token) representing depositor shares in the pool */
  lst_token_id = GlobalState<UintN64>()

  // ═══════════════════════════════════════════════════════════════════════
  // LIQUIDITY POOL TRACKING
  // ═══════════════════════════════════════════════════════════════════════

  /** Total LST tokens currently in circulation (represents depositor claims) */
  circulating_lst = GlobalState<uint64>()

  /** Total underlying assets deposited in the protocol */
  total_deposits = GlobalState<uint64>()

  /** Protocol fee accumulation pool (admin withdrawable) */
  fee_pool = GlobalState<uint64>()

  // ═══════════════════════════════════════════════════════════════════════
  // PROTOCOL GOVERNANCE & ACCESS CONTROL
  // ═══════════════════════════════════════════════════════════════════════

  /** Administrator account to create and init application */
  init_admin = GlobalState<Account>()

  /** Administrative account with access to setRateParam functions */
  param_admin = GlobalState<Account>()

  /** Administration account with access to payFees */
  fee_admin = GlobalState<Account>()

  /** External oracle application for asset price feeds */
  oracle_app = GlobalState<Application>()

  /** External oracle application for user flux tier feeds */
  flux_oracle_app = GlobalState<Application>()

  /** External registery with app Ids */
  master_registry_app = GlobalState<Application>()

  // ═══════════════════════════════════════════════════════════════════════
  // LENDING PARAMETERS (ALL IN BASIS POINTS)
  // ═══════════════════════════════════════════════════════════════════════

  /** Loan-to-Value ratio (e.g., 7500 = 75% max borrowing against collateral) */
  ltv_bps = GlobalState<uint64>()

  /** Liquidation threshold (e.g., 8500 = 85% - liquidate when CR falls below) */
  liq_threshold_bps = GlobalState<uint64>()

  /** One-time fee charged on loan origination (e.g., 100 = 1%) */
  origination_fee_bps = GlobalState<uint64>()

  /** Protocol's share of interest income (e.g., 2000 = 20%) */
  protocol_share_bps = GlobalState<uint64>()

  /** Minimum APR at 0% utilization (basis points per year). */
  base_bps = GlobalState<uint64>()

  /** Hard utilization cap in bps (e.g., 8000 = 80% of deposits may be borrowed). */
  util_cap_bps = GlobalState<uint64>()

  /** Kink point on normalized utilization (0..10_000 across [0..util_cap]). */
  kink_norm_bps = GlobalState<uint64>()

  /** APR increase from 0 → kink (added to base) over the normalized range. */
  slope1_bps = GlobalState<uint64>()

  /** APR increase from kink → cap (added after kink) over the normalized range. */
  slope2_bps = GlobalState<uint64>()

  /** (Optional) Absolute APR ceiling in bps (0 = no cap). */
  max_apr_bps = GlobalState<uint64>()

  /** (Optional, mutable) Last applied APR in bps (for step limiting). */
  prev_apr_bps = GlobalState<uint64>()

  /** Total outstanding borrower principal + accrued interest (debt) */
  total_borrows = GlobalState<uint64>()

  /** Multiplicative borrow index (scaled by INDEX_SCALE). Starts at INDEX_SCALE */
  borrow_index_wad = GlobalState<uint64>()

  /** Timestamp (ledger seconds) at which borrow_index_wad was last advanced */
  last_accrual_ts = GlobalState<uint64>()

  /** APR (in bps) that applied during [last_accrual_ts, now) before recompute */
  last_apr_bps = GlobalState<uint64>()

  /** Sum of borrower principals (no interest). We’ll migrate total_borrows usage. */
  total_borrows_principal = GlobalState<uint64>()

  // ═══════════════════════════════════════════════════════════════════════
  // COLLATERAL & LOAN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  /** Registry of accepted collateral assets with their metadata */
  accepted_collaterals = BoxMap<AcceptedCollateralKey, AcceptedCollateral>({ keyPrefix: 'accepted_collaterals' })

  /** Individual borrower loan records with collateral and debt details */
  loan_record = BoxMap<Account, LoanRecord>({ keyPrefix: 'loan_record' })

  /** Total number of active loans in the system */
  active_loan_records = GlobalState<uint64>()

  /** Count of different collateral types accepted by the protocol */
  accepted_collaterals_count = GlobalState<uint64>()

  /** Total number of active loans in the system */
  buyout_token_id = GlobalState<UintN64>()

  /** Decimal precision for the buyout premium token (atomic units per token). */
  buyout_token_decimals = GlobalState<uint64>()

  /** Liquidation bonus in bps (e.g., 500 = 5% bonus to liquidators) */
  liq_bonus_bps = GlobalState<uint64>()

  deposit_record = BoxMap<DepositRecordKey, DepositRecord>({ keyPrefix: 'deposit_record' })

  // ═══════════════════════════════════════════════════════════════════════
  // EXTERNAL / CONSENSUS REWARDS
  // ═══════════════════════════════════════════════════════════════════════

  commission_percentage = GlobalState<uint64>()

  current_accumulated_commission = GlobalState<uint64>()

  total_commission_earned = GlobalState<uint64>()

  total_additional_rewards = GlobalState<uint64>()

  cash_on_hand = GlobalState<uint64>()

  // ═══════════════════════════════════════════════════════════════════════
  // DEBUG & OPERATIONAL TRACKING
  // ═══════════════════════════════════════════════════════════════════════

  contract_state = GlobalState<UintN64>() // 0 = inactive, 1 = active

  contract_version = GlobalState<UintN64>() // contract version number

  /**
   * Creates the lending application contract with initial configuration
   * @param admin - The administrative account that will have privileged access
   * @param baseTokenId - The asset ID of the base lending token (0 for ALGO)
   * @dev This method can only be called during contract creation (onCreate: 'require')
   */
  @abimethod({ allowActions: 'NoOp', onCreate: 'require' })
  public createApplication(paramAdmin: Account, feeAdmin: Account, baseTokenId: uint64): void {
    this.param_admin.value = paramAdmin
    this.fee_admin.value = feeAdmin
    this.init_admin.value = op.Txn.sender
    this.base_token_id.value = new UintN64(baseTokenId)
    this.contract_state.value = new UintN64(0) // inactive
    this.contract_version.value = new UintN64(CONTRACT_VERSION)
  }

  /**
   * Initializes the lending protocol with core parameters and configurations
   * @param mbrTxn - Payment transaction covering minimum balance requirements
   * @param ltv_bps - Loan-to-Value ratio in basis points (e.g., 7500 = 75%)
   * @param liq_threshold_bps - Liquidation threshold in basis points (e.g., 8500 = 85%)
   * @param origination_fee_bps - One-time loan origination fee in basis points
   * @param protocol_share_bps - Protocol's share of interest income in basis points
   * @param oracle_app_id - Application ID of the price oracle contract
   * @dev Only callable by admin account. Sets up all lending parameters and opts into base token if needed
   */
  @abimethod({ allowActions: 'NoOp' })
  public initApplication(
    ltv_bps: uint64,
    liq_threshold_bps: uint64,
    origination_fee_bps: uint64,
    protocol_share_bps: uint64,
    oracle_app_id: Application,
    buyout_token_id: uint64,
    additional_rewards_commission_percentage: uint64,
    flux_oracle_app_id: Application,
  ): void {
    assert(op.Txn.sender === this.init_admin.value)
    assert(additional_rewards_commission_percentage <= 100, 'COMMISSION_TOO_HIGH')

    this.ltv_bps.value = ltv_bps
    this.liq_bonus_bps.value = 800
    this.liq_threshold_bps.value = liq_threshold_bps
    this.origination_fee_bps.value = origination_fee_bps
    this.accepted_collaterals_count.value = 0
    this.fee_pool.value = 0
    this.circulating_lst.value = 0
    this.total_deposits.value = 0
    this.active_loan_records.value = 0
    this.protocol_share_bps.value = protocol_share_bps
    this.oracle_app.value = oracle_app_id
    this.lst_token_id.value = new UintN64(99)
    this.base_bps.value = 50
    this.util_cap_bps.value = 8000 // 80% utilization cap
    this.total_borrows.value = 0
    this.kink_norm_bps.value = 5000 // 50% kink point
    this.slope1_bps.value = 1000 // 10% slope to kink
    this.slope2_bps.value = 2000 // 20% slope after kink
    this.max_apr_bps.value = 8000 // 80% APR Cap by Default
    this.prev_apr_bps.value = 50 // Same as base_bps by default
    this.borrow_index_wad.value = INDEX_SCALE
    this.last_accrual_ts.value = Global.latestTimestamp
    this.last_apr_bps.value = this.base_bps.value
    this.buyout_token_id.value = new UintN64(buyout_token_id)
    this.total_commission_earned.value = 0
    this.current_accumulated_commission.value = 0
    this.commission_percentage.value = additional_rewards_commission_percentage
    this.total_borrows_principal.value = 0
    this.cash_on_hand.value = 0
    this.total_additional_rewards.value = 0
    this.flux_oracle_app.value = flux_oracle_app_id

    if (this.base_token_id.value.native === 0) {
      this.base_token_decimals.value = 6
    } else {
      this.base_token_decimals.value = Asset(this.base_token_id.value.native).decimals
    }
    if (this.buyout_token_id.value.native === 0) {
      this.buyout_token_decimals.value = 6
    } else {
      this.buyout_token_decimals.value = Asset(this.buyout_token_id.value.native).decimals
    }

    if (this.base_token_id.value.native !== 0) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          xferAsset: this.base_token_id.value.native,
          assetAmount: 0,
          fee: 0,
        })
        .submit()
    }
    if (this.buyout_token_id.value.native !== 0) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          xferAsset: this.buyout_token_id.value.native,
          assetAmount: 0,
          fee: 0,
        })
        .submit()
    }
  }

  /**
   * Sets the core lending parameters for the protocol
   * @param base_bps - Base APR in basis points (e.g., 500 = 5%)
   * @param util_cap_bps - Utilization cap in basis points (e.g., 8000 = 80%)
   * @param kink_norm_bps - Kink normalization point in basis points (e.g., 5000 = 50%)
   * @param slope1_bps - Slope to kink in basis points (e.g., 1000 = 10%)
   * @param slope2_bps - Slope after kink in basis points (e.g., 2000 = 20%)
   * @param max_apr_bps - Maximum APR cap in basis points (0 = no cap)
   * @param borrow_gate_enabled - Whether the borrow gate is enabled (1 = enabled, 0 = disabled)
   * @param ema_alpha_bps - EMA smoothing factor in basis points (0 = no smoothing)
   * @param max_apr_step_bps - Maximum APR step in basis points (0 = no limit)
   * @param rate_model_type - Rate model type (0 = kinked, 1 = linear, 2 = power, 3 = asymptote)
   * @param power_gamma_q16 - Power curve exponent in Q16.16 fixed-point (0 = no power curve)
   * @param scarcity_K_bps - Scarcity parameter in basis points (0 = no scarcity)
   * @param liq_threshold_bps - Liquidation threshold in basis points (e.g., 8500 = 85%)
   * @param ltv_bps - Loan-to-Value ratio in basis points (e.g., 7500 = 75%)
   * @dev Only callable by admin account. Updates all core lending parameters atomically
   */
  @abimethod({ allowActions: 'NoOp' })
  public setRateParams(
    ltv_bps: uint64,
    liq_threshold_bps: uint64,
    base_bps: uint64,
    util_cap_bps: uint64,
    kink_norm_bps: uint64,
    slope1_bps: uint64,
    slope2_bps: uint64,
    max_apr_bps: uint64,
    ema_alpha_bps: uint64,
    rate_model_type: uint64, // or uint8
    liq_bonus_bps: uint64,
  ) {
    assert(op.Txn.sender === this.param_admin.value, 'UNAUTHORIZED')

    // Invariants
    assert(util_cap_bps >= 1 && util_cap_bps <= 10_000, 'BAD_UTIL_CAP')
    assert(kink_norm_bps >= 1 && kink_norm_bps < 10_000, 'BAD_KINK')
    assert(slope1_bps >= 0 && slope2_bps >= 0, 'BAD_SLOPE')
    if (max_apr_bps > 0) {
      assert(max_apr_bps >= base_bps, 'BAD_MAX_APR')
    }
    assert(ema_alpha_bps <= 10_000, 'BAD_EMA_ALPHA')

    // (optional) restrict model types you actually implement now
    assert(rate_model_type === 0 /* kinked */ || rate_model_type === 255 /* fixed */, 'UNSUPPORTED_MODEL')
    this.base_bps.value = base_bps
    this.liq_threshold_bps.value = liq_threshold_bps
    this.ltv_bps.value = ltv_bps
    this.util_cap_bps.value = util_cap_bps
    this.kink_norm_bps.value = kink_norm_bps
    this.slope1_bps.value = slope1_bps
    this.slope2_bps.value = slope2_bps
    this.max_apr_bps.value = max_apr_bps
    this.liq_bonus_bps.value = liq_bonus_bps
    // Optional: clamp prev_apr if a new max is lower
    if (this.max_apr_bps.value > 0 && this.prev_apr_bps.value > this.max_apr_bps.value) {
      this.prev_apr_bps.value = this.max_apr_bps.value
    }
  }

  @abimethod({ allowActions: 'NoOp' })
  public setContractState(state: uint64): void {
    assert(op.Txn.sender === this.init_admin.value, 'UNAUTHORIZED')
    assert(state === 0 || state === 1, 'INVALID_STATE')
    this.contract_state.value = new UintN64(state)
  }

  /**
   * Generates a new LST (Liquidity Staking Token) for the base lending token.
   * @param mbrTxn Payment transaction covering asset-creation minimum balance.
   * @dev Admin-only path that mints a brand-new LST mirroring the base token supply.
   */
  @abimethod({ allowActions: 'NoOp' })
  public generateLSTToken(): void {
    assert(op.Txn.sender === this.init_admin.value)
    assert((this.lst_token_id.value === new UintN64(99)))
    //Create LST token
    const baseToken = Asset(this.base_token_id.value.native)
    const result = itxn
      .assetConfig({
        sender: Global.currentApplicationAddress,
        total: baseToken.total,
        decimals: baseToken.decimals,
        defaultFrozen: false,
        manager: Global.currentApplicationAddress,
        unitName: 'c' + String(baseToken.unitName),
        assetName: 'c' + String(baseToken.unitName),
        fee: 0,
      })
      .submit()
    this.lst_token_id.value = new UintN64(result.createdAsset.id)
  }


  /**
   * Retrieves current price for a token from the configured oracle
   * @param tokenId - Asset ID of the token to get price for
   * @returns Current price of the token from oracle (in USD micro-units)
   * @dev Calls external oracle contract to fetch real-time price data
   */
  @abimethod({ allowActions: 'NoOp' })
  public getOraclePrice(tokenId: UintN64): uint64 {
    const oracle: Application = this.oracle_app.value
    const address = oracle.address
    const contractAppId = oracle.id

    const result = abiCall(PriceOracleStub.prototype.getTokenPrice, {
      appId: contractAppId,
      args: [tokenId],
      fee: 0,
    }).returnValue

    return result.price.native
  }

  /**
   * Returns 10^decimals for converting between atomic token units and whole-token prices.
   * ASA decimals are bounded, so capping keeps scale within uint64.
   */
  private decimalScale(decimals: uint64): uint64 {
    assert(decimals <= 19, 'BAD_DECIMALS')
    let scale: uint64 = 1
    let i: uint64 = 0
    while (i < decimals) {
      scale = scale * 10
      i = i + 1
    }
    return scale
  }

  /**
   * Converts atomic token units into USD micro-units using token decimals and oracle price.
   */
  private amountToUsd(amountAtomic: uint64, oraclePriceMicroUsd: uint64, tokenDecimals: uint64): uint64 {
    const scale = this.decimalScale(tokenDecimals)
    const [h, l] = mulw(amountAtomic, oraclePriceMicroUsd)
    return divw(h, l, scale)
  }

  /**
   * Converts USD micro-units into atomic token units using token decimals and oracle price.
   */
  private usdToAmount(usdMicro: uint64, oraclePriceMicroUsd: uint64, tokenDecimals: uint64): uint64 {
    assert(oraclePriceMicroUsd > 0, 'BAD_PRICE')
    const scale = this.decimalScale(tokenDecimals)
    const [h, l] = mulw(usdMicro, scale)
    return divw(h, l, oraclePriceMicroUsd)
  }

  /**
   * Scales liquidation bonus from 0 at the threshold up to the configured max as LTV worsens.
   * @param ltvBps live LTV in basis points (debtUSD / collateralUSD * 10_000)
   */
  private dynamicLiqBonusBps(ltvBps: uint64): uint64 {
    const maxBonus: uint64 = this.liq_bonus_bps.value
    const threshold: uint64 = this.liq_threshold_bps.value
    if (ltvBps <= threshold) return 0

    const over: uint64 = ltvBps - threshold
    const room: uint64 = BASIS_POINTS > threshold ? BASIS_POINTS - threshold : 1

    const [h, l] = mulw(over, maxBonus)
    let bonus: uint64 = divw(h, l, room)
    if (bonus === 0) bonus = 1
    if (bonus > maxBonus) bonus = maxBonus
    return bonus
  }

  /**
   * Returns the current amount of LST tokens in circulation
   * @returns Total LST tokens representing all depositor claims
   */
  getCirculatingLST(): uint64 {
    return this.circulating_lst.value
  }

  /**
   * Returns the total amount of base assets deposited in the protocol
   * @returns Total underlying assets available for lending
   */
  getTotalDeposits(): uint64 {
    return this.total_deposits.value
  }

  /**
   * Returns the number of different collateral types accepted by the protocol
   * @returns Count of registered collateral asset types
   */
  getAcceptedCollateralsCount(): uint64 {
    return this.accepted_collaterals_count.value
  }

  /**
   * Checks whether a collateral asset has already been registered.
   * @param collateralTokenId Asset identifier to look up in collateral storage.
   * @returns True when the collateral entry exists, false otherwise.
   */
  private collateralExists(collateralTokenId: UintN64): boolean {
    const key = new AcceptedCollateralKey({ assetId: collateralTokenId })
    return this.accepted_collaterals(key).exists
  }

  /**
   * Loads the persisted metadata for a collateral asset.
   * @param collateralTokenId Asset identifier to fetch.
   * @returns Collateral configuration copied from box storage.
   */
  private getCollateral(collateralTokenId: UintN64): AcceptedCollateral {
    const key = new AcceptedCollateralKey({ assetId: collateralTokenId })
    return this.accepted_collaterals(key).value.copy()
  }

  /**
   * Increments the tracked collateral total for an asset.
   * @param collateralTokenId Asset whose total is being increased.
   * @param amount Amount of collateral (in LST units) to add.
   */
  private updateCollateralTotal(collateralTokenId: UintN64, amount: uint64): void {
    const key = new AcceptedCollateralKey({ assetId: collateralTokenId })
    const collateral = this.accepted_collaterals(key).value.copy()

    const newTotal: uint64 = collateral.totalCollateral.native + amount
    this.accepted_collaterals(key).value = new AcceptedCollateral({
      assetId: collateral.assetId,
      baseAssetId: collateral.baseAssetId,
      baseAssetDecimals: collateral.baseAssetDecimals,
      marketBaseAssetId: collateral.marketBaseAssetId,
      marketBaseAssetDecimals: collateral.marketBaseAssetDecimals,
      totalCollateral: new UintN64(newTotal),
      originatingAppId: collateral.originatingAppId,
    }).copy()
  }

  /**
   * Decrements the tracked collateral total when collateral is returned.
   * @param collateralTokenId Asset whose total is being reduced.
   * @param amount Amount of collateral (in LST units) to remove.
   * @dev Reverts if the requested reduction exceeds the tracked total.
   */
  private reduceCollateralTotal(collateralTokenId: UintN64, amount: uint64): void {
    const key = new AcceptedCollateralKey({ assetId: collateralTokenId })
    const collateral = this.accepted_collaterals(key).value.copy()

    assert(collateral.totalCollateral.native >= amount, 'INSUFFICIENT_COLLATERAL')
    const newTotal: uint64 = collateral.totalCollateral.native - amount
    this.accepted_collaterals(key).value = new AcceptedCollateral({
      assetId: collateral.assetId,
      baseAssetId: collateral.baseAssetId,
      baseAssetDecimals: collateral.baseAssetDecimals,
      marketBaseAssetId: collateral.marketBaseAssetId,
      marketBaseAssetDecimals: collateral.marketBaseAssetDecimals,
      totalCollateral: new UintN64(newTotal),
      originatingAppId: collateral.originatingAppId,
    }).copy()
  }

  @abimethod({ allowActions: 'NoOp' })
  public removeCollateralType(collateralTokenId: UintN64): void {
    assert(op.Txn.sender === this.init_admin.value, 'UNAUTHORIZED')
    assert(this.collateralExists(collateralTokenId), 'COLLATERAL_NOT_FOUND')

    const key = new AcceptedCollateralKey({ assetId: collateralTokenId }).copy()
    const collateral = this.accepted_collaterals(key).value.copy()
    assert(collateral.totalCollateral.native === 0, 'COLLATERAL_IN_USE')

    this.accepted_collaterals(key).delete()
    this.accepted_collaterals_count.value = this.accepted_collaterals_count.value - 1
  }

  /**
   * Adds a new asset type as accepted collateral for borrowing
   * @param collateralTokenId - Asset ID of the new collateral type to accept
   * @param mbrTxn - Payment transaction covering storage minimum balance requirements
   * @dev Only callable by admin. Registers new collateral type and opts contract into the asset
   * @dev Collateral cannot be the same as the base lending token
   */
  @abimethod({ allowActions: 'NoOp' })
  public addNewCollateralType(
    collateralTokenId: UintN64,
    collateralBaseTokenId: UintN64,
    originatingAppId: UintN64,
  ): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assert(op.Txn.sender === this.init_admin.value, 'UNAUTHORIZED')
    assert(collateralTokenId.native !== baseToken.id, 'CANNOT_USE_BASE_AS_COLLATERAL')
    assert(!this.collateralExists(collateralTokenId), 'COLLATERAL_ALREADY_EXISTS')

    const newAcceptedCollateral: AcceptedCollateral = new AcceptedCollateral({
      assetId: collateralTokenId,
      baseAssetId: collateralBaseTokenId,
      baseAssetDecimals: new UintN64(Asset(collateralBaseTokenId.native).decimals),
      marketBaseAssetId: this.base_token_id.value,
      marketBaseAssetDecimals: new UintN64(this.base_token_decimals.value),
      totalCollateral: new UintN64(0),
      originatingAppId: originatingAppId,
    })
    const key = new AcceptedCollateralKey({ assetId: collateralTokenId })
    this.accepted_collaterals(key).value = newAcceptedCollateral.copy()
    this.accepted_collaterals_count.value = this.accepted_collaterals_count.value + 1
    itxn
      .assetTransfer({
        sender: Global.currentApplicationAddress,
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: collateralTokenId.native,
        assetAmount: 0,
        fee: 0,
      })
      .submit()

    assert(this.collateralExists(collateralTokenId), 'unsupported collateral')
  }

  /**
   * Computes the LST amount owed for a deposit based on local exchange rate.
   * @param amount Base token amount being deposited.
   * @returns LST units to mint to the depositor.
   */
  private calculateLSTDue(amount: uint64): uint64 {
    const [highBits1, lowBits1] = mulw(this.circulating_lst.value, EXCHANGE_PRECISION)

    const lstRatio = divw(highBits1, lowBits1, this.total_deposits.value)

    const [highBits2, lowBits2] = mulw(lstRatio, amount)
    return divw(highBits2, lowBits2, EXCHANGE_PRECISION)
  }

  // Calculate how much underlying ASA to return for a given LST amount,
  // by querying the external LST contract’s circulatingLST & totalDeposits.
  /**
   * Calculates required underlying ASA using an external LST app's exchange rate.
   * @param amount LST units being redeemed.
   * @param lstApp Application ID of the external LST market.
   * @returns Base asset amount that must be returned.
   */
  private calculateASADue(amount: uint64, lstApp: uint64): uint64 {
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstApp,
      fee: 0,
    }).returnValue
    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstApp,
      fee: 0,
    }).returnValue

    // underlyingCollateral = (amount * totalDepositsExternal) / circulatingExternalLST
    const [hiScaled, loScaled] = mulw(totalDepositsExternal, amount)
    return divw(hiScaled, loScaled, circulatingExternalLST)
  }

  /**
   * Calculates underlying assets owed for an LST redemption using local state.
   * @param amount LST units being redeemed within this contract.
   * @returns Base asset amount that matches the burn.
   */
  private calculateLSTDueLocal(amount: uint64): uint64 {
    // Calculate the LST due based on the local state of this contract
    const circulatingExternalLST = this.circulating_lst.value
    const totalDepositsExternal = this.total_deposits.value

    // underlyingCollateral = (amount * totalDepositsExternal) / circulatingExternalLST
    const [hiScaled, loScaled] = mulw(totalDepositsExternal, amount)
    return divw(hiScaled, loScaled, circulatingExternalLST)
  }

  /**
   * Deposits base assets (ASA) into the lending pool and receives LST tokens in return
   * @param assetTransferTxn - Asset transfer transaction depositing base tokens to the contract
   * @param amount - Amount of base tokens being deposited
   * @param mbrTxn - Payment transaction covering transaction fees
   * @dev Mints LST tokens proportional to deposit amount based on current exchange rate
   * @dev If this is the first deposit, LST:asset ratio is 1:1
   */
  @abimethod({ allowActions: 'NoOp' })
  public depositASA(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: baseToken,
      assetAmount: amount,
      sender: op.Txn.sender,
    })

    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    this.addCash(amount)

    this.accrueMarket()

    let lstDue: uint64 = 0
    const depositBalance = op.AssetHolding.assetBalance(
      Global.currentApplicationAddress,
      this.base_token_id.value.native,
    )
    if (this.total_deposits.value === 0) {
      lstDue = amount
    } else {
      lstDue = this.calculateLSTDue(amount)
    }
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.lst_token_id.value.native,
        assetAmount: lstDue,
        fee: 0,
      })
      .submit()

    this.circulating_lst.value += lstDue
    this.total_deposits.value += amount
    this.last_apr_bps.value = this.current_apr_bps()
    const depositKey = new DepositRecordKey({
      assetId: new UintN64(this.base_token_id.value.native),
      userAddress: new Address(op.Txn.sender),
    })
    if (this.deposit_record(depositKey).exists) {
      const existingRecord = this.deposit_record(depositKey).value.copy()
      const newAmount: uint64 = existingRecord.depositAmount.native + amount
      this.deposit_record(depositKey).value = new DepositRecord({
        assetId: existingRecord.assetId,
        depositAmount: new UintN64(newAmount),
      }).copy()
    } else {
      this.deposit_record(depositKey).value = new DepositRecord({
        assetId: new UintN64(this.base_token_id.value.native),
        depositAmount: new UintN64(amount),
      }).copy()
    }
  }

  /**
   * Withdraws deposited assets by burning LST tokens
   * @param assetTransferTxn - Asset transfer transaction sending LST tokens to the contract
   * @param amount - Amount of LST tokens to burn for withdrawal
   * @param lstAppId - Application ID to determine exchange rate (use current app ID for local rate)
   * @param mbrTxn - Payment transaction covering transaction fees
   * @dev Burns LST tokens and returns proportional amount of underlying assets
   * @dev Exchange rate depends on whether using local or external LST app
   */
  @abimethod({ allowActions: 'NoOp' })
  public withdrawDeposit(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64): void {
    const lstAsset = Asset(this.lst_token_id.value.native)
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: lstAsset,
      assetAmount: amount,
      sender: op.Txn.sender,
    })

    this.accrueMarket()

    //Calculate the return amount of ASA
    let asaDue: uint64 = 0
    asaDue = this.calculateLSTDueLocal(amount)

    this.removeCash(asaDue)

    assert(op.AssetHolding.assetBalance(Global.currentApplicationAddress, this.base_token_id.value.native)[0] >= asaDue)
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.base_token_id.value.native,
        assetAmount: asaDue,
        fee: 0,
      })
      .submit()

    this.circulating_lst.value -= amount // LST burned
    this.total_deposits.value -= asaDue // ASA returned
    this.last_apr_bps.value = this.current_apr_bps()
    const depositKey = new DepositRecordKey({
      assetId: new UintN64(this.base_token_id.value.native),
      userAddress: new Address(op.Txn.sender),
    })
    if (this.deposit_record(depositKey).exists) {
      const existingRecord = this.deposit_record(depositKey).value.copy()

      const newAmount: uint64 =
        asaDue > existingRecord.depositAmount.native ? 0 : existingRecord.depositAmount.native - asaDue
      if (newAmount === 0) {
        this.deposit_record(depositKey).delete()
      } else {
        this.deposit_record(depositKey).value = new DepositRecord({
          assetId: existingRecord.assetId,
          depositAmount: new UintN64(newAmount),
        }).copy()
      }
    }
  }

  /**
   * Borrows base assets against collateral with interest and fees
   * @param assetTransferTxn - Asset transfer transaction depositing collateral to the contract
   * @param requestedLoanAmount - Amount of base tokens requested for borrowing
   * @param collateralAmount - Amount of collateral being deposited
   * @param lstApp - Application ID for LST exchange rate calculation
   * @param collateralTokenId - Asset ID of the collateral being deposited
   * @dev Validates LTV ratio, charges origination fee, and disburses loan amount
   * @dev Supports both new loans and top-ups of existing loans
   * @dev Collateral value determined via oracle pricing and LST exchange rates
   */
  @abimethod({ allowActions: 'NoOp' })
  public borrow(
    assetTransferTxn: gtxn.AssetTransferTxn,
    requestedLoanAmount: uint64,
    collateralAmount: uint64,
    collateralTokenId: UintN64,
  ): void {
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    assert(collateralAmount > 0, 'COLLATERAL_REQUIRED')
    assert(requestedLoanAmount > 0, 'LOAN_AMOUNT_REQUIRED')
    // ─── 0. Determine if this is a top-up or a brand-new loan ─────────────
    const hasLoan = this.loan_record(op.Txn.sender).exists
    this.accrueMarket()
    let collateralToUse: uint64 = 0
    if (hasLoan) {
      const existingCollateral = this.getLoanRecord(op.Txn.sender).collateralAmount
      collateralToUse = existingCollateral.native + collateralAmount
    } else {
      collateralToUse = collateralAmount
    }
    this.validateBorrowRequest(assetTransferTxn, collateralAmount, collateralTokenId)
    const collateralUSD = this.calculateCollateralValueUSD(collateralTokenId, collateralToUse)
    const maxBorrowUSD: uint64 = (collateralUSD * this.ltv_bps.value) / BASIS_POINTS
    const baseTokenOraclePrice: uint64 = this.getOraclePrice(this.base_token_id.value)
    this.validateLoanAmount(requestedLoanAmount, maxBorrowUSD, baseTokenOraclePrice)

    // get flux tier
    let userTier: UintN64 = new UintN64(0)
    if (this.flux_oracle_app.value.id !== 0) {
      userTier = abiCall(FluxGateStub.prototype.getUserTier, {
        appId: this.flux_oracle_app.value.id,
        args: [new Address(op.Txn.sender)],
        sender: Global.currentApplicationAddress,
        fee: 0,
        apps: [this.flux_oracle_app.value],
        accounts: [op.Txn.sender],
      }).returnValue
    }
    const calculatedFee = this.computeFees(requestedLoanAmount, userTier.native)

    const { disbursement } = this.calculateDisbursement(requestedLoanAmount, calculatedFee)

    if (hasLoan) {
      this.processLoanTopUp(op.Txn.sender, collateralAmount, disbursement, maxBorrowUSD, baseTokenOraclePrice, collateralTokenId)
    } else {
      this.mintLoanRecord(disbursement, collateralTokenId, op.Txn.sender, collateralAmount)
      this.updateCollateralTotal(collateralTokenId, collateralAmount)
    }

    this.disburseFunds(op.Txn.sender, disbursement)
    this.removeCash(disbursement)
    this.total_borrows.value = this.total_borrows.value + disbursement
    this.last_apr_bps.value = this.current_apr_bps()
  }

  /**
   * Creates a brand-new loan record for a borrower.
   * @param disbursement Net amount borrowed in base-token units.
   * @param collateralTokenId Asset ID of the collateral locking the loan.
   * @param borrowerAddress Borrower whose account box is mutated.
   * @param collateralAmount Quantity of collateral deposited alongside the loan.
   */
  private mintLoanRecord(
    disbursement: uint64,
    collateralTokenId: UintN64,
    borrowerAddress: Account,
    collateralAmount: uint64,
  ): void {
    const debtChangeArray = new DynamicArray<DebtChange>()

    this.loan_record(borrowerAddress).value = new LoanRecord({
      borrowerAddress: new Address(borrowerAddress),
      collateralTokenId,
      collateralAmount: new UintN64(collateralAmount),
      borrowedTokenId: this.base_token_id.value,
      lastDebtChange: new DebtChange({
        amount: new UintN64(disbursement),
        timestamp: new UintN64(Global.latestTimestamp),
        changeType: new UintN8(0), // borrow
      }),
      principal: new UintN64(disbursement),
      userIndexWad: new UintN64(this.borrow_index_wad.value),
    }).copy()

    this.active_loan_records.value = this.active_loan_records.value + 1
  }

  @abimethod({ allowActions: 'NoOp' })
  public accrueLoanInterest(debtor: Account): void {
    assert(this.loan_record(debtor).exists, 'Loan record does not exist')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    this.accrueMarket()
    // Just roll the borrower snapshot forward
    this.syncBorrowerSnapshot(debtor)
    // No changes to total_deposits or fee_pool here — already handled in accrueMarket()
    this.last_apr_bps.value = this.current_apr_bps()
  }

  // 0..10_000 over the allowed band [0 .. util_cap_bps * deposits]
  /**
   * Calculates utilization normalized to basis points relative to the cap.
   * @returns Utilization between 0 and 10_000 after capping at the configured limit.
   */
  private util_norm_bps(): uint64 {
    const D: uint64 = this.total_deposits.value
    const B: uint64 = this.total_borrows.value
    const cap_bps: uint64 = this.util_cap_bps.value
    if (D === 0) return 0

    // capBorrow = floor(D * util_cap_bps / 10_000)
    const [hiCap, loCap] = mulw(D, cap_bps)
    const capBorrow = divw(hiCap, loCap, BASIS_POINTS)
    if (capBorrow === 0) return 0

    const cappedB = B <= capBorrow ? B : capBorrow
    const [hiN, loN] = mulw(cappedB, BASIS_POINTS)
    return divw(hiN, loN, capBorrow)
  }

  // Kinked APR from normalized utilization
  /**
   * Evaluates the kinked interest-rate curve for a given normalized utilization.
   * @param U_norm_bps Utilization in basis points (0-10_000) after capping logic.
   * @returns APR in basis points produced by the model.
   */
  private apr_bps_kinked(U_norm_bps: uint64): uint64 {
    const base_bps: uint64 = this.base_bps.value
    const kink_norm_bps: uint64 = this.kink_norm_bps.value
    const slope1_bps: uint64 = this.slope1_bps.value
    const slope2_bps: uint64 = this.slope2_bps.value
    let apr: uint64

    if (U_norm_bps <= kink_norm_bps) {
      const [hi1, lo1] = mulw(slope1_bps, U_norm_bps)
      apr = base_bps + divw(hi1, lo1, kink_norm_bps)
    } else {
      const over: uint64 = U_norm_bps - kink_norm_bps
      const denom: uint64 = BASIS_POINTS - kink_norm_bps
      const [hi2, lo2] = mulw(slope2_bps, over)
      apr = base_bps + slope1_bps + divw(hi2, lo2, denom)
    }

    const maxCap: uint64 = this.max_apr_bps.value
    if (maxCap > 0 && apr > maxCap) apr = maxCap
    return apr
  }

  private computeFees(depositAmount: uint64, userTier: uint64): uint64 {
    const initialFee: uint64 = this.origination_fee_bps.value
    let effectiveFeeBps: uint64 = initialFee

    if (userTier === 1) {
      const [hi, lo] = mulw(initialFee, 90)
      effectiveFeeBps = divw(hi, lo, 100)
    } else if (userTier === 2) {
      const [hi, lo] = mulw(initialFee, 75)
      effectiveFeeBps = divw(hi, lo, 100)
    } else if (userTier === 3) {
      const [hi, lo] = mulw(initialFee, 50)
      effectiveFeeBps = divw(hi, lo, 100)
    } else if (userTier >= 4) {
      const [hi, lo] = mulw(initialFee, 25)
      effectiveFeeBps = divw(hi, lo, 100)
    }

    const [feeHi, feeLo] = mulw(depositAmount, effectiveFeeBps)
    const fee: uint64 = divw(feeHi, feeLo, 10_000)
    return fee
  }

  // SINGLE public entrypoint to get the current APR (bps)
  /**
   * Computes the current borrow APR in basis points, applying smoothing and clamps.
   * @returns APR value used for subsequent accrual slices.
   */
  @abimethod({ allowActions: 'NoOp' })
  public current_apr_bps(): uint64 {
    // Compute normalized utilization (0..10_000)
    const U_raw: uint64 = this.util_norm_bps()

    const U_used: uint64 = U_raw // No EMA smoothing for now

    // Model selection (0=kinked; 255=fixed fallback)
    const apr = this.apr_bps_kinked(U_used)

    this.prev_apr_bps.value = apr
    return apr
  }

  // Returns the simple interest factor for this time slice, scaled by INDEX_SCALE.
  // simple = (last_apr_bps / 10_000) * (Δt / SECONDS_PER_YEAR)
  /**
   * Derives the simple-interest slice factor scaled by `INDEX_SCALE` for a time delta.
   * @param deltaT Elapsed seconds since the last accrual.
   * @returns Slice factor in wad precision used to advance indices.
   */
  private sliceFactorWad(deltaT: uint64): uint64 {
    if (deltaT === 0) return 0

    // ratePerYearWad = INDEX_SCALE * last_apr_bps / BASIS_POINTS
    const [hRate, lRate] = mulw(INDEX_SCALE, this.last_apr_bps.value)
    const ratePerYearWad: uint64 = divw(hRate, lRate, BASIS_POINTS)

    // simpleWad = ratePerYearWad * deltaT / SECONDS_PER_YEAR
    const [hSlice, lSlice] = mulw(ratePerYearWad, deltaT)
    const simpleWad: uint64 = divw(hSlice, lSlice, SECONDS_PER_YEAR)
    return simpleWad // e.g., 0.0123 * INDEX_SCALE for a 1.23% slice
  }

  /**
   * Computes the borrower’s live debt using the current borrow index.
   * @param rec Stored loan record snapshot for the borrower.
   * @returns Debt amount in base units respecting the latest index.
   */
  private currentDebtFromSnapshot(rec: LoanRecord): uint64 {
    const p: uint64 = rec.principal.native
    if (p === 0) return 0
    const [hi, lo] = mulw(p, this.borrow_index_wad.value)
    return divw(hi, lo, rec.userIndexWad.native)
  }

  // Roll borrower snapshot forward to "now" without changing what they owe
  /**
   * Resynchronizes a loan record with the current borrow index while preserving history.
   * @param borrower Account whose loan snapshot should be refreshed.
   * @returns Debt amount that was outstanding before the snapshot update.
   */
  private syncBorrowerSnapshot(borrower: Account): uint64 {
    const rec = this.loan_record(borrower).value.copy()
    const liveDebt: uint64 = this.currentDebtFromSnapshot(rec)
    const newRec = new LoanRecord({
      borrowerAddress: new Address(borrower.bytes),
      collateralTokenId: rec.collateralTokenId,
      collateralAmount: rec.collateralAmount,
      borrowedTokenId: this.base_token_id.value,
      lastDebtChange: rec.lastDebtChange.copy(), // keep your audit trail
      principal: new UintN64(liveDebt),
      userIndexWad: new UintN64(this.borrow_index_wad.value),
    })
    this.loan_record(borrower).value = newRec.copy()
    return liveDebt
  }

  // Advances the market from last_accrual_ts → now using the *stored* last_apr_bps.
  // Returns the total interest added to total_borrows for this slice.
  /**
   * Executes market-wide accrual, updating indices, totals, and fee pools.
   * @returns Interest amount added to `total_borrows` during this accrual.
   */
  private accrueMarket(): uint64 {
    const now: uint64 = Global.latestTimestamp
    const last: uint64 = this.last_accrual_ts.value
    if (now <= last) return 0

    const deltaT: uint64 = now - last

    // 1) Compute simple slice factor in INDEX_SCALE
    const simpleWad: uint64 = this.sliceFactorWad(deltaT)
    if (simpleWad === 0) {
      this.last_accrual_ts.value = now
      return 0
    }

    // 2) Update borrow_index_wad: index *= (1 + simple)
    //    newIndex = oldIndex + oldIndex * simpleWad / INDEX_SCALE
    const oldIndex: uint64 = this.borrow_index_wad.value
    const [hiI, loI] = mulw(oldIndex, simpleWad)
    const incrIndex: uint64 = divw(hiI, loI, INDEX_SCALE)
    const newIndex: uint64 = oldIndex + incrIndex
    this.borrow_index_wad.value = newIndex

    // 3) Market-wide interest for this slice:
    //    interest = total_borrows * simple
    // NOTE: at this step we treat total_borrows as the *current aggregate debt*.
    const totalBefore: uint64 = this.total_borrows.value
    let interest: uint64 = 0
    if (totalBefore > 0) {
      const [hiB, loB] = mulw(totalBefore, simpleWad)
      interest = divw(hiB, loB, INDEX_SCALE)
    }

    // 4) Split interest into depositor yield & protocol fee
    const protoBps: uint64 = this.protocol_share_bps.value
    const deposBps: uint64 = BASIS_POINTS - protoBps

    // depositorInterest = interest * deposBps / 10_000
    const [hiD, loD] = mulw(interest, deposBps)
    const depositorInterest: uint64 = divw(hiD, loD, BASIS_POINTS)
    const protocolInterest: uint64 = interest - depositorInterest

    // 5) Apply state updates
    // Borrowers' aggregate debt grows by *full* interest:
    this.total_borrows.value = totalBefore + interest

    // Depositors earn their share as yield (LST exchange rate rises):
    this.total_deposits.value += depositorInterest

    // Protocol takes its fee share:
    this.fee_pool.value += protocolInterest

    // 6) Close the slice
    this.last_accrual_ts.value = now

    // IMPORTANT: We DO NOT recompute last_apr_bps here.
    // That happens *after* state mutations that change utilization (Step 3).
    return interest
  }

  /**
   * Fetches the stored loan record for a borrower (without accrual).
   * @param borrowerAddress Borrower whose record should be returned.
   * @returns Loan record snapshot stored in the box map.
   */
  @abimethod({ allowActions: 'NoOp' })
  public getLoanRecord(borrowerAddress: Account): LoanRecord {
    return this.loan_record(borrowerAddress).value
  }

  /**
   * Repays a loan using ASA tokens and optionally releases collateral
   * @param assetTransferTxn - Asset transfer transaction sending repayment tokens to contract
   * @param amount - Amount of base tokens being repaid
   * @param templateReserveAddress - Reserve address for potential future use
   * @dev Accrues interest before processing repayment
   * @dev Full repayment closes loan and returns all collateral
   * @dev Partial repayment updates remaining debt amount
   * @dev Overpayments are automatically refunded to the sender
   */
  @abimethod({ allowActions: 'NoOp' })
  public repayLoanASA(assetTransferTxn: gtxn.AssetTransferTxn, repaymentAmount: uint64): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: baseToken,
      assetAmount: repaymentAmount,
      sender: op.Txn.sender,
    })
    this.accrueMarket()

    const rec = this.getLoanRecord(op.Txn.sender)
    const liveDebt: uint64 = this.currentDebtFromSnapshot(rec)
    // Borrower-level repayment is capped to their live debt; global subtraction is saturation-protected.
    const repayUsed: uint64 = repaymentAmount <= liveDebt ? repaymentAmount : liveDebt
    const refundAmount: uint64 = repaymentAmount - repayUsed
    const remainingDebt: uint64 = liveDebt - repayUsed
    const totalBorrowDelta: uint64 = repayUsed <= this.total_borrows.value ? repayUsed : this.total_borrows.value

    // Market aggregate falls by amount repaid (principal or interest, we don’t care here)
    this.total_borrows.value -= totalBorrowDelta
    this.addCash(repaymentAmount)

    if (refundAmount > 0) {
      itxn
        .assetTransfer({
          assetReceiver: op.Txn.sender,
          xferAsset: baseToken,
          assetAmount: refundAmount,
          fee: STANDARD_TXN_FEE,
        })
        .submit()
      this.removeCash(refundAmount)
    }

    if (remainingDebt === 0) {
      this.reduceCollateralTotal(rec.collateralTokenId, rec.collateralAmount.native)
      this.loan_record(op.Txn.sender).delete()
      this.active_loan_records.value -= 1

      itxn
        .assetTransfer({
          assetReceiver: op.Txn.sender,
          xferAsset: rec.collateralTokenId.native,
          assetAmount: rec.collateralAmount.native,
          fee: STANDARD_TXN_FEE,
        })
        .submit()
    } else {
      // Roll snapshot after repay
      this.loan_record(op.Txn.sender).value = new LoanRecord({
        borrowerAddress: new Address(op.Txn.sender.bytes),
        collateralTokenId: rec.collateralTokenId,
        collateralAmount: rec.collateralAmount,
        borrowedTokenId: this.base_token_id.value,
        lastDebtChange: new DebtChange({
          amount: new UintN64(repayUsed),
          timestamp: new UintN64(Global.latestTimestamp),
          changeType: new UintN8(2), // repay
        }),
        principal: new UintN64(remainingDebt),
        userIndexWad: new UintN64(this.borrow_index_wad.value),
      }).copy()
    }
  }

  /**
   * Withdraws accumulated protocol fees and commission to the admin-controlled account.
   * @param paymentReceiver Address receiving the payout.
   * @param feeTxn Separate payment covering inner-transaction fees.
   */
  @abimethod({ allowActions: 'NoOp' })
  public withdrawPlatformFees(): void {
    assert(op.Txn.sender === this.fee_admin.value, 'UNAUTHORIZED')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')

    const payout: uint64 = this.fee_pool.value + this.current_accumulated_commission.value
    if (payout > 0) {
      itxn
        .assetTransfer({
          assetReceiver: this.fee_admin.value,
          xferAsset: this.base_token_id.value.native,
          assetAmount: payout,
          fee: 0,
        })
        .submit()

      this.removeCash(payout)
      this.fee_pool.value = 0
      this.current_accumulated_commission.value = 0
    }
  }

  /**
   * Purchases a borrower's collateral at a premium when loan is below liquidation threshold
   * @param buyer - Account that will receive the collateral
   * @param debtor - Account whose loan is being bought out
   * @param axferTxn - Asset transfer transaction with buyout payment
   * @dev Buyout price includes premium based on how far below liquidation threshold the LTV sits
   * @dev Only available when loan LTV is strictly below the liquidation threshold
   * @dev Closes the loan and transfers collateral to buyer
   */
  @abimethod({ allowActions: 'NoOp' })
  public buyoutSplitASA(
    buyer: Account,
    debtor: Account,
    premiumAxferTxn: gtxn.AssetTransferTxn, // buyout token (xUSD) PREMIUM
    repayAxferTxn: gtxn.AssetTransferTxn, // BASE TOKEN (ASA) full DEBT
  ): void {
    assert(this.loan_record(debtor).exists, 'NO_LOAN_RECORD')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')

    // 1) Make time current
    this.accrueMarket()

    // 2) Load state
    const rec = this.loan_record(debtor).value.copy()
    const collateralAmount: uint64 = rec.collateralAmount.native
    const collateralTokenId: UintN64 = rec.collateralTokenId

    // Live debt (base token units)
    const debtBase: uint64 = this.currentDebtFromSnapshot(rec)
    assert(debtBase > 0, 'NO_DEBT')

    // 3) USD legs
    const collateralUSD: uint64 = this.calculateCollateralValueUSD(collateralTokenId, collateralAmount)
    const debtUSDv: uint64 = this.debtUSD(debtBase)
    assert(debtUSDv > 0, 'BAD_DEBT_USD')
    assert(collateralUSD > 0, 'BAD_COLLATERAL_USD')

    // LTV in bps
    const [hLTV, lLTV] = mulw(debtUSDv, BASIS_POINTS)
    const ltvBps: uint64 = divw(hLTV, lLTV, collateralUSD)

    // Premium rate (bps), clamped at 0 when at/above threshold
    assert(ltvBps < this.liq_threshold_bps.value, 'NOT_BUYOUT_ELIGIBLE')

    const [hR, lR] = mulw(this.liq_threshold_bps.value, BASIS_POINTS)
    const ratio_bps: uint64 = divw(hR, lR, ltvBps) // > 10_000 if ltvBps < thresh
    const premiumRateBps: uint64 = ratio_bps - BASIS_POINTS

    // Premium (USD)
    const [hP, lP] = mulw(collateralUSD, premiumRateBps)
    const premiumUSD: uint64 = divw(hP, lP, BASIS_POINTS)

    // 4) Convert premium USD → buyout token amount
    const buyoutTokenId: uint64 = this.buyout_token_id.value.native
    const buyoutTokenPrice: uint64 = this.getOraclePrice(this.buyout_token_id.value) // µUSD per token

    const premiumTokens: uint64 =
      buyoutTokenPrice === 0 ? 0 : this.usdToAmount(premiumUSD, buyoutTokenPrice, this.buyout_token_decimals.value)

    assert(premiumAxferTxn.sender === op.Txn.sender, 'BAD_PREMIUM_SENDER')
    assert(premiumAxferTxn.assetReceiver === Global.currentApplicationAddress, 'INVALID_RECEIVER')
    assert(premiumAxferTxn.xferAsset === Asset(buyoutTokenId), 'INVALID_XFER_ASSET')
    assert(premiumAxferTxn.assetAmount >= premiumTokens, 'INVALID_BUYOUT_AMOUNT')

    const paidAmount: uint64 = premiumAxferTxn.assetAmount
    const refund: uint64 = paidAmount - premiumTokens

    // 5) Debt repayment in market base token (ASA)
    const baseAssetId = this.base_token_id.value.native
    assert(repayAxferTxn.sender === op.Txn.sender, 'BAD_REPAY_SENDER')
    assert(repayAxferTxn.assetReceiver === Global.currentApplicationAddress, 'BAD_REPAY_RECEIVER')
    assert(repayAxferTxn.xferAsset === Asset(baseAssetId), 'BAD_REPAY_ASSET')
    assert(repayAxferTxn.assetAmount >= debtBase, 'INSUFFICIENT_REPAY')
    const repayRefund: uint64 = repayAxferTxn.assetAmount - debtBase

    // 6) Close loan & transfer collateral
    this.loan_record(debtor).delete()
    this.active_loan_records.value = this.active_loan_records.value - 1

    itxn
      .assetTransfer({
        assetReceiver: buyer,
        xferAsset: collateralTokenId.native,
        assetAmount: collateralAmount,
        fee: 0,
      })
      .submit()

    // Update collateral totals
    const acKey = new AcceptedCollateralKey({ assetId: collateralTokenId })
    const acVal = this.accepted_collaterals(acKey).value.copy()
    const updatedTotal: uint64 = acVal.totalCollateral.native - collateralAmount
    this.accepted_collaterals(acKey).value = new AcceptedCollateral({
      assetId: acVal.assetId,
      baseAssetId: acVal.baseAssetId,
      baseAssetDecimals: acVal.baseAssetDecimals,
      totalCollateral: new UintN64(updatedTotal),
      marketBaseAssetId: acVal.marketBaseAssetId,
      marketBaseAssetDecimals: acVal.marketBaseAssetDecimals,
      originatingAppId: acVal.originatingAppId,
    }).copy()

    // Market aggregates
    const borrowDelta: uint64 = debtBase <= this.total_borrows.value ? debtBase : this.total_borrows.value
    this.total_borrows.value = this.total_borrows.value - borrowDelta
    this.addCash(repayAxferTxn.assetAmount)

    // 7) Split the received premium (in buyout token units)
    this.splitPremium(premiumTokens, buyoutTokenId, debtor)

    if (refund > 0) {
      itxn
        .assetTransfer({
          assetReceiver: buyer,
          xferAsset: buyoutTokenId,
          assetAmount: refund,
          fee: 0,
        })
        .submit()
      if (buyoutTokenId === this.base_token_id.value.native) {
        this.removeCash(refund)
      }
    }

    if (repayRefund > 0) {
      itxn
        .assetTransfer({
          assetReceiver: buyer,
          xferAsset: baseAssetId,
          assetAmount: repayRefund,
          fee: 0,
        })
        .submit()
      this.removeCash(repayRefund)
    }

    // 8) Set next-slice APR
    this.last_apr_bps.value = this.current_apr_bps()
  }

  /**
   * Splits buyout premium payments evenly between the protocol and the original borrower.
   * @param premiumTokens Total premium paid in the buyout token.
   * @param buyoutTokenId Asset ID of the premium token (e.g., xUSD).
   * @param debtor Borrower whose collateral was bought out.
   */
  private splitPremium(premiumTokens: uint64, buyoutTokenId: uint64, debtor: Account) {
    // split premium payments 50/50 between protocol and original borrower
    const halfPremium: uint64 = premiumTokens / 2
    // pay protocol half
    itxn
      .assetTransfer({
        assetReceiver: this.fee_admin.value,
        xferAsset: buyoutTokenId,
        assetAmount: halfPremium,
        fee: 0,
      })
      .submit()
    // pay original borrower half
    itxn
      .assetTransfer({
        assetReceiver: debtor,
        xferAsset: buyoutTokenId,
        assetAmount: premiumTokens - halfPremium, // cover odd token if any
        fee: 0,
      })
      .submit()
  }

  /**
   * Converts a base-token debt amount into USD micro-units using the oracle price.
   * @param debtBaseUnits Debt amount measured in base-token micro units.
   * @returns Equivalent value denominated in USD micro-units.
   */
  private debtUSD(debtBaseUnits: uint64): uint64 {
    const baseTokenPrice: uint64 = this.getOraclePrice(this.base_token_id.value) // price of market base token
    return this.amountToUsd(debtBaseUnits, baseTokenPrice, this.base_token_decimals.value)
  }

  /**
   * Computes how much LST collateral a borrower can withdraw using live market data.
   * Shared by both the public ABI and internal calls to avoid duplication.
   * @param borrower Account whose collateral capacity is being evaluated.
   * @param lstAppId External LST app backing the collateral.
   * @returns Maximum withdrawable LST amount.
   */
  private computeMaxWithdrawableCollateralLST(borrower: Account): uint64 {
    assert(this.loan_record(borrower).exists, 'NO_LOAN')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    this.accrueMarket()

    const rec = this.loan_record(borrower).value.copy()
    const collateral = this.getCollateral(rec.collateralTokenId)
    const debtBase: uint64 = this.currentDebtFromSnapshot(rec)
    if (debtBase === 0) return rec.collateralAmount.native // all collateral is withdrawable if no debt

    // Current collateral USD (before any withdrawal)
    const currCollatUSD: uint64 = this.calculateCollateralValueUSD(rec.collateralTokenId, rec.collateralAmount.native)

    // Required collateral USD to satisfy LTV: debtUSD <= collatUSD * LTV
    const debtUSDv: uint64 = this.debtUSD(debtBase)
    // requiredCollateralUSD = ceil(debtUSD * 10_000 / ltv_bps)
    const [hReq, lReq] = mulw(debtUSDv, BASIS_POINTS)
    const requiredCollateralUSD: uint64 = divw(hReq, lReq, this.ltv_bps.value)

    // If we’re already below requirement (shouldn’t happen), nothing is withdrawable
    if (currCollatUSD <= requiredCollateralUSD) return 0

    // Max removable USD
    const removableUSD: uint64 = currCollatUSD - requiredCollateralUSD

    // Convert removable USD → underlying base units → LST amount
    // Pull LST exchange data
    const circulatingLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: collateral.originatingAppId.native,
      fee: 0,
    }).returnValue
    const totalDeposits = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: collateral.originatingAppId.native,
      fee: 0,
    }).returnValue

    // Base token price for this LST’s underlying
    const ac = this.getCollateral(rec.collateralTokenId)
    const basePrice = this.getOraclePrice(ac.baseAssetId)

    // underlying = removableUSD * 1e6 / basePrice
    const removableUnderlying: uint64 = this.usdToAmount(removableUSD, basePrice, ac.baseAssetDecimals.native)

    // LST = underlying * circulating / totalDeposits
    const [hL, lL] = mulw(removableUnderlying, circulatingLST)
    const removableLST: uint64 = divw(hL, lL, totalDeposits)

    return removableLST
  }

  /**
   * Computes how much LST collateral the caller can withdraw using live market data.
   * @param lstAppId External LST app backing the collateral.
   * @returns Maximum withdrawable LST balance for the borrower.
   */
  @abimethod({ allowActions: 'NoOp' })
  public maxWithdrawableCollateralLST(): uint64 {
    return this.computeMaxWithdrawableCollateralLST(op.Txn.sender)
  }

  /**
   * Allows borrowers to withdraw a portion of their collateral within safety limits.
   * @param amountLST Amount of LST being withdrawn.
   * @param collateralTokenId Asset ID of the collateral LST.
   * @param lstAppId LST application ID used for exchange-rate validation.
   */
  @abimethod({ allowActions: 'NoOp' })
  public withdrawCollateral(amountLST: uint64, collateralTokenId: uint64): void {
    assert(amountLST > 0, 'ZERO_AMOUNT')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    const borrower = op.Txn.sender
    assert(this.loan_record(borrower).exists, 'NO_LOAN')
    this.accrueMarket() // 1) make time current for everyone
    const loan = this.loan_record(borrower).value.copy()

    assert(loan.collateralTokenId.native === collateralTokenId, 'WRONG_COLLATERAL')
    // 2) Validate collateral type
    const acKey = new AcceptedCollateralKey({ assetId: new UintN64(collateralTokenId) })
    assert(this.accepted_collaterals(acKey).exists, 'BAD_COLLATERAL')
    const acVal = this.accepted_collaterals(acKey).value.copy()

    const maxSafe = this.computeMaxWithdrawableCollateralLST(borrower)
    assert(amountLST <= maxSafe, 'EXCEEDS_LIMITS')
    assert(amountLST < loan.collateralAmount.native, 'INSUFFICIENT_COLLATERAL')
    const remainLST: uint64 = loan.collateralAmount.native - amountLST

    // 5) Safe: perform transfer of LST back to borrower
    itxn
      .assetTransfer({
        assetReceiver: borrower,
        xferAsset: collateralTokenId, // LST ASA
        assetAmount: amountLST,
        fee: 0,
      })
      .submit()

    // 6) Update storage
    const newRec = new LoanRecord({
      borrowerAddress: new Address(borrower.bytes),
      collateralTokenId: new UintN64(collateralTokenId),
      collateralAmount: new UintN64(remainLST),
      borrowedTokenId: this.base_token_id.value,
      lastDebtChange: new DebtChange({
        amount: new UintN64(amountLST),
        timestamp: new UintN64(Global.latestTimestamp),
        changeType: new UintN8(3), // 3 = collateral withdraw
      }),
      principal: loan.principal, // unchanged
      userIndexWad: loan.userIndexWad, // unchanged snapshot; no debt change here
    })
    this.loan_record(borrower).value = newRec.copy()

    // 7) Track global collateral totals (optional if you maintain them)
    this.reduceCollateralTotal(loan.collateralTokenId, amountLST)

    // 8) Recompute next rate for subsequent slice (utilization may change only if this affects borrows/deposits; harmless to do)
    this.last_apr_bps.value = this.current_apr_bps()
  }
  /**
   * Converts a USD seize value into an LST amount while capping to available collateral.
   * @param seizeUSD USD value of collateral that should be seized (with bonus).
   * @param collateralTokenId LST asset representing the collateral.
   * @param lstAppId External LST app used for exchange-rate lookups.
   * @param availableLST Total LST currently pledged for the borrower.
   * @returns LST amount that can be safely seized.
   */
  private seizeLSTFromUSD(
    seizeUSD: uint64,
    collateralTokenId: UintN64,
    lstAppId: uint64,
    availableLST: uint64,
  ): uint64 {
    // USD -> underlying base units
    const underlyingPrice = this.getOraclePrice(this.getCollateral(collateralTokenId).baseAssetId) // µUSD
    const seizeUnderlying: uint64 = this.usdToAmount(
      seizeUSD,
      underlyingPrice,
      this.getCollateral(collateralTokenId).baseAssetDecimals.native,
    )

    const collateral = this.getCollateral(collateralTokenId)
    assert(collateral.originatingAppId.native === lstAppId, 'mismatched LST app')

    // underlying -> LST via (underlying * circulating / totalDeposits)
    const circ = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstAppId,
      fee: STANDARD_TXN_FEE,
    }).returnValue
    const total = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstAppId,
      fee: STANDARD_TXN_FEE,
    }).returnValue
    const [hL, lL] = mulw(seizeUnderlying, circ)
    let seizeLST: uint64 = divw(hL, lL, total)

    if (seizeLST > availableLST) seizeLST = availableLST
    return seizeLST
  }

  private repayBaseFromSeizedLST(
    seizeLST: uint64,
    collateralTokenId: UintN64,
    lstAppId: uint64,
    bonusBps: uint64,
    basePrice: uint64,
  ): uint64 {
    if (seizeLST === 0) return 0

    const collateral = this.getCollateral(collateralTokenId)
    assert(collateral.originatingAppId.native === lstAppId, 'mismatched LST app')

    const circ = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstAppId,
      fee: STANDARD_TXN_FEE,
    }).returnValue
    const total = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstAppId,
      fee: STANDARD_TXN_FEE,
    }).returnValue
    const [hUnderlying, lUnderlying] = mulw(seizeLST, total)
    const seizedUnderlying: uint64 = divw(hUnderlying, lUnderlying, circ)

    const underlyingPrice = this.getOraclePrice(collateral.baseAssetId) // µUSD
    const seizeUSDActual: uint64 = this.amountToUsd(seizedUnderlying, underlyingPrice, collateral.baseAssetDecimals.native)

    const [hRepayUSD, lRepayUSD] = mulw(seizeUSDActual, BASIS_POINTS)
    const repayUSD: uint64 = divw(hRepayUSD, lRepayUSD, BASIS_POINTS + bonusBps)

    const repayBase: uint64 = this.usdToAmount(repayUSD, basePrice, this.base_token_decimals.value)

    return repayBase
  }

  /**
   * Liquidates an undercollateralized loan by repaying debt and claiming collateral
   * @param debtor - Account whose loan is being liquidated
   * @param axferTxn - Asset transfer transaction with full debt repayment
   * @dev Only available when loan LTV meets or exceeds the liquidation threshold
   * @dev Liquidator must repay full debt amount to claim all collateral
   * @dev Closes the loan and transfers collateral to liquidator
   */
  @abimethod({ allowActions: 'NoOp' })
  public liquidatePartialASA(
    debtor: Account,
    repayAxfer: gtxn.AssetTransferTxn, // liquidator pays base token (ASA)
    repayBaseAmount: uint64, // requested repay in base units (can be >= live debt; excess refunded)
    lstAppId: uint64, // LST app backing the collateral
  ): void {
    assert(this.loan_record(debtor).exists, 'NO_LOAN')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    this.accrueMarket()

    const rec = this.loan_record(debtor).value.copy()
    const collTok: UintN64 = rec.collateralTokenId
    const collLSTBal: uint64 = rec.collateralAmount.native
    const liveDebt: uint64 = this.currentDebtFromSnapshot(rec)
    assert(liveDebt > 0, 'NO_DEBT')
    assert(repayBaseAmount > 0, 'BAD_REPAY')

    // USD legs (for liquidatability & seize math)
    const collateralUSD: uint64 = this.calculateCollateralValueUSD(collTok, collLSTBal)
    const debtUSDv: uint64 = this.debtUSD(liveDebt)
    assert(debtUSDv > 0, 'BAD_DEBT_USD')
    assert(collateralUSD > 0, 'BAD_COLLATERAL_USD')

    // LTV_bps = debtUSD * 10_000 / collateralUSD
    const [hLTV, lLTV] = mulw(debtUSDv, BASIS_POINTS)
    const ltvBps: uint64 = divw(hLTV, lLTV, collateralUSD)
    assert(ltvBps >= this.liq_threshold_bps.value, 'NOT_LIQUIDATABLE')

    // Validate repayment transfer (ASA base token)
    const baseAssetId = this.base_token_id.value.native
    assert(repayAxfer.sender === op.Txn.sender, 'BAD_REPAY_SENDER')
    assert(repayAxfer.assetReceiver === Global.currentApplicationAddress, 'BAD_REPAY_RECEIVER')
    assert(repayAxfer.xferAsset === Asset(baseAssetId), 'BAD_REPAY_ASSET')
    assert(repayAxfer.assetAmount >= repayBaseAmount, 'INSUFFICIENT_REPAY')
    const repayRequested: uint64 = repayAxfer.assetAmount

    // Seize value with bonus: seizeUSD = repayUSD * (1 + bonus)
    const basePrice = this.getOraclePrice(this.base_token_id.value) // µUSD
    const isFullRepayRequest = repayRequested >= liveDebt
    let bonusBps: uint64 = this.dynamicLiqBonusBps(ltvBps)

    let repayCandidate: uint64 = repayRequested > liveDebt ? liveDebt : repayRequested

    const repayUSDcandidate: uint64 =
      repayCandidate === 0
        ? 0
        : this.amountToUsd(repayCandidate, basePrice, this.base_token_decimals.value)
    if (collateralUSD <= debtUSDv && !isFullRepayRequest) {
      assert(false, 'FULL_REPAY_REQUIRED')
    }
    if (repayUSDcandidate > 0) {
      if (collateralUSD <= debtUSDv) {
        bonusBps = 0
      } else {
        const gapUSD: uint64 = collateralUSD - debtUSDv
        const [hCap, lCap] = mulw(gapUSD, BASIS_POINTS)
        const bonusCap: uint64 = divw(hCap, lCap, repayUSDcandidate)
        if (bonusCap < bonusBps) bonusBps = bonusCap
      }
    }
    if (bonusBps > this.liq_bonus_bps.value) bonusBps = this.liq_bonus_bps.value

    // Cap repay so seizeUSD does not exceed available collateral (avoid seizing 100% in a partial).
    if (!isFullRepayRequest && bonusBps < BASIS_POINTS * 10) {
      const [hMaxUsd, lMaxUsd] = mulw(collateralUSD, BASIS_POINTS)
      const maxRepayUSDForCollateral: uint64 = divw(hMaxUsd, lMaxUsd, BASIS_POINTS + bonusBps)
      const maxRepayBaseForCollateral: uint64 = this.usdToAmount(
        maxRepayUSDForCollateral,
        basePrice,
        this.base_token_decimals.value,
      )
      if (repayCandidate > maxRepayBaseForCollateral) repayCandidate = maxRepayBaseForCollateral
    }

    const repayUSD: uint64 = this.amountToUsd(repayCandidate, basePrice, this.base_token_decimals.value)

    const [hSZ, lSZ] = mulw(repayUSD, BASIS_POINTS + bonusBps)
    const seizeUSD: uint64 = divw(hSZ, lSZ, BASIS_POINTS)

    // USD -> LST (cap to available)
    const seizeLST: uint64 = this.seizeLSTFromUSD(seizeUSD, collTok, lstAppId, collLSTBal)
    assert(seizeLST > 0, 'NOTHING_TO_SEIZE')

    let repaySupported: uint64 = this.repayBaseFromSeizedLST(seizeLST, collTok, lstAppId, bonusBps, basePrice)
    if (repaySupported > liveDebt) {
      repaySupported = liveDebt
    }

    if (seizeLST === collLSTBal) {
      // Lift close factor cap when wiping the position.
      repayCandidate = repayRequested
    }

    const proposedRepayUsed: uint64 = repayCandidate <= repaySupported ? repayCandidate : repaySupported

    if (!isFullRepayRequest && seizeLST === collLSTBal && proposedRepayUsed < liveDebt) {
      assert(false, 'FULL_REPAY_REQUIRED')
    }

    const repayUsed: uint64 = isFullRepayRequest
      ? repayRequested <= liveDebt
        ? repayRequested
        : liveDebt
      : proposedRepayUsed
    assert(repayUsed > 0, 'ZERO_REPAY_USED')
    const refundAmount: uint64 = repayRequested - repayUsed

    const remainingLST: uint64 = collLSTBal - seizeLST
    const newDebtBase: uint64 = liveDebt - repayUsed

    // Transfer seized collateral to liquidator
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: collTok.native,
        assetAmount: seizeLST,
        fee: 0,
      })
      .submit()

    // Update aggregates
    this.reduceCollateralTotal(collTok, seizeLST)
    const borrowDelta: uint64 = repayUsed <= this.total_borrows.value ? repayUsed : this.total_borrows.value
    this.total_borrows.value = this.total_borrows.value - borrowDelta
    this.addCash(repayRequested)

    if (refundAmount > 0) {
      itxn
        .assetTransfer({
          assetReceiver: op.Txn.sender,
          xferAsset: baseAssetId,
          assetAmount: refundAmount,
          fee: 0,
        })
        .submit()
      this.removeCash(refundAmount)
    }

    if (newDebtBase === 0) {
      // Close loan and return any leftover collateral to debtor
      if (remainingLST > 0) {
        itxn
          .assetTransfer({
            assetReceiver: debtor,
            xferAsset: collTok.native,
            assetAmount: remainingLST,
            fee: 0,
          })
          .submit()
        this.reduceCollateralTotal(collTok, remainingLST)
      }
      this.loan_record(debtor).delete()
      this.active_loan_records.value = this.active_loan_records.value - 1
    } else {
      // Resnapshot borrower at current index; keep leftover collateral locked
      const newRec = new LoanRecord({
        borrowerAddress: rec.borrowerAddress,
        collateralTokenId: rec.collateralTokenId,
        collateralAmount: new UintN64(remainingLST),
        borrowedTokenId: this.base_token_id.value,
        principal: new UintN64(newDebtBase),
        userIndexWad: new UintN64(this.borrow_index_wad.value),
        lastDebtChange: new DebtChange({
          amount: new UintN64(repayUsed),
          timestamp: new UintN64(Global.latestTimestamp),
          changeType: new UintN8(4), // 4 = liquidation repay
        }),
      })
      this.loan_record(debtor).value = newRec.copy()
    }

    this.last_apr_bps.value = this.current_apr_bps()
  }

  @abimethod({ allowActions: 'NoOp' })
  gas(): void {}

  /**
   * Performs stateless validation of a borrow request’s collateral transfer and fees.
   * @param assetTransferTxn Collateral transfer backing the borrow.
   * @param collateralAmount Amount of collateral pledged.
   * @param collateralTokenId Asset ID of the collateral LST.
   * @param mbrTxn Payment covering additional box storage fees.
   */
  private validateBorrowRequest(
    assetTransferTxn: gtxn.AssetTransferTxn,
    collateralAmount: uint64,
    collateralTokenId: UintN64,
  ): void {
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: collateralAmount,
      xferAsset: Asset(collateralTokenId.native),
      sender: op.Txn.sender,
    })

    assert(this.collateralExists(collateralTokenId), 'unsupported collateral')
  }

  /**
   * Calculates the USD value of a collateral position using the LST exchange rate and oracle price.
   * @param collateralTokenId LST asset representing the collateral.
   * @param collateralAmount Amount of LST units held.
   * @param lstApp LST application ID supplying exchange-rate data.
   * @returns Collateral value denominated in USD micro-units.
   */
  public calculateCollateralValueUSD(collateralTokenId: UintN64, collateralAmount: uint64): uint64 {
    // get collateral and check inputs match
    assert(this.collateralExists(collateralTokenId), 'unknown collateral')
    const collateralInfo = this.getCollateral(collateralTokenId)
    // 1) Get LST exchange rate: (totalDeposits / circulatingLST)
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: collateralInfo.originatingAppId.native,
      fee: 0,
    }).returnValue

    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: collateralInfo.originatingAppId.native,
      fee: 0,
    }).returnValue

    // underlyingCollateral = (collateralAmount * totalDeposits) / circulatingLST
    const [hC, lC] = mulw(totalDepositsExternal, collateralAmount)
    const underlyingCollateral = divw(hC, lC, circulatingExternalLST)

    // 2) Get oracle price of the *base token*, not the LST itself
    const lstCollateral = this.getCollateral(collateralTokenId)
    const baseTokenId = lstCollateral.baseAssetId

    const baseTokenPrice = this.getOraclePrice(baseTokenId)

    // 3) Convert underlying collateral → USD
    const collateralUSD = this.amountToUsd(underlyingCollateral, baseTokenPrice, lstCollateral.baseAssetDecimals.native)

    return collateralUSD
  }

  /**
   * Validates a requested loan amount against LTV and utilization caps.
   * @param requestedLoanAmount Loan amount expressed in base-token units.
   * @param maxBorrowUSD USD borrowing limit derived from collateral.
   * @param baseTokenOraclePrice Oracle price for the base token.
   * @returns Requested loan converted to USD micro-units.
   */
  private validateLoanAmount(requestedLoanAmount: uint64, maxBorrowUSD: uint64, baseTokenOraclePrice: uint64): uint64 {
    // Convert requested loan to USD
    assert(baseTokenOraclePrice > 0, 'invalid base token price')
    const requestedLoanUSD = this.amountToUsd(requestedLoanAmount, baseTokenOraclePrice, this.base_token_decimals.value)

    assert(requestedLoanUSD <= maxBorrowUSD, 'exceeds LTV limit')
    const capBorrow = this.capBorrowLimit() // e.g., deposits * util_cap / 10_000
    assert(this.total_borrows.value + requestedLoanAmount <= capBorrow, 'UTIL_CAP_EXCEEDED')

    return requestedLoanUSD
  }

  /**
   * Computes the protocol-level borrow cap based on current deposits and utilization limit.
   * @returns Maximum allowable aggregate borrow amount in base units.
   */
  private capBorrowLimit(): uint64 {
    const [h, l] = mulw(this.total_deposits.value, this.util_cap_bps.value)
    return divw(h, l, BASIS_POINTS)
  }

  /**
   * Splits a requested borrow amount into net disbursement and protocol fee.
   * @param requestedAmount Total amount requested by the borrower.
   * @param calculatedFee Fee amount computed for this borrow.
   * @returns Struct containing net disbursement and fee portion.
   */
  private calculateDisbursement(requestedAmount: uint64, calculatedFee: uint64): { disbursement: uint64; fee: uint64 } {
    const disbursement: uint64 = requestedAmount - calculatedFee

    this.fee_pool.value += calculatedFee

    return { disbursement, fee: calculatedFee }
  }

  /**
   * Handles top-up logic when an existing borrower draws additional funds.
   * @param borrower Borrower account being updated.
   * @param collateralAmount Additional collateral being deposited.
   * @param disbursement Net new principal issued.
   * @param maxBorrowUSD Maximum borrowable USD post top-up.
   * @param baseTokenOraclePrice Oracle price for the base token.
   * @param requestedLoanAmount Requested delta in base units.
   * @param collateralTokenId Collateral asset identifier.
   */
  private processLoanTopUp(
    borrower: Account,
    collateralAmount: uint64,
    disbursement: uint64,
    maxBorrowUSD: uint64,
    baseTokenOraclePrice: uint64,
    collateralTokenId: UintN64,
  ): void {
    const existingLoan = this.getLoanRecord(borrower)
    // 1) Bring borrower snapshot current (uses global index)
    const liveDebt: uint64 = this.syncBorrowerSnapshot(borrower)

    // 2) Enforce cumulative LTV on the post-top-up debt.
    const oldLoanUSD = this.amountToUsd(liveDebt, baseTokenOraclePrice, this.base_token_decimals.value)
    const newLoanUSD = this.amountToUsd(disbursement, baseTokenOraclePrice, this.base_token_decimals.value)
    const totalLoanUSD: uint64 = oldLoanUSD + newLoanUSD
    assert(totalLoanUSD <= maxBorrowUSD, 'exceeds LTV limit')

    // 3) Add new principal
    const newDebt: uint64 = liveDebt + disbursement

    // 4) Update borrower snapshot after the top-up
    this.loan_record(borrower).value = new LoanRecord({
      borrowerAddress: new Address(borrower.bytes),
      collateralTokenId: existingLoan.collateralTokenId,
      collateralAmount: new UintN64(existingLoan.collateralAmount.native + collateralAmount),
      borrowedTokenId: this.base_token_id.value,
      lastDebtChange: new DebtChange({
        amount: new UintN64(disbursement),
        timestamp: new UintN64(Global.latestTimestamp),
        changeType: new UintN8(0), // borrow
      }),
      principal: new UintN64(newDebt),
      userIndexWad: new UintN64(this.borrow_index_wad.value),
    }).copy()

    // 6) Update collateral running total
    this.updateCollateralTotal(collateralTokenId, collateralAmount)
  }
  /**
   * Sends base-token funds to the borrower via inner transactions.
   * @param borrower Borrower receiving the funds.
   * @param amount Amount of base asset to disburse.
   */
  private disburseFunds(borrower: Account, amount: uint64): void {
    itxn
      .assetTransfer({
        assetReceiver: borrower,
        xferAsset: this.base_token_id.value.native,
        assetAmount: amount,
        fee: STANDARD_TXN_FEE,
      })
      .submit()
  }

  /**
   * Harvests newly accrued rewards for ASA-based markets.
   */
  @abimethod({ allowActions: 'NoOp' })
  pickupASARewards(): void {
    assert(op.Txn.sender === this.fee_admin.value, 'Only admin can pickup rewards')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')

    const baseAsset = Asset(this.base_token_id.value.native)
    const assetBalance = baseAsset.balance(Global.currentApplicationAddress)

    if (assetBalance <= this.cash_on_hand.value) {
      return // nothing new arrived
    }

    const rawReward: uint64 = assetBalance - this.cash_on_hand.value
    if (rawReward <= MINIMUM_ADDITIONAL_REWARD) {
      return
    }

    this.addCash(rawReward)

    const [hi, lo] = mulw(rawReward, this.commission_percentage.value)
    const commission: uint64 = divw(hi, lo, 100)

    this.current_accumulated_commission.value += commission
    this.total_commission_earned.value += commission

    const netReward: uint64 = rawReward - commission
    this.total_additional_rewards.value += netReward
    this.total_deposits.value += netReward
  }

  /**
   * Increases tracked cash-on-hand when base tokens enter the contract.
   * @param amount Base-token amount to add to the ledger mirror.
   */
  private addCash(amount: uint64): void {
    this.cash_on_hand.value = this.cash_on_hand.value + amount
  }

  /**
   * Decreases tracked cash-on-hand when the contract emits base tokens.
   * @param amount Base-token amount to deduct from the ledger mirror.
   * @dev Reverts if the contract lacks sufficient tracked cash.
   */
  private removeCash(amount: uint64): void {
    assert(this.cash_on_hand.value >= amount, 'INSUFFICIENT_CASH')
    this.cash_on_hand.value = this.cash_on_hand.value - amount
  }
}

export abstract class TargetContract extends Contract {
  @abimethod()
  getCirculatingLST(): uint64 {
    // Stub implementation
    err('stub only')
  }
  @abimethod()
  getTotalDeposits(): uint64 {
    // Stub implementation
    err('stub only')
  }
}

export abstract class PriceOracleStub extends Contract {
  @abimethod({ allowActions: 'NoOp' })
  getTokenPrice(assetId: UintN64): TokenPrice {
    err('stub only')
  }
}

export abstract class FluxGateStub extends Contract {
  @abimethod({ allowActions: 'NoOp' })
  getUserTier(user: Address): UintN64 {
    err('stub only')
  }
}
