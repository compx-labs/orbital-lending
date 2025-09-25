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
  INDEX_SCALE,
  InterestAccrualReturn,
  LoanRecord,
} from './config.algo'
import { TokenPrice } from '../Oracle/config.algo'
import {
  MBR_COLLATERAL,
  MBR_CREATE_APP,
  MBR_INIT_APP,
  MBR_OPT_IN_LST,
  STANDARD_TXN_FEE,
  BASIS_POINTS,
  DEBUG_TIMESTAMP_OFFSET,
  VALIDATE_BORROW_FEE,
  USD_MICRO_UNITS,
  SECONDS_PER_YEAR,
} from './config.algo'

// Number of seconds in a (e.g.) 365-day year

// Instead of scattered magic numbers, centralize them

@contract({ name: 'orbital-lending', avmVersion: 11 })
export class OrbitalLending extends Contract {
  // ═══════════════════════════════════════════════════════════════════════
  // CORE TOKEN CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════

  /** The main lending token used for deposits and borrowing (0 for ALGO) */
  base_token_id = GlobalState<UintN64>()

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

  /** Administrative account with privileged access to protocol functions */
  admin_account = GlobalState<Account>()

  /** External oracle application for asset price feeds */
  oracle_app = GlobalState<Application>()

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

  /** If 1, reject borrows that would exceed util_cap_bps. */
  borrow_gate_enabled = GlobalState<uint64>()

  /** (Optional) Utilization EMA weight in bps (0..10_000; 0 disables smoothing). */
  ema_alpha_bps = GlobalState<uint64>()

  /** (Optional) Max APR change per accrual step in bps (0 = no limit). */
  max_apr_step_bps = GlobalState<uint64>()

  /** (Optional, mutable) Last applied APR in bps (for step limiting). */
  prev_apr_bps = GlobalState<uint64>()

  /** (Optional, mutable) Stored EMA of normalized utilization in bps. */
  util_ema_bps = GlobalState<uint64>()

  /** (Optional) Rate model selector (e.g., 0=kinked, 1=linear, 2=power, 3=asymptote). */
  rate_model_type = GlobalState<uint64>()

  /** (Optional) Power-curve exponent γ in Q16.16 fixed-point. */
  power_gamma_q16 = GlobalState<uint64>()

  /** (Optional) Strength parameter for asymptotic/scarcity escalator (bps-scaled). */
  scarcity_K_bps = GlobalState<uint64>()

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

  /** Liquidation bonus in bps (e.g., 500 = 5% bonus to liquidators) */
  liq_bonus_bps = GlobalState<uint64>()

  // ═══════════════════════════════════════════════════════════════════════
  // DEBUG & OPERATIONAL TRACKING
  // ═══════════════════════════════════════════════════════════════════════

  /** Last calculated disbursement amount (for debugging/monitoring) */
  last_scaled_down_disbursement = GlobalState<uint64>()

  /** Last calculated maximum borrowable amount in USD (for debugging) */
  last_max_borrow = GlobalState<uint64>()

  /** Last requested loan amount in USD (for debugging) */
  last_requested_loan = GlobalState<uint64>()

  /** Difference between max borrow and requested (for debugging) */
  debug_diff = GlobalState<uint64>()

  params_updated_at = GlobalState<uint64>() // last params change timestamp (ledger seconds)
  params_update_nonce = GlobalState<uint64>() // monotonic counter

  last_interest_applied = GlobalState<uint64>() // last interest application timestamp (ledger seconds)
  delta_debug = GlobalState<uint64>() // debug variable to track time between interest applications
  calculateledSimpleWad = GlobalState<uint64>() // debug variable to track last calculated simple wad

  /**
   * Creates the lending application contract with initial configuration
   * @param admin - The administrative account that will have privileged access
   * @param baseTokenId - The asset ID of the base lending token (0 for ALGO)
   * @dev This method can only be called during contract creation (onCreate: 'require')
   */
  @abimethod({ allowActions: 'NoOp', onCreate: 'require' })
  public createApplication(admin: Account, baseTokenId: uint64): void {
    this.admin_account.value = admin
    this.base_token_id.value = new UintN64(baseTokenId)
  }

  /**
   * Initializes the lending protocol with core parameters and configurations
   * @param mbrTxn - Payment transaction covering minimum balance requirements
   * @param ltv_bps - Loan-to-Value ratio in basis points (e.g., 7500 = 75%)
   * @param liq_threshold_bps - Liquidation threshold in basis points (e.g., 8500 = 85%)
   * @param liq_bonus_bps - Liquidation bonus in basis points (e.g., 500 = 5% bonus to liquidators)
   * @param borrow_gate_enabled - Whether the borrow gate is enabled (1 = enabled, 0 = disabled)
   * @param origination_fee_bps - One-time loan origination fee in basis points
   * @param protocol_share_bps - Protocol's share of interest income in basis points
   * @param oracle_app_id - Application ID of the price oracle contract
   * @dev Only callable by admin account. Sets up all lending parameters and opts into base token if needed
   */
  @abimethod({ allowActions: 'NoOp' })
  public initApplication(
    mbrTxn: gtxn.PaymentTxn,
    ltv_bps: uint64,
    liq_threshold_bps: uint64,
    liq_bonus_bps: uint64,
    origination_fee_bps: uint64,
    protocol_share_bps: uint64,
    borrow_gate_enabled: uint64,
    oracle_app_id: Application,
    buyout_token_id: uint64,
  ): void {
    assert(op.Txn.sender === this.admin_account.value)

    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: MBR_CREATE_APP,
    })

    this.ltv_bps.value = ltv_bps
    this.liq_threshold_bps.value = liq_threshold_bps
    this.origination_fee_bps.value = origination_fee_bps
    this.accepted_collaterals_count.value = 0
    this.fee_pool.value = 0
    this.circulating_lst.value = 0
    this.total_deposits.value = 0
    this.active_loan_records.value = 0
    this.protocol_share_bps.value = protocol_share_bps
    this.oracle_app.value = oracle_app_id
    this.borrow_gate_enabled.value = borrow_gate_enabled
    this.lst_token_id.value = new UintN64(99)
    this.base_bps.value = 50
    this.util_cap_bps.value = 8000 // 80% utilization cap
    this.total_borrows.value = 0
    this.rate_model_type.value = 0 // Default to kinked model
    this.kink_norm_bps.value = 5000 // 50% kink point
    this.slope1_bps.value = 1000 // 10% slope to kink
    this.slope2_bps.value = 2000 // 20% slope after kink
    this.max_apr_bps.value = 6000 // 60% APR Cap by Default
    this.ema_alpha_bps.value = 0 // No EMA smoothing by default
    this.max_apr_step_bps.value = 0 // No max APR step by default
    this.prev_apr_bps.value = 50 // Same as base_bps by default
    this.util_ema_bps.value = 0 // No utilization EMA by default
    this.power_gamma_q16.value = 0 // No power curve by default
    this.scarcity_K_bps.value = 0 // No scarcity parameter by default
    this.last_scaled_down_disbursement.value = 0
    this.last_max_borrow.value = 0
    this.last_requested_loan.value = 0
    this.debug_diff.value = 0
    this.params_updated_at.value = Global.latestTimestamp
    this.params_update_nonce.value = 0
    this.borrow_index_wad.value = INDEX_SCALE
    this.last_accrual_ts.value = Global.latestTimestamp
    this.last_apr_bps.value = this.base_bps.value
    this.buyout_token_id.value = new UintN64(buyout_token_id)
    this.liq_bonus_bps.value = liq_bonus_bps

    this.total_borrows_principal.value = 0

    if (this.base_token_id.value.native !== 0) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          xferAsset: this.base_token_id.value.native,
          assetAmount: 0,
          fee: STANDARD_TXN_FEE,
        })
        .submit()
    }
    if (this.buyout_token_id.value.native !== 0) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          xferAsset: this.buyout_token_id.value.native,
          assetAmount: 0,
          fee: STANDARD_TXN_FEE,
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
   * @dev Only callable by admin account. Updates all core lending parameters atomically
   */
  public setRateParams(
    base_bps: uint64,
    util_cap_bps: uint64,
    kink_norm_bps: uint64,
    slope1_bps: uint64,
    slope2_bps: uint64,
    max_apr_bps: uint64,
    borrow_gate_enabled: uint64, // or uint8
    ema_alpha_bps: uint64,
    max_apr_step_bps: uint64,
    rate_model_type: uint64, // or uint8
    power_gamma_q16: uint64,
    scarcity_K_bps: uint64,
    liq_bonus_bps: uint64,
  ) {
    assert(op.Txn.sender === this.admin_account.value, 'UNAUTHORIZED')

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

    // Apply atomically
    this.base_bps.value = base_bps
    this.util_cap_bps.value = util_cap_bps
    this.kink_norm_bps.value = kink_norm_bps
    this.slope1_bps.value = slope1_bps
    this.slope2_bps.value = slope2_bps
    this.max_apr_bps.value = max_apr_bps
    this.borrow_gate_enabled.value = borrow_gate_enabled
    this.ema_alpha_bps.value = ema_alpha_bps
    this.max_apr_step_bps.value = max_apr_step_bps
    this.rate_model_type.value = rate_model_type
    this.power_gamma_q16.value = power_gamma_q16
    this.scarcity_K_bps.value = scarcity_K_bps
    this.liq_bonus_bps.value = liq_bonus_bps

    this.params_update_nonce.value += 1
    this.params_updated_at.value = Global.latestTimestamp

    // Optional: clamp prev_apr if a new max is lower
    if (this.max_apr_bps.value > 0 && this.prev_apr_bps.value > this.max_apr_bps.value) {
      this.prev_apr_bps.value = this.max_apr_bps.value
    }
  }

  /**
   * Generates a new LST (Liquidity Staking Token) for the base lending token
   * @param mbrTxn - Payment transaction covering asset creation minimum balance requirements
   * @dev Only callable by admin. Creates a new asset with 'c' prefix (e.g., cUSDC for USDC)
   * @dev The LST represents depositor shares in the lending pool
   */
  //If generating a new LST for the base token.
  public generateLSTToken(mbrTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.admin_account.value)
    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: MBR_INIT_APP,
    })
    /// Submit opt-in transaction: 0 asset transfer to self

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
        fee: STANDARD_TXN_FEE,
      })
      .submit()
    this.lst_token_id.value = new UintN64(result.createdAsset.id)
  }

  /**
   * Opts into an existing LST token created externally
   * @param lstAssetId - Asset ID of the existing LST token to opt into
   * @param mbrTxn - Payment transaction covering opt-in minimum balance requirements
   * @dev Only callable by admin. Use when LST token already exists and needs to be adopted
   */
  //If LST already created externally.
  public optInToLST(lstAssetId: uint64, mbrTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.admin_account.value)
    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: MBR_OPT_IN_LST,
    })
    this.lst_token_id.value = new UintN64(lstAssetId)

    //Opt-in to the LST token
    itxn
      .assetTransfer({
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: lstAssetId,
        assetAmount: 0,
        fee: STANDARD_TXN_FEE,
      })
      .submit()
  }

  /**
   * Configures the LST token by setting initial circulating supply
   * @param axferTxn - Asset transfer transaction from admin containing LST tokens
   * @param circulating_lst - Initial amount of LST tokens to mark as circulating
   * @dev Only callable by admin. Used to bootstrap LST token circulation after creation/opt-in
   */
  public configureLSTToken(axferTxn: gtxn.AssetTransferTxn, circulating_lst: uint64): void {
    assert(op.Txn.sender === this.admin_account.value)
    assert(this.lst_token_id.value.native === axferTxn.xferAsset.id, 'LST token not set')

    assertMatch(axferTxn, {
      sender: this.admin_account.value,
      assetReceiver: Global.currentApplicationAddress,
    })
    this.circulating_lst.value = circulating_lst
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
   * Retrieves current price for a token from the configured oracle
   * @param tokenId - Asset ID of the token to get price for
   * @returns Current price of the token from oracle (in USD micro-units)
   * @dev Calls external oracle contract to fetch real-time price data
   */
  getOraclePrice(tokenId: UintN64): uint64 {
    const oracle: Application = this.oracle_app.value
    const address = oracle.address
    const contractAppId = oracle.id

    const result = abiCall(PriceOracleStub.prototype.getTokenPrice, {
      appId: contractAppId,
      args: [tokenId],
      fee: STANDARD_TXN_FEE,
    }).returnValue

    return result.price.native
  }

  private collateralExists(collateralTokenId: UintN64): boolean {
    const key = new AcceptedCollateralKey({ assetId: collateralTokenId })
    return this.accepted_collaterals(key).exists
  }

  private getCollateral(collateralTokenId: UintN64): AcceptedCollateral {
    const key = new AcceptedCollateralKey({ assetId: collateralTokenId })
    return this.accepted_collaterals(key).value.copy()
  }

  private updateCollateralTotal(collateralTokenId: UintN64, amount: uint64): void {
    const key = new AcceptedCollateralKey({ assetId: collateralTokenId })
    const collateral = this.accepted_collaterals(key).value.copy()

    const newTotal: uint64 = collateral.totalCollateral.native + amount
    this.accepted_collaterals(key).value = new AcceptedCollateral({
      assetId: collateral.assetId,
      baseAssetId: collateral.baseAssetId,
      marketBaseAssetId: collateral.marketBaseAssetId,
      totalCollateral: new UintN64(newTotal),
    }).copy()
  }

  private reduceCollateralTotal(collateralTokenId: UintN64, amount: uint64): void {
    const key = new AcceptedCollateralKey({ assetId: collateralTokenId })
    const collateral = this.accepted_collaterals(key).value.copy()

    assert(collateral.totalCollateral.native >= amount, 'INSUFFICIENT_COLLATERAL')
    const newTotal: uint64 = collateral.totalCollateral.native - amount
    this.accepted_collaterals(key).value = new AcceptedCollateral({
      assetId: collateral.assetId,
      baseAssetId: collateral.baseAssetId,
      marketBaseAssetId: collateral.marketBaseAssetId,
      totalCollateral: new UintN64(newTotal),
    }).copy()
  }

  /**
   * Adds a new asset type as accepted collateral for borrowing
   * @param collateralTokenId - Asset ID of the new collateral type to accept
   * @param mbrTxn - Payment transaction covering storage minimum balance requirements
   * @dev Only callable by admin. Registers new collateral type and opts contract into the asset
   * @dev Collateral cannot be the same as the base lending token
   */
  @abimethod({ allowActions: 'NoOp' })
  addNewCollateralType(collateralTokenId: UintN64, collateralBaseTokenId: UintN64, mbrTxn: gtxn.PaymentTxn): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assert(op.Txn.sender === this.admin_account.value, 'UNAUTHORIZED')
    assert(collateralTokenId.native !== baseToken.id, 'CANNOT_USE_BASE_AS_COLLATERAL')
    assert(!this.collateralExists(collateralTokenId), 'COLLATERAL_ALREADY_EXISTS')
    assertMatch(
      mbrTxn,
      {
        sender: this.admin_account.value,
        amount: MBR_COLLATERAL,
      },
      'INSUFFICIENT_MBR',
    )

    const newAcceptedCollateral: AcceptedCollateral = new AcceptedCollateral({
      assetId: collateralTokenId,
      baseAssetId: collateralBaseTokenId,
      marketBaseAssetId: this.base_token_id.value,
      totalCollateral: new UintN64(0),
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
        fee: STANDARD_TXN_FEE,
      })
      .submit()

    assert(this.collateralExists(collateralTokenId), 'unsupported collateral')
  }

  private calculateLSTDue(amount: uint64): uint64 {
    const [highBits1, lowBits1] = mulw(this.circulating_lst.value, BASIS_POINTS)

    const lstRatio = divw(highBits1, lowBits1, this.total_deposits.value)

    const [highBits2, lowBits2] = mulw(lstRatio, amount)
    return divw(highBits2, lowBits2, BASIS_POINTS)
  }

  // Calculate how much underlying ASA to return for a given LST amount,
  // by querying the external LST contract’s circulatingLST & totalDeposits.
  private calculateASADue(amount: uint64, lstApp: uint64): uint64 {
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstApp,
      fee: STANDARD_TXN_FEE,
    }).returnValue
    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstApp,
      fee: STANDARD_TXN_FEE,
    }).returnValue

    // underlyingCollateral = (amount * totalDepositsExternal) / circulatingExternalLST
    const [hi, lo] = mulw(totalDepositsExternal, amount)
    return divw(hi, lo, circulatingExternalLST)
  }

  private calculateLSTDueLocal(amount: uint64): uint64 {
    // Calculate the LST due based on the local state of this contract
    const circulatingExternalLST = this.circulating_lst.value
    const totalDepositsExternal = this.total_deposits.value

    // underlyingCollateral = (amount * totalDepositsExternal) / circulatingExternalLST
    const [hi, lo] = mulw(totalDepositsExternal, amount)
    return divw(hi, lo, circulatingExternalLST)
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
  depositASA(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64, mbrTxn: gtxn.PaymentTxn): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: baseToken,
      assetAmount: amount,
    })
    assertMatch(mbrTxn, {
      amount: STANDARD_TXN_FEE,
    })

    const _interestSlice = this.accrueMarket()

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
        fee: STANDARD_TXN_FEE,
      })
      .submit()

    this.circulating_lst.value += lstDue
    this.total_deposits.value += amount
    this.last_apr_bps.value = this.current_apr_bps()
  }

  /**
   * Deposits ALGO into the lending pool and receives LST tokens in return
   * @param depositTxn - Payment transaction depositing ALGO to the contract
   * @param amount - Amount of ALGO being deposited (in microALGOs)
   * @param mbrTxn - Payment transaction covering transaction fees
   * @dev Similar to depositASA but specifically for ALGO deposits when base_token_id is 0
   * @dev Mints LST tokens proportional to deposit amount based on current exchange rate
   */
  @abimethod({ allowActions: 'NoOp' })
  depositAlgo(depositTxn: gtxn.PaymentTxn, amount: uint64, mbrTxn: gtxn.PaymentTxn): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(depositTxn, {
      receiver: Global.currentApplicationAddress,
      amount: amount,
    })
    assertMatch(mbrTxn, {
      amount: STANDARD_TXN_FEE,
    })

    const _interestSlice = this.accrueMarket()

    let lstDue: uint64 = 0
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
        fee: STANDARD_TXN_FEE,
      })
      .submit()

    this.circulating_lst.value += lstDue
    this.total_deposits.value += amount
    this.last_apr_bps.value = this.current_apr_bps()
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
  withdrawDeposit(
    assetTransferTxn: gtxn.AssetTransferTxn,
    amount: uint64,
    lstAppId: uint64,
    mbrTxn: gtxn.PaymentTxn,
  ): void {
    const lstAsset = Asset(this.lst_token_id.value.native)
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: lstAsset,
      assetAmount: amount,
    })

    assertMatch(mbrTxn, {
      amount: 3000,
    })

    const _interestSlice = this.accrueMarket()

    //Calculate the return amount of ASA
    let asaDue: uint64 = 0
    if (lstAppId === Global.currentApplicationId.id) {
      asaDue = this.calculateLSTDueLocal(amount)
    } else {
      asaDue = this.calculateASADue(amount, lstAppId)
    }

    assert(op.AssetHolding.assetBalance(Global.currentApplicationAddress, this.base_token_id.value.native)[0] >= asaDue)
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.base_token_id.value.native,
        assetAmount: asaDue,
        fee: STANDARD_TXN_FEE,
      })
      .submit()

    this.circulating_lst.value -= amount // LST burned
    this.total_deposits.value -= asaDue // ASA returned
    this.last_apr_bps.value = this.current_apr_bps()
  }

  /**
   * Borrows base assets against collateral with interest and fees
   * @param assetTransferTxn - Asset transfer transaction depositing collateral to the contract
   * @param requestedLoanAmount - Amount of base tokens requested for borrowing
   * @param collateralAmount - Amount of collateral being deposited
   * @param lstApp - Application ID for LST exchange rate calculation
   * @param collateralTokenId - Asset ID of the collateral being deposited
   * @param mbrTxn - Payment transaction covering transaction fees
   * @dev Validates LTV ratio, charges origination fee, and disburses loan amount
   * @dev Supports both new loans and top-ups of existing loans
   * @dev Collateral value determined via oracle pricing and LST exchange rates
   */
  @abimethod({ allowActions: 'NoOp' })
  borrow(
    assetTransferTxn: gtxn.AssetTransferTxn,
    requestedLoanAmount: uint64,
    collateralAmount: uint64,
    lstApp: uint64,
    collateralTokenId: UintN64,
    mbrTxn: gtxn.PaymentTxn,
  ): void {
    // ─── 0. Determine if this is a top-up or a brand-new loan ─────────────
    const hasLoan = this.loan_record(op.Txn.sender).exists
    const _interestSlice = this.accrueMarket()
    let collateralToUse: uint64 = 0
    if (hasLoan) {
      const existingCollateral = this.getLoanRecord(op.Txn.sender).collateralAmount
      collateralToUse = existingCollateral.native
    } else {
      collateralToUse = collateralAmount
    }
    this.validateBorrowRequest(assetTransferTxn, collateralAmount, collateralTokenId, mbrTxn)
    const collateralUSD = this.calculateCollateralValueUSD(collateralTokenId, collateralToUse, lstApp)
    const maxBorrowUSD: uint64 = (collateralUSD * this.ltv_bps.value) / BASIS_POINTS
    this.last_max_borrow.value = maxBorrowUSD
    const baseTokenOraclePrice: uint64 = this.getOraclePrice(this.base_token_id.value)
    this.validateLoanAmount(requestedLoanAmount, maxBorrowUSD, baseTokenOraclePrice)
    const { disbursement, fee } = this.calculateDisbursement(requestedLoanAmount)

    if (hasLoan) {
      this.processLoanTopUp(
        op.Txn.sender,
        collateralAmount,
        disbursement,
        maxBorrowUSD,
        baseTokenOraclePrice,
        requestedLoanAmount,
        collateralTokenId,
      )
    } else {
      this.mintLoanRecord(disbursement, collateralTokenId, op.Txn.sender, collateralAmount)
      this.updateCollateralTotal(collateralTokenId, collateralAmount)
    }

    this.disburseFunds(op.Txn.sender, disbursement)
    this.total_borrows.value = this.total_borrows.value + disbursement
    this.last_apr_bps.value = this.current_apr_bps()

    this.payPlatformFees(this.base_token_id.value.native, fee)
  }

  private mintLoanRecord(
    disbursement: uint64,
    collateralTokenId: UintN64,
    borrowerAddress: Account,
    collateralAmount: uint64,
  ): void {
    const debtChangeArray = new DynamicArray<DebtChange>()

    this.loan_record(borrowerAddress).value = new LoanRecord({
      borrowerAddress: new Address(borrowerAddress.bytes),
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
  /* 
  private updateLoanRecord(
    debtChange: DebtChange,
    totalDebt: uint64,
    collateralTokenId: UintN64,
    borrowerAddress: Account,
    collateralAmount: uint64,
  ): void {
    const loanRecord: LoanRecord = new LoanRecord({
      borrowerAddress: new Address(borrowerAddress.bytes),
      collateralTokenId: collateralTokenId,
      collateralAmount: new UintN64(collateralAmount),
      lastDebtChange: debtChange.copy(),
      totalDebt: new UintN64(totalDebt),
      borrowedTokenId: this.base_token_id.value,
      lastAccrualTimestamp: new UintN64(Global.latestTimestamp),
    })
    this.loan_record(borrowerAddress).value = loanRecord.copy()
  } */

  @abimethod({ allowActions: 'NoOp' })
  accrueLoanInterest(debtor: Account, templateReserveAddress: Account): void {
    assert(this.loan_record(debtor).exists, 'Loan record does not exist')
    this.accrueMarket()
    // Just roll the borrower snapshot forward
    this.syncBorrowerSnapshot(debtor)
    // No changes to total_deposits or fee_pool here — already handled in accrueMarket()
    this.last_apr_bps.value = this.current_apr_bps()
  }

  // 0..10_000 over the allowed band [0 .. util_cap_bps * deposits]
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

  // SINGLE public entrypoint to get the current APR (bps)
  public current_apr_bps(): uint64 {
    // Compute normalized utilization (0..10_000)
    const U_raw: uint64 = this.util_norm_bps()

    // Optional EMA smoothing
    const alpha: uint64 = this.ema_alpha_bps.value // 0..10_000
    let U_used: uint64
    if (alpha === 0) {
      U_used = U_raw
    } else {
      const prevU: uint64 = this.util_ema_bps.value
      const oneMinus: uint64 = BASIS_POINTS - alpha
      const [hiA, loA] = mulw(alpha, U_raw)
      const [hiB, loB] = mulw(oneMinus, prevU)
      U_used = divw(hiA, loA, BASIS_POINTS) + divw(hiB, loB, BASIS_POINTS)
      this.util_ema_bps.value = U_used
    }

    // Model selection (0=kinked; 255=fixed fallback)
    let apr = this.rate_model_type.value === 0 ? this.apr_bps_kinked(U_used) : this.base_bps.value // Fixed APR fallback

    // Optional per-step change limiter
    const stepMax: uint64 = this.max_apr_step_bps.value
    if (stepMax > 0) {
      const prevApr: uint64 = this.prev_apr_bps.value === 0 ? this.base_bps.value : this.prev_apr_bps.value
      const lo: uint64 = prevApr > stepMax ? prevApr - stepMax : 0
      const hi: uint64 = prevApr + stepMax
      if (apr < lo) apr = lo
      if (apr > hi) apr = hi
    }

    this.prev_apr_bps.value = apr
    return apr
  }

  // Returns the simple interest factor for this time slice, scaled by INDEX_SCALE.
  // simple = (last_apr_bps / 10_000) * (Δt / SECONDS_PER_YEAR)
  private sliceFactorWad(deltaT: uint64): uint64 {
    if (deltaT === 0) return 0

    // tmp = last_apr_bps * deltaT
    const [h1, l1] = mulw(this.last_apr_bps.value, deltaT)
    // tmp2 = tmp / SECONDS_PER_YEAR  (still in "bps")
    const tmp2: uint64 = divw(h1, l1, SECONDS_PER_YEAR)

    // simpleWad = (INDEX_SCALE * tmp2) / BASIS_POINTS
    const [h2, l2] = mulw(INDEX_SCALE, tmp2)
    const simpleWad: uint64 = divw(h2, l2, BASIS_POINTS)
    return simpleWad // e.g., 0.0123 * INDEX_SCALE for a 1.23% slice
  }

  private currentDebtFromSnapshot(rec: LoanRecord): uint64 {
    const p: uint64 = rec.principal.native
    if (p === 0) return 0
    const [hi, lo] = mulw(p, this.borrow_index_wad.value)
    return divw(hi, lo, rec.userIndexWad.native)
  }

  // Roll borrower snapshot forward to "now" without changing what they owe
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
  private accrueMarket(): uint64 {
    const now: uint64 = Global.latestTimestamp
    const last: uint64 = this.last_accrual_ts.value
    if (now <= last) return 0

    const deltaT: uint64 = now - last

/*     if (deltaT < SECONDS_PER_YEAR) {
      deltaT = 10000
    }
    this.delta_debug.value = deltaT
    this.last_apr_bps.value = 5000 */

    // 1) Compute simple slice factor in INDEX_SCALE
    const simpleWad: uint64 = this.sliceFactorWad(deltaT)
    this.calculateledSimpleWad.value = simpleWad
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
    this.last_interest_applied.value = interest

    // Depositors earn their share as yield (LST exchange rate rises):
    this.total_deposits.value += depositorInterest

    // Protocol takes its fee share:
    this.fee_pool.value += protocolInterest
    this.payPlatformFees(this.base_token_id.value.native, protocolInterest)

    // 6) Close the slice
    this.last_accrual_ts.value = now

    // IMPORTANT: We DO NOT recompute last_apr_bps here.
    // That happens *after* state mutations that change utilization (Step 3).
    return interest
  }

  /*   private accrueInterest(record: LoanRecord): InterestAccrualReturn {
    const now = Global.latestTimestamp
    const last = record.lastAccrualTimestamp.native
    // If no time has passed, nothing to do
    if (now <= last)
      return new InterestAccrualReturn({
        change: new DebtChange({
          amount: new UintN64(0),
          timestamp: new UintN64(Global.latestTimestamp),
          changeType: new UintN8(1),
        }),
        totalDebt: record.totalDebt,
      })

    const deltaT: uint64 = now - last
    const principal: uint64 = record.totalDebt.native

    // Replace with curve calcualtion
    const rateBps: uint64 = this.current_apr_bps()

    // 1) Compute principal * rateBps → wide multiply
    const [hi1, lo1] = mulw(principal, rateBps)
    // 2) Convert basis points to fraction: divide by 10_000
    const rateScaled: uint64 = divw(hi1, lo1, BASIS_POINTS)
    // 3) Multiply by time delta: rateScaled * deltaT  → wide multiply
    const [hi2, lo2] = mulw(rateScaled, deltaT)
    // 4) Divide by seconds_per_year to get interest amount
    const interest: uint64 = divw(hi2, lo2, SECONDS_PER_YEAR)

    const protoBps: uint64 = this.protocol_share_bps.value
    const depositorBps: uint64 = BASIS_POINTS - protoBps

    // depositor’s share = interest * depositorBps / 10_000
    const [hiDep, loDep] = mulw(interest, depositorBps)
    const depositorInterest: uint64 = divw(hiDep, loDep, BASIS_POINTS)

    // protocol’s share = remainder
    const protocolInterest: uint64 = interest - depositorInterest

    // 3) Credit the shares
    // a) Depositors earn yield: bump total_deposits (so LSTs become worth more)
    this.total_deposits.value += depositorInterest
    // b) Protocol earnings: add to fee_pool
    this.fee_pool.value += protocolInterest

    // 4) Update borrower’s outstanding debt (principal + full interest)

    const newPrincipal: uint64 = principal + interest

    return new InterestAccrualReturn({
      change: new DebtChange({
        amount: new UintN64(interest),
        timestamp: new UintN64(Global.latestTimestamp),
        changeType: new UintN8(1),
      }),
      totalDebt: new UintN64(newPrincipal),
    })
  } */

  getLoanRecord(borrowerAddress: Account): LoanRecord {
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
   */
  @abimethod({ allowActions: 'NoOp' })
  repayLoanASA(assetTransferTxn: gtxn.AssetTransferTxn, repaymentAmount: uint64): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: baseToken,
      assetAmount: repaymentAmount,
    })
    const _interestSlice = this.accrueMarket()
    const loanRecord = this.getLoanRecord(op.Txn.sender)

    const rec = this.getLoanRecord(op.Txn.sender)
    const liveDebt: uint64 = this.currentDebtFromSnapshot(rec)

    assert(repaymentAmount <= liveDebt)

    const remainingDebt: uint64 = liveDebt - repaymentAmount

    // Market aggregate falls by amount repaid (principal or interest, we don’t care here)
    this.total_borrows.value -= repaymentAmount

    if (remainingDebt === 0) {
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
          amount: new UintN64(repaymentAmount),
          timestamp: new UintN64(Global.latestTimestamp),
          changeType: new UintN8(2), // repay
        }),
        principal: new UintN64(remainingDebt),
        userIndexWad: new UintN64(this.borrow_index_wad.value),
      }).copy()

      /*  // Might need to remove this and return any excess
    assert(repaymentAmount <= iar.totalDebt.native)
    const remainingDebt: uint64 = iar.totalDebt.native - repaymentAmount
    this.total_borrows.value = this.total_borrows.value - repaymentAmount

    if (remainingDebt === 0) {
      //Delete box reference
      this.loan_record(op.Txn.sender).delete()
      this.active_loan_records.value = this.active_loan_records.value - 1

      itxn
        .assetTransfer({
          assetReceiver: op.Txn.sender,
          xferAsset: loanRecord.collateralTokenId.native,
          assetAmount: loanRecord.collateralAmount.native,
        })
        .submit()
    } else {
      // Update the record and mint a new ASA
      this.updateLoanRecord(
        new DebtChange({
          amount: new UintN64(repaymentAmount),
          timestamp: new UintN64(Global.latestTimestamp),
          changeType: new UintN8(2), // 2 for repayment
        }), // scaledDownDisbursement
        remainingDebt, // new debt
        loanRecord.collateralTokenId, // collateral type
        op.Txn.sender, // borrower
        loanRecord.collateralAmount.native, // collateral locked
      )
    }
    this.last_apr_bps.value = this.current_apr_bps() */
    }
  }

  /**
   * Repays a loan using ALGO and optionally releases collateral
   * @param paymentTxn - Payment transaction sending ALGO repayment to contract
   * @param amount - Amount of ALGO being repaid (in microALGOs)
   * @param templateReserveAddress - Reserve address for potential future use
   * @dev Similar to repayLoanASA but specifically for ALGO repayments
   * @dev Accrues interest before processing repayment
   * @dev Full repayment closes loan and returns all collateral
   */
  @abimethod({ allowActions: 'NoOp' })
  repayLoanAlgo(paymentTxn: gtxn.PaymentTxn, repaymentAmount: uint64): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(paymentTxn, {
      receiver: Global.currentApplicationAddress,
      amount: repaymentAmount,
    })
    const _interestSlice = this.accrueMarket()
    const loanRecord = this.getLoanRecord(op.Txn.sender)
    const rec = this.getLoanRecord(op.Txn.sender)
    const liveDebt: uint64 = this.currentDebtFromSnapshot(rec)

    assert(repaymentAmount <= liveDebt)

    const remainingDebt: uint64 = liveDebt - repaymentAmount

    // Market aggregate falls by amount repaid (principal or interest, we don’t care here)
    this.total_borrows.value -= repaymentAmount

    if (remainingDebt === 0) {
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
          amount: new UintN64(repaymentAmount),
          timestamp: new UintN64(Global.latestTimestamp),
          changeType: new UintN8(2), // repay
        }),
        principal: new UintN64(remainingDebt),
        userIndexWad: new UintN64(this.borrow_index_wad.value),
      }).copy()
    }
  }

  private payPlatformFees(assetId: uint64, amount: uint64): void {
    if (amount > 0) {
      if (assetId === 0) {
        itxn
          .payment({
            receiver: this.admin_account.value,
            amount: amount,
            fee: STANDARD_TXN_FEE,
          })
          .submit()
      } else {
        itxn
          .assetTransfer({
            assetReceiver: this.admin_account.value,
            xferAsset: assetId,
            assetAmount: amount,
            fee: STANDARD_TXN_FEE,
          })
          .submit()
      }
    }
  }

  /**
   * Purchases a borrower's collateral at a premium when loan is above liquidation threshold
   * @param buyer - Account that will receive the collateral
   * @param debtor - Account whose loan is being bought out
   * @param axferTxn - Asset transfer transaction with buyout payment
   * @dev Buyout price includes premium based on how far above liquidation threshold
   * @dev Only available when collateral ratio exceeds liquidation threshold
   * @dev Closes the loan and transfers collateral to buyer
   */
  @abimethod({ allowActions: 'NoOp' })
  public buyoutSplitASA(
    buyer: Account,
    debtor: Account,
    premiumAxferTxn: gtxn.AssetTransferTxn, // buyout token (xUSD) PREMIUM
    repayAxferTxn: gtxn.AssetTransferTxn, // BASE TOKEN (ASA) full DEBT
    lstAppId: uint64, // LST app backing the collateral
  ): void {
    assert(this.loan_record(debtor).exists, 'NO_LOAN_RECORD')

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
    const collateralUSD: uint64 = this.calculateCollateralValueUSD(collateralTokenId, collateralAmount, lstAppId)
    const debtUSDv: uint64 = this.debtUSD(debtBase)
    assert(debtUSDv > 0, 'BAD_DEBT_USD')

    // CR in bps
    const [hCR, lCR] = mulw(collateralUSD, BASIS_POINTS)
    const CR_bps: uint64 = divw(hCR, lCR, debtUSDv)

    // Premium rate (bps), clamped at 0 below threshold
    let premiumRateBps: uint64 = 0
    if (CR_bps > this.liq_threshold_bps.value) {
      const [hR, lR] = mulw(CR_bps, BASIS_POINTS)
      const ratio_bps: uint64 = divw(hR, lR, this.liq_threshold_bps.value) // > 10_000 if CR_bps > thresh
      premiumRateBps = ratio_bps - BASIS_POINTS
    }

    // Premium (USD)
    const [hP, lP] = mulw(collateralUSD, premiumRateBps)
    const premiumUSD: uint64 = divw(hP, lP, BASIS_POINTS)

    // 4) Convert premium USD → buyout token amount
    const buyoutTokenId: uint64 = this.buyout_token_id.value.native
    const buyoutTokenPrice: uint64 = this.getOraclePrice(this.buyout_token_id.value) // µUSD per token

    // premiumTokens = premiumUSD * 1e6 / buyoutTokenPrice
    const [hPT, lPT] = mulw(premiumUSD, USD_MICRO_UNITS)
    const premiumTokens: uint64 = buyoutTokenPrice === 0 ? 0 : divw(hPT, lPT, buyoutTokenPrice)

    // Validate premium transfer (exact)
    assertMatch(premiumAxferTxn, {
      sender: buyer,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(buyoutTokenId),
      assetAmount: premiumTokens,
    })

    // 5) Debt repayment in market base token (ASA)
    const baseAssetId = this.base_token_id.value.native
    assertMatch(repayAxferTxn, {
      sender: buyer,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(baseAssetId),
      assetAmount: debtBase, // full live debt
    })

    // 6) Close loan & transfer collateral
    this.loan_record(debtor).delete()
    this.active_loan_records.value = this.active_loan_records.value - 1

    itxn
      .assetTransfer({
        assetReceiver: buyer,
        xferAsset: collateralTokenId.native,
        assetAmount: collateralAmount,
        fee: STANDARD_TXN_FEE,
      })
      .submit()

    // Update collateral totals
    const acKey = new AcceptedCollateralKey({ assetId: collateralTokenId })
    const acVal = this.accepted_collaterals(acKey).value.copy()
    const updatedTotal: uint64 = acVal.totalCollateral.native - collateralAmount
    this.accepted_collaterals(acKey).value = new AcceptedCollateral({
      assetId: acVal.assetId,
      baseAssetId: acVal.baseAssetId,
      totalCollateral: new UintN64(updatedTotal),
      marketBaseAssetId: acVal.marketBaseAssetId,
    }).copy()

    // Market aggregates
    this.total_borrows.value = this.total_borrows.value - debtBase

    // 7) Split the received premium (in buyout token units)
    this.splitPremium(premiumTokens, buyoutTokenId, debtor)

    // 8) Set next-slice APR
    this.last_apr_bps.value = this.current_apr_bps()
  }

  /**
   * Purchases a borrower's collateral at a premium using ALGO payment
   * @param buyer - Account that will receive the collateral
   * @param debtor - Account whose loan is being bought out
   * @param premiumAxferTxn - Asset transfer transaction with buyout token payment (xUSD)
   * @param repayPayTxn - ALGO payment transaction with base token repayment
   * @param lstAppId - The LST app backing the collateral
   * @dev Similar to buyoutASA but uses ALGO payment instead of asset transfer
   * @dev Buyout price includes premium based on how far above liquidation threshold
   * @dev Only available when collateral ratio exceeds liquidation threshold
   */
  @abimethod({ allowActions: 'NoOp' })
  public buyoutSplitAlgo(
    buyer: Account,
    debtor: Account,
    premiumAxferTxn: gtxn.AssetTransferTxn, // buyout token (xUSD) PREMIUM
    repayPayTxn: gtxn.PaymentTxn, // ALGO DEBT repayment
    lstAppId: uint64,
  ): void {
    assert(this.loan_record(debtor).exists, 'NO_LOAN_RECORD')

    // 1) Make time current
    this.accrueMarket()

    const rec = this.loan_record(debtor).value.copy()
    const collateralAmount: uint64 = rec.collateralAmount.native
    const collateralTokenId: UintN64 = rec.collateralTokenId

    const debtBase: uint64 = this.currentDebtFromSnapshot(rec)
    assert(debtBase > 0, 'NO_DEBT')

    // 2) USD legs
    const collateralUSD: uint64 = this.calculateCollateralValueUSD(collateralTokenId, collateralAmount, lstAppId)
    const debtUSDv: uint64 = this.debtUSD(debtBase)
    assert(debtUSDv > 0, 'BAD_DEBT_USD')

    const [hCR, lCR] = mulw(collateralUSD, BASIS_POINTS)
    const CR_bps: uint64 = divw(hCR, lCR, debtUSDv)

    let premiumRateBps: uint64 = 0
    if (CR_bps > this.liq_threshold_bps.value) {
      const [hR, lR] = mulw(CR_bps, BASIS_POINTS)
      const ratio_bps: uint64 = divw(hR, lR, this.liq_threshold_bps.value)
      premiumRateBps = ratio_bps - BASIS_POINTS
    }

    const [hP, lP] = mulw(collateralUSD, premiumRateBps)
    const premiumUSD: uint64 = divw(hP, lP, BASIS_POINTS)

    // 3) Premium in buyout token
    const buyoutTokenId: uint64 = this.buyout_token_id.value.native
    const buyoutTokenPrice: uint64 = this.getOraclePrice(this.buyout_token_id.value)

    const [hPT, lPT] = mulw(premiumUSD, USD_MICRO_UNITS)
    const premiumTokens: uint64 = buyoutTokenPrice === 0 ? 0 : divw(hPT, lPT, buyoutTokenPrice)

    assertMatch(premiumAxferTxn, {
      sender: buyer,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(buyoutTokenId),
      assetAmount: premiumTokens,
    })

    // 4) Debt repayment in ALGO
    assertMatch(repayPayTxn, {
      sender: buyer,
      receiver: Global.currentApplicationAddress,
      amount: debtBase,
    })

    // 5) Close loan, transfer collateral, update aggregates
    this.loan_record(debtor).delete()
    this.active_loan_records.value = this.active_loan_records.value - 1

    itxn
      .assetTransfer({
        assetReceiver: buyer,
        xferAsset: collateralTokenId.native,
        assetAmount: collateralAmount,
        fee: STANDARD_TXN_FEE,
      })
      .submit()

    const acKey = new AcceptedCollateralKey({ assetId: collateralTokenId })
    const acVal = this.accepted_collaterals(acKey).value.copy()
    const updatedTotal: uint64 = acVal.totalCollateral.native - collateralAmount
    this.accepted_collaterals(acKey).value = new AcceptedCollateral({
      assetId: acVal.assetId,
      baseAssetId: acVal.baseAssetId,
      totalCollateral: new UintN64(updatedTotal),
      marketBaseAssetId: acVal.marketBaseAssetId,
    }).copy()

    this.total_borrows.value = this.total_borrows.value - debtBase

    this.splitPremium(premiumTokens, buyoutTokenId, debtor)

    this.last_apr_bps.value = this.current_apr_bps()
  }

  private splitPremium(premiumTokens: uint64, buyoutTokenId: uint64, debtor: Account) {
    // split premium payments 50/50 between protocol and original borrower
    const halfPremium: uint64 = premiumTokens / 2
    // pay protocol half
    itxn
      .assetTransfer({
        assetReceiver: this.admin_account.value,
        xferAsset: buyoutTokenId,
        assetAmount: halfPremium,
        fee: STANDARD_TXN_FEE,
      })
      .submit()
    // pay original borrower half
    itxn
      .assetTransfer({
        assetReceiver: debtor,
        xferAsset: buyoutTokenId,
        assetAmount: premiumTokens - halfPremium, // cover odd token if any
        fee: STANDARD_TXN_FEE,
      })
      .submit()
  }

  private debtUSD(debtBaseUnits: uint64): uint64 {
    const baseTokenPrice: uint64 = this.getOraclePrice(this.base_token_id.value) // price of market base token
    const [h, l] = mulw(debtBaseUnits, baseTokenPrice)
    return divw(h, l, USD_MICRO_UNITS) // micro-USD
  }

  @abimethod({ allowActions: 'NoOp' })
  public maxWithdrawableCollateralLST(lstAppId: uint64): uint64 {
    assert(this.loan_record(op.Txn.sender).exists, 'NO_LOAN')
    this.accrueMarket()

    const rec = this.loan_record(op.Txn.sender).value.copy()
    const debtBase: uint64 = this.currentDebtFromSnapshot(rec)
    if (debtBase === 0) return rec.collateralAmount.native // all collateral is withdrawable if no debt

    // Current collateral USD (before any withdrawal)
    const currCollatUSD: uint64 = this.calculateCollateralValueUSD(
      rec.collateralTokenId,
      rec.collateralAmount.native,
      lstAppId,
    )

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
      appId: lstAppId,
      fee: STANDARD_TXN_FEE,
    }).returnValue
    const totalDeposits = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstAppId,
      fee: STANDARD_TXN_FEE,
    }).returnValue

    // Base token price for this LST’s underlying
    const ac = this.getCollateral(rec.collateralTokenId)
    const basePrice = this.getOraclePrice(ac.baseAssetId)

    // underlying = removableUSD * 1e6 / basePrice
    const [hU, lU] = mulw(removableUSD, USD_MICRO_UNITS)
    const removableUnderlying: uint64 = divw(hU, lU, basePrice)

    // LST = underlying * circulating / totalDeposits
    const [hL, lL] = mulw(removableUnderlying, circulatingLST)
    const removableLST: uint64 = divw(hL, lL, totalDeposits)

    return removableLST
  }

  private maxWithdrawableCollateralLSTLocal(borrower: Account, lstAppId: uint64): uint64 {
    assert(this.loan_record(borrower).exists, 'NO_LOAN')
    this.accrueMarket()

    const rec = this.loan_record(borrower).value.copy()
    const debtBase: uint64 = this.currentDebtFromSnapshot(rec)
    if (debtBase === 0) return rec.collateralAmount.native // all collateral is withdrawable if no debt

    // Current collateral USD (before any withdrawal)
    const currCollatUSD: uint64 = this.calculateCollateralValueUSD(
      rec.collateralTokenId,
      rec.collateralAmount.native,
      lstAppId,
    )

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
      appId: lstAppId,
      fee: STANDARD_TXN_FEE,
    }).returnValue
    const totalDeposits = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstAppId,
      fee: STANDARD_TXN_FEE,
    }).returnValue

    // Base token price for this LST’s underlying
    const ac = this.getCollateral(rec.collateralTokenId)
    const basePrice = this.getOraclePrice(ac.baseAssetId)

    // underlying = removableUSD * 1e6 / basePrice
    const [hU, lU] = mulw(removableUSD, USD_MICRO_UNITS)
    const removableUnderlying: uint64 = divw(hU, lU, basePrice)

    // LST = underlying * circulating / totalDeposits
    const [hL, lL] = mulw(removableUnderlying, circulatingLST)
    const removableLST: uint64 = divw(hL, lL, totalDeposits)

    return removableLST
  }

  @abimethod({ allowActions: 'NoOp' })
  public withdrawCollateral(amountLST: uint64, collateralTokenId: uint64, lstAppId: uint64): void {
    assert(amountLST > 0, 'ZERO_AMOUNT')
    const borrower = op.Txn.sender
    assert(this.loan_record(borrower).exists, 'NO_LOAN')
    this.accrueMarket() // 1) make time current for everyone
    const loan = this.loan_record(borrower).value.copy()

    const maxSafe = this.maxWithdrawableCollateralLSTLocal(borrower, lstAppId)
    assert(amountLST <= maxSafe, 'EXCEEDS_LIMITS')
    assert(amountLST < loan.collateralAmount.native, 'INSUFFICIENT_COLLATERAL')
    const remainLST: uint64 = loan.collateralAmount.native - amountLST

    // 5) Safe: perform transfer of LST back to borrower
    itxn
      .assetTransfer({
        assetReceiver: borrower,
        xferAsset: collateralTokenId, // LST ASA
        assetAmount: amountLST,
        fee: STANDARD_TXN_FEE,
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
  // Convert an intended seize value in USD into LST units, capped to what's available.
  private seizeLSTFromUSD(
    seizeUSD: uint64,
    collateralTokenId: UintN64,
    lstAppId: uint64,
    availableLST: uint64,
  ): uint64 {
    // USD -> underlying base units
    const underlyingPrice = this.getOraclePrice(this.getCollateral(collateralTokenId).baseAssetId) // µUSD
    const [hUnd, lUnd] = mulw(seizeUSD, USD_MICRO_UNITS)
    const seizeUnderlying: uint64 = divw(hUnd, lUnd, underlyingPrice)

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

  /**
   * Liquidates an undercollateralized loan by repaying debt and claiming collateral
   * @param debtor - Account whose loan is being liquidated
   * @param axferTxn - Asset transfer transaction with full debt repayment
   * @dev Only available when collateral ratio falls below liquidation threshold
   * @dev Liquidator must repay full debt amount to claim all collateral
   * @dev Closes the loan and transfers collateral to liquidator
   */
  @abimethod({ allowActions: 'NoOp' })
  public liquidatePartialASA(
    debtor: Account,
    repayAxfer: gtxn.AssetTransferTxn, // liquidator pays base token (ASA)
    repayBaseAmount: uint64, // amount to repay in base units (≤ live debt)
    lstAppId: uint64, // LST app backing the collateral
  ): void {
    assert(this.loan_record(debtor).exists, 'NO_LOAN')
    this.accrueMarket()

    const rec = this.loan_record(debtor).value.copy()
    const collTok: UintN64 = rec.collateralTokenId
    const collLSTBal: uint64 = rec.collateralAmount.native
    const liveDebt: uint64 = this.currentDebtFromSnapshot(rec)
    assert(liveDebt > 0, 'NO_DEBT')
    assert(repayBaseAmount > 0 && repayBaseAmount <= liveDebt, 'BAD_REPAY')

    // USD legs (for liquidatability & seize math)
    const collateralUSD: uint64 = this.calculateCollateralValueUSD(collTok, collLSTBal, lstAppId)
    const debtUSDv: uint64 = this.debtUSD(liveDebt)
    assert(debtUSDv > 0, 'BAD_DEBT_USD')

    // CR_bps = collateralUSD * 10_000 / debtUSD
    const [hCR, lCR] = mulw(collateralUSD, BASIS_POINTS)
    const CR_bps: uint64 = divw(hCR, lCR, debtUSDv)
    assert(CR_bps <= this.liq_threshold_bps.value, 'NOT_LIQUIDATABLE')

    // Validate repayment transfer (ASA base token)
    const baseAssetId = this.base_token_id.value.native
    assertMatch(repayAxfer, {
      sender: op.Txn.sender,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(baseAssetId),
      assetAmount: repayBaseAmount,
    })

    // Seize value with bonus: seizeUSD = repayUSD * (1 + bonus)
    const basePrice = this.getOraclePrice(this.base_token_id.value) // µUSD
    const closeFactorHalf: uint64 = liveDebt / 2
    const maxRepayAllowed: uint64 = closeFactorHalf > 0 ? closeFactorHalf : liveDebt

    let repayUsed: uint64 = repayBaseAmount
    let refundAmount: uint64 = 0
    if (repayUsed > maxRepayAllowed) {
      refundAmount = repayUsed - maxRepayAllowed
      repayUsed = maxRepayAllowed
    }

    const [hRU, lRU] = mulw(repayUsed, basePrice)
    const repayUSD: uint64 = divw(hRU, lRU, USD_MICRO_UNITS)

    const bonusBps: uint64 = this.liq_bonus_bps.value // add this global param
    const [hSZ, lSZ] = mulw(repayUSD, BASIS_POINTS + bonusBps)
    const seizeUSD: uint64 = divw(hSZ, lSZ, BASIS_POINTS)

    // USD -> LST (cap to available)
    const seizeLST: uint64 = this.seizeLSTFromUSD(seizeUSD, collTok, lstAppId, collLSTBal)
    assert(seizeLST > 0, 'NOTHING_TO_SEIZE')

    // Transfer seized collateral to liquidator
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: collTok.native,
        assetAmount: seizeLST,
        fee: STANDARD_TXN_FEE,
      })
      .submit()

    const remainingLST: uint64 = collLSTBal - seizeLST
    const newDebtBase: uint64 = liveDebt - repayUsed

    // Update aggregates
    this.reduceCollateralTotal(collTok, seizeLST)
    this.total_borrows.value = this.total_borrows.value - repayUsed

    if (refundAmount > 0) {
      itxn
        .assetTransfer({
          assetReceiver: op.Txn.sender,
          xferAsset: baseAssetId,
          assetAmount: refundAmount,
          fee: STANDARD_TXN_FEE,
        })
        .submit()
    }

    if (newDebtBase === 0) {
      // Close loan and return any leftover collateral to debtor
      if (remainingLST > 0) {
        itxn
          .assetTransfer({
            assetReceiver: debtor,
            xferAsset: collTok.native,
            assetAmount: remainingLST,
            fee: STANDARD_TXN_FEE,
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

  /**
   * Liquidates an undercollateralized loan using ALGO payment
   * @param debtor - Account whose loan is being liquidated
   * @param paymentTxn - ALGO payment transaction with full debt repayment
   * @dev Similar to liquidateASA but uses ALGO payment instead of asset transfer
   * @dev Only available when collateral ratio falls below liquidation threshold
   * @dev Liquidator must repay full debt amount to claim all collateral
   */
  @abimethod({ allowActions: 'NoOp' })
  public liquidatePartialAlgo(
    debtor: Account,
    repayPay: gtxn.PaymentTxn, // liquidator pays ALGO
    repayBaseAmount: uint64, // amount to repay in microALGO (≤ live debt)
    lstAppId: uint64,
  ): void {
    assert(this.base_token_id.value.native === 0, 'BASE_NOT_ALGO')
    assert(this.loan_record(debtor).exists, 'NO_LOAN')
    this.accrueMarket()

    const rec = this.loan_record(debtor).value.copy()
    const collTok: UintN64 = rec.collateralTokenId
    const collLSTBal: uint64 = rec.collateralAmount.native
    const liveDebt: uint64 = this.currentDebtFromSnapshot(rec)
    assert(liveDebt > 0, 'NO_DEBT')
    assert(repayBaseAmount > 0 && repayBaseAmount <= liveDebt, 'BAD_REPAY')

    const collateralUSD: uint64 = this.calculateCollateralValueUSD(collTok, collLSTBal, lstAppId)
    const debtUSDv: uint64 = this.debtUSD(liveDebt)
    assert(debtUSDv > 0, 'BAD_DEBT_USD')

    const [hCR, lCR] = mulw(collateralUSD, BASIS_POINTS)
    const CR_bps: uint64 = divw(hCR, lCR, debtUSDv)
    assert(CR_bps <= this.liq_threshold_bps.value, 'NOT_LIQUIDATABLE')

    // Validate repayment transfer (ALGO)
    assertMatch(repayPay, {
      sender: op.Txn.sender,
      receiver: Global.currentApplicationAddress,
      amount: repayBaseAmount,
    })

    const basePrice = this.getOraclePrice(this.base_token_id.value) // µUSD
    const closeFactorHalf: uint64 = liveDebt / 2
    const maxRepayAllowed: uint64 = closeFactorHalf > 0 ? closeFactorHalf : liveDebt

    let repayUsed: uint64 = repayBaseAmount
    let refundAmount: uint64 = 0
    if (repayUsed > maxRepayAllowed) {
      refundAmount = repayUsed - maxRepayAllowed
      repayUsed = maxRepayAllowed
    }

    const [hRU, lRU] = mulw(repayUsed, basePrice)
    const repayUSD: uint64 = divw(hRU, lRU, USD_MICRO_UNITS)

    const bonusBps: uint64 = this.liq_bonus_bps.value
    const [hSZ, lSZ] = mulw(repayUSD, BASIS_POINTS + bonusBps)
    const seizeUSD: uint64 = divw(hSZ, lSZ, BASIS_POINTS)

    const seizeLST: uint64 = this.seizeLSTFromUSD(seizeUSD, collTok, lstAppId, collLSTBal)
    assert(seizeLST > 0, 'NOTHING_TO_SEIZE')

    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: collTok.native,
        assetAmount: seizeLST,
        fee: STANDARD_TXN_FEE,
      })
      .submit()

    if (refundAmount > 0) {
      itxn
        .payment({
          amount: refundAmount,
          receiver: op.Txn.sender,
          fee: STANDARD_TXN_FEE,
        })
        .submit()
    }

    const remainingLST: uint64 = collLSTBal - seizeLST
    const newDebtBase: uint64 = liveDebt - repayUsed

    this.reduceCollateralTotal(collTok, seizeLST)
    this.total_borrows.value = this.total_borrows.value - repayUsed

    if (newDebtBase === 0) {
      if (remainingLST > 0) {
        itxn
          .assetTransfer({
            assetReceiver: debtor,
            xferAsset: collTok.native,
            assetAmount: remainingLST,
            fee: STANDARD_TXN_FEE,
          })
          .submit()
        this.reduceCollateralTotal(collTok, remainingLST)
      }
      this.loan_record(debtor).delete()
      this.active_loan_records.value = this.active_loan_records.value - 1
    } else {
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
          changeType: new UintN8(4),
        }),
      })
      this.loan_record(debtor).value = newRec.copy()
    }

    this.last_apr_bps.value = this.current_apr_bps()
  }

  /**
   * Retrieves comprehensive status information for a borrower's loan
   * @param borrower - Account address to get loan status for
   * @returns Object containing debt amount, collateral value, ratios, and liquidation eligibility
   * @dev Simulates interest accrual to provide most up-to-date status
   * @dev Includes eligibility flags for liquidation and buyout actions
   */
  @abimethod({ allowActions: 'NoOp' })
  getLoanStatus(borrower: Account): {
    outstandingDebt: uint64
    collateralValueUSD: uint64
    collateralAmount: uint64
    collateralRatioBps: uint64
    liquidationThresholdBps: uint64
    eligibleForLiquidation: boolean
    eligibleForBuyout: boolean
  } {
    assert(this.loan_record(borrower).exists, 'Loan record does not exist')
    const record = this.loan_record(borrower).value.copy()
    this.accrueMarket()
    const debt: uint64 = this.currentDebtFromSnapshot(record)
    const collateralAmount: uint64 = record.collateralAmount.native
    const liqBps: uint64 = this.liq_threshold_bps.value

    const oraclePrice = this.getOraclePrice(record.collateralTokenId)
    const [hi, lo] = mulw(collateralAmount, oraclePrice)
    const collateralValueUSD = divw(hi, lo, 1)

    const CR: uint64 = (collateralValueUSD * BASIS_POINTS) / debt
    const eligibleForLiquidation = CR < liqBps
    const eligibleForBuyout = CR > liqBps

    return {
      outstandingDebt: debt,
      collateralValueUSD: collateralValueUSD,
      collateralAmount: collateralAmount,
      collateralRatioBps: CR,
      liquidationThresholdBps: liqBps,
      eligibleForLiquidation,
      eligibleForBuyout,
    }
  }

  gas(): void {}

  private validateBorrowRequest(
    assetTransferTxn: gtxn.AssetTransferTxn,
    collateralAmount: uint64,
    collateralTokenId: UintN64,
    mbrTxn: gtxn.PaymentTxn,
  ): void {
    assertMatch(mbrTxn, { amount: VALIDATE_BORROW_FEE })

    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: collateralAmount,
    })

    assert(this.collateralExists(collateralTokenId), 'unsupported collateral')
  }

  public calculateCollateralValueUSD(collateralTokenId: UintN64, collateralAmount: uint64, lstApp: uint64): uint64 {
    // 1) Get LST exchange rate: (totalDeposits / circulatingLST)
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstApp,
      fee: STANDARD_TXN_FEE,
    }).returnValue

    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstApp,
      fee: STANDARD_TXN_FEE,
    }).returnValue

    // underlyingCollateral = (collateralAmount * totalDeposits) / circulatingLST
    const [hC, lC] = mulw(totalDepositsExternal, collateralAmount)
    const underlyingCollateral = divw(hC, lC, circulatingExternalLST)

    // 2) Get oracle price of the *base token*, not the LST itself
    const lstCollateral = this.getCollateral(collateralTokenId)
    const baseTokenId = lstCollateral.baseAssetId

    const baseTokenPrice = this.getOraclePrice(baseTokenId)

    // 3) Convert underlying collateral → USD
    const [hU, lU] = mulw(underlyingCollateral, baseTokenPrice)
    const collateralUSD = divw(hU, lU, USD_MICRO_UNITS)

    return collateralUSD
  }

  private validateLoanAmount(requestedLoanAmount: uint64, maxBorrowUSD: uint64, baseTokenOraclePrice: uint64): uint64 {
    // Convert requested loan to USD
    const [rH, rL] = mulw(requestedLoanAmount, baseTokenOraclePrice)
    const requestedLoanUSD = divw(rH, rL, USD_MICRO_UNITS)

    // Store for debugging
    this.last_requested_loan.value = requestedLoanUSD
    this.debug_diff.value = maxBorrowUSD - requestedLoanUSD

    assert(requestedLoanUSD <= maxBorrowUSD, 'exceeds LTV limit')

    return requestedLoanUSD
  }

  private calculateDisbursement(requestedAmount: uint64): { disbursement: uint64; fee: uint64 } {
    const fee: uint64 = (requestedAmount * this.origination_fee_bps.value) / BASIS_POINTS
    const disbursement: uint64 = requestedAmount - fee

    this.fee_pool.value += fee
    this.last_scaled_down_disbursement.value = disbursement

    return { disbursement, fee }
  }

  private processLoanTopUp(
    borrower: Account,
    collateralAmount: uint64,
    disbursement: uint64,
    maxBorrowUSD: uint64,
    baseTokenOraclePrice: uint64,
    requestedLoanAmount: uint64,
    collateralTokenId: UintN64,
  ): void {
    const existingLoan = this.getLoanRecord(borrower)
    // 1) Bring borrower snapshot current (uses global index)
    const liveDebt: uint64 = this.syncBorrowerSnapshot(borrower)

    // 2) LTV check stays the same but use liveDebt instead of iar.totalDebt
    const [h1, l1] = mulw(liveDebt, baseTokenOraclePrice)
    const oldLoanUSD = divw(h1, l1, USD_MICRO_UNITS)
    // ... compute totalRequestedUSD etc (unchanged) ...

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
  private disburseFunds(borrower: Account, amount: uint64): void {
    if (this.base_token_id.value.native === 0) {
      itxn
        .payment({
          receiver: borrower,
          amount: amount,
          fee: STANDARD_TXN_FEE,
        })
        .submit()
    } else {
      itxn
        .assetTransfer({
          assetReceiver: borrower,
          xferAsset: this.base_token_id.value.native,
          assetAmount: amount,
          fee: STANDARD_TXN_FEE,
        })
        .submit()
    }
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
