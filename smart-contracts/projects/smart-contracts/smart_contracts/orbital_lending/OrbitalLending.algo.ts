/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/explicit-member-accessibility */
import { Account, bytes, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
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
  BUYOUT_MBR,
  DEPOSIT_MBR,
  DebtChange,
  DepositRecord,
  DepositRecordKey,
  INDEX_SCALE,
  LoanRecord,
  MIGRATION_FEE,
  MINIMUM_ADDITIONAL_REWARD,
  MigrationSnapshot,
} from './config.algo'
import { TokenPrice } from '../Oracle/config.algo'
import {
  MBR_COLLATERAL,
  MBR_CREATE_APP,
  MBR_INIT_APP,
  MBR_OPT_IN_LST,
  STANDARD_TXN_FEE,
  BASIS_POINTS,
  VALIDATE_BORROW_FEE,
  USD_MICRO_UNITS,
  SECONDS_PER_YEAR,
} from './config.algo'

const CONTRACT_VERSION: uint64 = 2000

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

  /** External oracle application for user flux tier feeds */
  flux_oracle_app = GlobalState<Application>()

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
  // MIGRATION
  // ═══════════════════════════════════════════════════════════════════════

  /** Dedicated account that temporarily receives balances during migration */
  migration_admin = GlobalState<Account>()

  // ═══════════════════════════════════════════════════════════════════════
  // DEBUG & OPERATIONAL TRACKING
  // ═══════════════════════════════════════════════════════════════════════

  contract_state = GlobalState<UintN64>() // 0 = inactive, 1 = active, 2 = migrating

  contract_version = GlobalState<UintN64>() // contract version number

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
    this.migration_admin.value = admin
    this.contract_state.value = new UintN64(0) // inactive
    this.contract_version.value = new UintN64(CONTRACT_VERSION)
  }

  /*
   * Initializes the lending protocol with core parameters and configurations
   * @param mbrTxn - Payment transaction covering minimum balance requirements
   * @param ltv_bps - Loan-to-Value ratio in basis points (e.g., 7500 = 75%)
   * @param liq_threshold_bps - Liquidation threshold in basis points (e.g., 8500 = 85%)
   * @param liq_bonus_bps - Liquidation bonus in basis points (e.g., 500 = 5% bonus to liquidators)
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
    oracle_app_id: Application,
    buyout_token_id: uint64,
    additional_rewards_commission_percentage: uint64,
    flux_oracle_app_id: Application,
  ): void {
    assert(op.Txn.sender === this.admin_account.value)

    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      receiver: Global.currentApplicationAddress,
      amount: MBR_CREATE_APP,
    })

    assert(additional_rewards_commission_percentage <= 100, 'COMMISSION_TOO_HIGH')

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
    this.prev_apr_bps.value = 50 // Same as base_bps by default
    this.util_ema_bps.value = 0 // No utilization EMA by default
    this.power_gamma_q16.value = 0 // No power curve by default
    this.scarcity_K_bps.value = 0 // No scarcity parameter by default
    this.borrow_index_wad.value = INDEX_SCALE
    this.last_accrual_ts.value = Global.latestTimestamp
    this.last_apr_bps.value = this.base_bps.value
    this.buyout_token_id.value = new UintN64(buyout_token_id)
    this.liq_bonus_bps.value = liq_bonus_bps
    this.total_commission_earned.value = 0
    this.current_accumulated_commission.value = 0
    this.commission_percentage.value = additional_rewards_commission_percentage
    this.cash_on_hand.value = 0
    this.total_additional_rewards.value = 0
    this.flux_oracle_app.value = flux_oracle_app_id

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
  @abimethod({ allowActions: 'NoOp' })
  public setRateParams(
    base_bps: uint64,
    util_cap_bps: uint64,
    kink_norm_bps: uint64,
    slope1_bps: uint64,
    slope2_bps: uint64,
    max_apr_bps: uint64,
    max_apr_step_bps: uint64,
    ema_alpha_bps: uint64,
    power_gamma_q16: uint64,
    scarcity_K_bps: uint64,
    rate_model_type: uint64, // or uint8
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
    this.base_bps.value = base_bps
    this.util_cap_bps.value = util_cap_bps
    this.kink_norm_bps.value = kink_norm_bps
    this.slope1_bps.value = slope1_bps
    this.slope2_bps.value = slope2_bps
    this.max_apr_bps.value = max_apr_bps
    this.max_apr_step_bps.value = max_apr_step_bps
    this.rate_model_type.value = rate_model_type
    this.liq_bonus_bps.value = liq_bonus_bps
    this.ema_alpha_bps.value = ema_alpha_bps
    this.power_gamma_q16.value = power_gamma_q16
    this.scarcity_K_bps.value = scarcity_K_bps
    // Optional: clamp prev_apr if a new max is lower
    if (this.max_apr_bps.value > 0 && this.prev_apr_bps.value > this.max_apr_bps.value) {
      this.prev_apr_bps.value = this.max_apr_bps.value
    }
  }

  @abimethod({ allowActions: 'NoOp' })
  public setContractState(state: uint64): void {
    assert(op.Txn.sender === this.admin_account.value || op.Txn.sender === this.migration_admin.value, 'UNAUTHORIZED')
    assert(state <= 2, 'INVALID_STATE') // 0=inactive,1=active,2=migrating
    this.contract_state.value = new UintN64(state)
  }

  /**
   * Sets or updates the migration administrator account used during contract upgrades.
   * @param migrationAdmin Account that will temporarily custody balances while migrating.
   */
  @abimethod({ allowActions: 'NoOp' })
  public setMigrationAdmin(migrationAdmin: Account): void {
    assert(op.Txn.sender === this.admin_account.value, 'UNAUTHORIZED')
    this.migration_admin.value = migrationAdmin
  }

  /**
   * Generates a new LST (Liquidity Staking Token) for the base lending token.
   * @param mbrTxn Payment transaction covering asset-creation minimum balance.
   * @dev Admin-only path that mints a brand-new LST mirroring the base token supply.
   */
  @abimethod({ allowActions: 'NoOp' })
  public generateLSTToken(mbrTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.admin_account.value)
    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      receiver: Global.currentApplicationAddress,
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
   * Opts into an externally created LST token instead of minting a new one.
   * @param lstAssetId Asset ID of the pre-existing LST contract.
   * @param mbrTxn Payment covering the opt-in minimum balance requirement.
   * @dev Admin-only. Use when an LST has already been deployed for this market.
   */
  @abimethod({ allowActions: 'NoOp' })
  public optInToLST(lstAssetId: uint64, mbrTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.admin_account.value)
    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      receiver: Global.currentApplicationAddress,
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
   * Configures the LST token by seeding the initial circulating supply.
   * @param axferTxn Asset transfer from the admin delivering LST units to the app.
   * @param circulating_lst Initial circulating amount to record on-chain.
   * @dev Must be called after `generateLSTToken` or `optInToLST` to finalize setup.
   */
  @abimethod({ allowActions: 'NoOp' })
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
   * Retrieves current price for a token from the configured oracle
   * @param tokenId - Asset ID of the token to get price for
   * @returns Current price of the token from oracle (in USD micro-units)
   * @dev Calls external oracle contract to fetch real-time price data
   */
  private getOraclePrice(tokenId: UintN64): uint64 {
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
      marketBaseAssetId: collateral.marketBaseAssetId,
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
      marketBaseAssetId: collateral.marketBaseAssetId,
      totalCollateral: new UintN64(newTotal),
      originatingAppId: collateral.originatingAppId,
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
  public addNewCollateralType(
    collateralTokenId: UintN64,
    collateralBaseTokenId: UintN64,
    mbrTxn: gtxn.PaymentTxn,
    originatingAppId: UintN64,
  ): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assert(op.Txn.sender === this.admin_account.value, 'UNAUTHORIZED')
    assert(collateralTokenId.native !== baseToken.id, 'CANNOT_USE_BASE_AS_COLLATERAL')
    assert(!this.collateralExists(collateralTokenId), 'COLLATERAL_ALREADY_EXISTS')
    assertMatch(
      mbrTxn,
      {
        sender: this.admin_account.value,
        receiver: Global.currentApplicationAddress,
        amount: MBR_COLLATERAL,
      },
      'INSUFFICIENT_MBR',
    )

    const newAcceptedCollateral: AcceptedCollateral = new AcceptedCollateral({
      assetId: collateralTokenId,
      baseAssetId: collateralBaseTokenId,
      marketBaseAssetId: this.base_token_id.value,
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
        fee: STANDARD_TXN_FEE,
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
    const [highBits1, lowBits1] = mulw(this.circulating_lst.value, BASIS_POINTS)

    const lstRatio = divw(highBits1, lowBits1, this.total_deposits.value)

    const [highBits2, lowBits2] = mulw(lstRatio, amount)
    return divw(highBits2, lowBits2, BASIS_POINTS)
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
    const [hi, lo] = mulw(totalDepositsExternal, amount)
    return divw(hi, lo, circulatingExternalLST)
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
  public depositAlgo(depositTxn: gtxn.PaymentTxn, amount: uint64, mbrTxn: gtxn.PaymentTxn): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    assertMatch(depositTxn, {
      receiver: Global.currentApplicationAddress,
      amount: amount,
    })
    assertMatch(mbrTxn, {
      sender: op.Txn.sender,
      receiver: Global.currentApplicationAddress,
      amount: DEPOSIT_MBR,
    })
    this.addCash(amount)

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
  public withdrawDeposit(
    assetTransferTxn: gtxn.AssetTransferTxn,
    amount: uint64,
    lstAppId: uint64,
    mbrTxn: gtxn.PaymentTxn,
  ): void {
    const lstAsset = Asset(this.lst_token_id.value.native)
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: lstAsset,
      assetAmount: amount,
    })

    assertMatch(mbrTxn, {
      sender: op.Txn.sender,
      receiver: Global.currentApplicationAddress,
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
    this.removeCash(asaDue)

    assert(Global.currentApplicationAddress.balance - Global.currentApplicationAddress.minBalance >= asaDue)

    itxn
      .payment({
        receiver: op.Txn.sender,
        amount: asaDue,
        fee: STANDARD_TXN_FEE,
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
      const newAmount: uint64 = existingRecord.depositAmount.native - amount

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
  public borrow(
    assetTransferTxn: gtxn.AssetTransferTxn,
    requestedLoanAmount: uint64,
    collateralAmount: uint64,
    lstApp: uint64,
    collateralTokenId: UintN64,
    mbrTxn: gtxn.PaymentTxn,
  ): void {
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    // ─── 0. Determine if this is a top-up or a brand-new loan ─────────────
    const hasLoan = this.loan_record(op.Txn.sender).exists
    const _interestSlice = this.accrueMarket()
    let collateralToUse: uint64 = 0
    if (hasLoan) {
      const existingCollateral = this.getLoanRecord(op.Txn.sender).collateralAmount
      collateralToUse = existingCollateral.native + collateralAmount
    } else {
      collateralToUse = collateralAmount
    }
    this.validateBorrowRequest(assetTransferTxn, collateralAmount, collateralTokenId, mbrTxn)
    const collateralUSD = this.calculateCollateralValueUSD(collateralTokenId, collateralToUse, lstApp)
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
        fee: STANDARD_TXN_FEE,
        apps: [this.flux_oracle_app.value],
        accounts: [op.Txn.sender],
      }).returnValue
    }
    const calculatedFee = this.computeFees(requestedLoanAmount, userTier.native)

    const { disbursement } = this.calculateDisbursement(requestedLoanAmount, calculatedFee)

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

  @abimethod({ allowActions: 'NoOp' })
  public addLoanRecordExternal(
    disbursement: uint64,
    collateralTokenId: UintN64,
    borrowerAddress: Account,
    collateralAmount: uint64,
  ): void {
    assert(op.Txn.sender === this.admin_account.value, 'UNAUTHORIZED')
    this.mintLoanRecord(disbursement, collateralTokenId, borrowerAddress, collateralAmount)
    this.updateCollateralTotal(collateralTokenId, collateralAmount)
    this.total_borrows.value = this.total_borrows.value + disbursement
    this.last_apr_bps.value = this.current_apr_bps()
  }

  @abimethod({ allowActions: 'NoOp' })
  public accrueLoanInterest(debtor: Account, templateReserveAddress: Account): void {
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
    const apr = this.rate_model_type.value === 0 ? this.apr_bps_kinked(U_used) : this.base_bps.value // Fixed APR fallback

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

    // tmp = last_apr_bps * deltaT
    const [h1, l1] = mulw(this.last_apr_bps.value, deltaT)
    // tmp2 = tmp / SECONDS_PER_YEAR  (still in "bps")
    const tmp2: uint64 = divw(h1, l1, SECONDS_PER_YEAR)

    // simpleWad = (INDEX_SCALE * tmp2) / BASIS_POINTS
    const [h2, l2] = mulw(INDEX_SCALE, tmp2)
    const simpleWad: uint64 = divw(h2, l2, BASIS_POINTS)
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

    /*    if (deltaT < SECONDS_PER_YEAR) {
      deltaT = 10000
    }
    this.last_apr_bps.value = 5000 */

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
   * Repays a loan using ALGO and optionally releases collateral
   * @param paymentTxn - Payment transaction sending ALGO repayment to contract
   * @param amount - Amount of ALGO being repaid (in microALGOs)
   * @param templateReserveAddress - Reserve address for potential future use
   * @dev Similar to repayLoanASA but specifically for ALGO repayments
   * @dev Accrues interest before processing repayment
   * @dev Full repayment closes loan and returns all collateral
   */
  @abimethod({ allowActions: 'NoOp' })
  public repayLoanAlgo(paymentTxn: gtxn.PaymentTxn, repaymentAmount: uint64): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
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
    this.addCash(repaymentAmount)

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

  /**
   * Withdraws accumulated protocol fees and commission to the admin-controlled account.
   * @param paymentReceiver Address receiving the payout.
   * @param feeTxn Separate payment covering inner-transaction fees.
   */
  @abimethod({ allowActions: 'NoOp' })
  public withdrawPlatformFees(paymentReceiver: Account, feeTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.admin_account.value, 'UNAUTHORIZED')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    assertMatch(feeTxn, {
      sender: op.Txn.sender,
      receiver: Global.currentApplicationAddress,
      amount: STANDARD_TXN_FEE,
    })
    const payout: uint64 = this.fee_pool.value + this.current_accumulated_commission.value
    if (payout > 0) {
      itxn
        .payment({
          receiver: paymentReceiver,
          amount: payout,
          fee: STANDARD_TXN_FEE,
        })
        .submit()

      this.removeCash(payout)
      this.fee_pool.value = 0
      this.current_accumulated_commission.value = 0
    }
  }

  /**
   * Purchases a borrower's collateral at a premium using ALGO payment
   * @param buyer - Account that will receive the collateral
   * @param debtor - Account whose loan is being bought out
   * @param premiumAxferTxn - Asset transfer transaction with buyout token payment (xUSD)
   * @param repayPayTxn - ALGO payment transaction with base token repayment
   * @param lstAppId - The LST app backing the collateral
   * @dev Similar to buyoutASA but uses ALGO payment instead of asset transfer
   * @dev Buyout price includes premium based on how far below liquidation threshold the LTV sits
   * @dev Only available when loan LTV is strictly below the liquidation threshold
   */
  @abimethod({ allowActions: 'NoOp' })
  public buyoutSplitAlgo(
    buyer: Account,
    debtor: Account,
    premiumAxferTxn: gtxn.AssetTransferTxn, // buyout token (xUSD) PREMIUM
    repayPayTxn: gtxn.PaymentTxn, // ALGO DEBT repayment
    lstAppId: uint64,
    mbrTxn: gtxn.PaymentTxn,
  ): void {
    assert(this.loan_record(debtor).exists, 'NO_LOAN_RECORD')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')

    // 1) Make time current
    this.accrueMarket()

    assertMatch(mbrTxn, {
      sender: op.Txn.sender,
      receiver: Global.currentApplicationAddress,
      amount: BUYOUT_MBR,
    })

    const rec = this.loan_record(debtor).value.copy()
    const collateralAmount: uint64 = rec.collateralAmount.native
    const collateralTokenId: UintN64 = rec.collateralTokenId

    const debtBase: uint64 = this.currentDebtFromSnapshot(rec)
    assert(debtBase > 0, 'NO_DEBT')

    // 2) USD legs
    const collateralUSD: uint64 = this.calculateCollateralValueUSD(collateralTokenId, collateralAmount, lstAppId)
    const debtUSDv: uint64 = this.debtUSD(debtBase)
    assert(debtUSDv > 0, 'BAD_DEBT_USD')
    assert(collateralUSD > 0, 'BAD_COLLATERAL_USD')

    const [hLTV, lLTV] = mulw(debtUSDv, BASIS_POINTS)
    const ltvBps: uint64 = divw(hLTV, lLTV, collateralUSD)

    assert(ltvBps < this.liq_threshold_bps.value, 'NOT_BUYOUT_ELIGIBLE')

    const [hR, lR] = mulw(this.liq_threshold_bps.value, BASIS_POINTS)
    const ratio_bps: uint64 = divw(hR, lR, ltvBps)
    const premiumRateBps: uint64 = ratio_bps - BASIS_POINTS

    const [hP, lP] = mulw(collateralUSD, premiumRateBps)
    const premiumUSD: uint64 = divw(hP, lP, BASIS_POINTS)

    // 3) Premium in buyout token
    const buyoutTokenId: uint64 = this.buyout_token_id.value.native
    const buyoutTokenPrice: uint64 = this.getOraclePrice(this.buyout_token_id.value)

    const [hPT, lPT] = mulw(premiumUSD, USD_MICRO_UNITS)
    const premiumTokens: uint64 = buyoutTokenPrice === 0 ? 0 : divw(hPT, lPT, buyoutTokenPrice)

    assert(premiumAxferTxn.assetReceiver === Global.currentApplicationAddress, 'INVALID_RECEIVER')
    assert(premiumAxferTxn.xferAsset === Asset(buyoutTokenId), 'INVALID_XFER_ASSET')
    assert(premiumAxferTxn.assetAmount >= premiumTokens, 'INVALID_BUYOUT_AMOUNT')

    const paidAmount: uint64 = premiumAxferTxn.assetAmount
    const refund: uint64 = paidAmount - premiumTokens

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
      originatingAppId: acVal.originatingAppId,
    }).copy()

    this.total_borrows.value = this.total_borrows.value - debtBase
    this.addCash(debtBase)

    this.splitPremium(premiumTokens, buyoutTokenId, debtor)

    if (refund > 0) {
      itxn
        .assetTransfer({
          assetReceiver: buyer,
          xferAsset: buyoutTokenId,
          assetAmount: refund,
          fee: STANDARD_TXN_FEE,
        })
        .submit()
    }

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

  /**
   * Converts a base-token debt amount into USD micro-units using the oracle price.
   * @param debtBaseUnits Debt amount measured in base-token micro units.
   * @returns Equivalent value denominated in USD micro-units.
   */
  private debtUSD(debtBaseUnits: uint64): uint64 {
    const baseTokenPrice: uint64 = this.getOraclePrice(this.base_token_id.value) // price of market base token
    const [h, l] = mulw(debtBaseUnits, baseTokenPrice)
    return divw(h, l, USD_MICRO_UNITS) // micro-USD
  }

  /**
   * Computes how much LST collateral the caller can withdraw using live market data.
   * @param lstAppId External LST app backing the collateral.
   * @returns Maximum withdrawable LST balance for the borrower.
   */
  @abimethod({ allowActions: 'NoOp' })
  public maxWithdrawableCollateralLST(lstAppId: uint64): uint64 {
    assert(this.loan_record(op.Txn.sender).exists, 'NO_LOAN')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    this.accrueMarket()

    const rec = this.loan_record(op.Txn.sender).value.copy()
    const collateral = this.getCollateral(rec.collateralTokenId)
    assert(collateral.originatingAppId.native === lstAppId, 'mismatched LST app')

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

  /**
   * Local helper mirroring `maxWithdrawableCollateralLST` without ABI overhead.
   * @param borrower Account whose collateral capacity is being evaluated.
   * @param lstAppId External LST app that priced the collateral.
   * @returns Maximum withdrawable LST amount using cached state.
   */
  private maxWithdrawableCollateralLSTLocal(borrower: Account, lstAppId: uint64): uint64 {
    assert(this.loan_record(borrower).exists, 'NO_LOAN')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
    this.accrueMarket()

    const rec = this.loan_record(borrower).value.copy()
    const collateral = this.getCollateral(rec.collateralTokenId)
    assert(collateral.originatingAppId.native === lstAppId, 'mismatched LST app')
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

  /**
   * Allows borrowers to withdraw a portion of their collateral within safety limits.
   * @param amountLST Amount of LST being withdrawn.
   * @param collateralTokenId Asset ID of the collateral LST.
   * @param lstAppId LST application ID used for exchange-rate validation.
   */
  @abimethod({ allowActions: 'NoOp' })
  public withdrawCollateral(amountLST: uint64, collateralTokenId: uint64, lstAppId: uint64): void {
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
    assert(acVal.originatingAppId.native === lstAppId, 'mismatched LST app')

    const maxSafe = this.maxWithdrawableCollateralLSTLocal(borrower, lstAppId)
    assert(amountLST <= maxSafe, 'EXCEEDS_MAX_SAFE')
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
    const [hUnd, lUnd] = mulw(seizeUSD, USD_MICRO_UNITS)
    const seizeUnderlying: uint64 = divw(hUnd, lUnd, underlyingPrice)

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
    const [hSeizeUSD, lSeizeUSD] = mulw(seizedUnderlying, underlyingPrice)
    const seizeUSDActual: uint64 = divw(hSeizeUSD, lSeizeUSD, USD_MICRO_UNITS)

    const [hRepayUSD, lRepayUSD] = mulw(seizeUSDActual, BASIS_POINTS)
    const repayUSD: uint64 = divw(hRepayUSD, lRepayUSD, BASIS_POINTS + bonusBps)

    const [hRepayBase, lRepayBase] = mulw(repayUSD, USD_MICRO_UNITS)
    const repayBase: uint64 = divw(hRepayBase, lRepayBase, basePrice)

    return repayBase
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
   * Liquidates an undercollateralized loan using ALGO payment
   * @param debtor - Account whose loan is being liquidated
   * @param paymentTxn - ALGO payment transaction with full debt repayment
   * @dev Similar to liquidateASA but uses ALGO payment instead of asset transfer
   * @dev Only available when loan LTV meets or exceeds the liquidation threshold
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
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')
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
    assert(collateralUSD > 0, 'BAD_COLLATERAL_USD')

    const [hLTV, lLTV] = mulw(debtUSDv, BASIS_POINTS)
    const ltvBps: uint64 = divw(hLTV, lLTV, collateralUSD)
    assert(ltvBps >= this.liq_threshold_bps.value, 'NOT_LIQUIDATABLE')

    // Validate repayment transfer (ALGO)
    assertMatch(repayPay, {
      sender: op.Txn.sender,
      receiver: Global.currentApplicationAddress,
      amount: repayBaseAmount,
    })

    const basePrice = this.getOraclePrice(this.base_token_id.value) // µUSD
    const closeFactorHalf: uint64 = liveDebt / 2
    const maxRepayAllowed: uint64 = closeFactorHalf > 0 ? closeFactorHalf : liveDebt

    const bonusBps: uint64 = this.liq_bonus_bps.value
    const isFullRepayRequest = repayBaseAmount === liveDebt

    let repayCandidate: uint64 = repayBaseAmount
    if (!isFullRepayRequest && repayCandidate > maxRepayAllowed) {
      repayCandidate = maxRepayAllowed
    }

    const [hRU, lRU] = mulw(repayCandidate, basePrice)
    const repayUSD: uint64 = divw(hRU, lRU, USD_MICRO_UNITS)

    const [hSZ, lSZ] = mulw(repayUSD, BASIS_POINTS + bonusBps)
    const seizeUSD: uint64 = divw(hSZ, lSZ, BASIS_POINTS)

    const seizeLST: uint64 = this.seizeLSTFromUSD(seizeUSD, collTok, lstAppId, collLSTBal)
    assert(seizeLST > 0, 'NOTHING_TO_SEIZE')

    let repaySupported: uint64 = this.repayBaseFromSeizedLST(seizeLST, collTok, lstAppId, bonusBps, basePrice)
    if (repaySupported > liveDebt) {
      repaySupported = liveDebt
    }

    if (seizeLST === collLSTBal) {
      repayCandidate = repayBaseAmount
    }

    const proposedRepayUsed: uint64 = repayCandidate <= repaySupported ? repayCandidate : repaySupported

    if (!isFullRepayRequest && seizeLST === collLSTBal && proposedRepayUsed < liveDebt) {
      assert(false, 'FULL_REPAY_REQUIRED')
    }

    const repayUsed: uint64 = isFullRepayRequest ? repayBaseAmount : proposedRepayUsed
    assert(repayUsed > 0, 'ZERO_REPAY_USED')
    const refundAmount: uint64 = isFullRepayRequest ? 0 : repayBaseAmount - repayUsed

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
      this.removeCash(refundAmount)
    }

    const remainingLST: uint64 = collLSTBal - seizeLST
    const newDebtBase: uint64 = liveDebt - repayUsed

    this.reduceCollateralTotal(collTok, seizeLST)
    this.total_borrows.value = this.total_borrows.value - repayUsed
    this.addCash(repayUsed)

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
  public getLoanStatus(borrower: Account): {
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
    const collateralRecord = this.getCollateral(record.collateralTokenId)
    this.accrueMarket()
    const debt: uint64 = this.currentDebtFromSnapshot(record)
    const collateralAmount: uint64 = record.collateralAmount.native
    const liqBps: uint64 = this.liq_threshold_bps.value

    const collateralValueUSD: uint64 = this.calculateCollateralValueUSD(
      record.collateralTokenId,
      collateralAmount,
      collateralRecord.originatingAppId.native,
    )

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

  /**
   * No-op method kept for compatibility with interfaces that expect a gas entry point.
   */
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
    mbrTxn: gtxn.PaymentTxn,
  ): void {
    assertMatch(mbrTxn, {
      sender: op.Txn.sender,
      receiver: Global.currentApplicationAddress,
      amount: VALIDATE_BORROW_FEE,
    })

    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: collateralAmount,
      xferAsset: Asset(collateralTokenId.native),
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
  @abimethod({ allowActions: 'NoOp' })
  public calculateCollateralValueUSD(collateralTokenId: UintN64, collateralAmount: uint64, lstApp: uint64): uint64 {
    // get collateral and check inputs match
    assert(this.collateralExists(collateralTokenId), 'unknown collateral')
    const collateralInfo = this.getCollateral(collateralTokenId)
    assert(collateralInfo.originatingAppId.native === lstApp, 'mismatched LST app')
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

  /**
   * Validates a requested loan amount against LTV and utilization caps.
   * @param requestedLoanAmount Loan amount expressed in base-token units.
   * @param maxBorrowUSD USD borrowing limit derived from collateral.
   * @param baseTokenOraclePrice Oracle price for the base token.
   * @returns Requested loan converted to USD micro-units.
   */
  private validateLoanAmount(requestedLoanAmount: uint64, maxBorrowUSD: uint64, baseTokenOraclePrice: uint64): uint64 {
    // Convert requested loan to USD
    const [rH, rL] = mulw(requestedLoanAmount, baseTokenOraclePrice)
    const requestedLoanUSD = divw(rH, rL, USD_MICRO_UNITS)

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
  /**
   * Sends base-token funds to the borrower via inner transactions.
   * @param borrower Borrower receiving the funds.
   * @param amount Amount of base asset to disburse.
   */
  private disburseFunds(borrower: Account, amount: uint64): void {
    itxn
      .payment({
        receiver: borrower,
        amount: amount,
        fee: STANDARD_TXN_FEE,
      })
      .submit()
  }

  /**
   * Harvests newly accrued consensus rewards for ALGO-based markets.
   * @dev Admin-only; credits rewards to deposits and commissions to fee buckets.
   */
  @abimethod({ allowActions: 'NoOp' })
  public pickupAlgoRewards(): void {
    assert(op.Txn.sender === this.admin_account.value, 'Only admin can pickup rewards')
    assert(this.contract_state.value.native === 1, 'CONTRACT_NOT_ACTIVE')

    const spendable: uint64 = Global.currentApplicationAddress.balance - Global.currentApplicationAddress.minBalance

    if (spendable <= this.cash_on_hand.value) {
      return // no new consensus payout to harvest
    }

    const rawReward: uint64 = spendable - this.cash_on_hand.value
    if (rawReward <= MINIMUM_ADDITIONAL_REWARD) {
      return // defer tiny rewards
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

  @abimethod({ allowActions: 'NoOp' })
  public migrateCollateralTokenId(collateralTokenId: uint64, mbrTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.migration_admin.value, 'Only migration admin can migrate collateral')
    const collateralBalance = Asset(collateralTokenId).balance(Global.currentApplicationAddress)
    if (collateralBalance > 0) {
      itxn
        .assetTransfer({
          assetReceiver: this.migration_admin.value,
          xferAsset: collateralTokenId,
          assetAmount: collateralBalance,
          fee: STANDARD_TXN_FEE,
        })
        .submit()
    }
  }
  /**
   * Initiates migration by sweeping balances from this contract to the migration administrator.
   * @param feeTxn Payment covering all inner-transaction fees required for the sweep.
   * @param snapshot Snapshot of accounting fields expected to be exported to the new deployment.
   */
  @abimethod({ allowActions: 'NoOp' })
  public migrateContract(feeTxn: gtxn.PaymentTxn): MigrationSnapshot {
    assert(op.Txn.sender === this.migration_admin.value, 'Only migration admin can migrate')
    this.setContractState(2) // set to migrating
    assertMatch(feeTxn, {
      sender: this.migration_admin.value,
      receiver: Global.currentApplicationAddress,
      amount: MIGRATION_FEE,
    })
    this.goOffline()

    //get lst balance
    const lstAsset = Asset(this.lst_token_id.value.native)
    const lstBalance = lstAsset.balance(Global.currentApplicationAddress)

    //send LST
    itxn
      .assetTransfer({
        assetReceiver: this.migration_admin.value,
        xferAsset: this.lst_token_id.value.native,
        assetAmount: lstBalance,
        fee: STANDARD_TXN_FEE,
      })
      .submit()

    if (this.base_token_id.value.native === 0) {
      //send ALGO
      const algoBalance: uint64 =
        Global.currentApplicationAddress.balance - Global.currentApplicationAddress.minBalance - STANDARD_TXN_FEE
      if (algoBalance > 0) {
        itxn
          .payment({
            receiver: this.migration_admin.value,
            amount: algoBalance,
            fee: STANDARD_TXN_FEE,
          })
          .submit()
      }
    } else {
      //send ASA
      const baseAsset = Asset(this.base_token_id.value.native)
      const assetBalance = baseAsset.balance(Global.currentApplicationAddress)
      if (assetBalance > 0) {
        itxn
          .assetTransfer({
            assetReceiver: this.migration_admin.value,
            xferAsset: this.base_token_id.value.native,
            assetAmount: assetBalance,
            fee: STANDARD_TXN_FEE,
          })
          .submit()
      }
    }

    return new MigrationSnapshot({
      accepted_collaterals_count: new UintN64(this.accepted_collaterals_count.value),
      cash_on_hand: new UintN64(this.cash_on_hand.value),
      circulating_lst: new UintN64(this.circulating_lst.value),
      total_deposits: new UintN64(this.total_deposits.value),
      total_borrows: new UintN64(this.total_borrows.value),
      total_additional_rewards: new UintN64(this.total_additional_rewards.value),
      total_commission_earned: new UintN64(this.total_commission_earned.value),
      current_accumulated_commission: new UintN64(this.current_accumulated_commission.value),
      fee_pool: new UintN64(this.fee_pool.value),
      borrowIndexWad: new UintN64(this.borrow_index_wad.value),
      base_token_id: new UintN64(this.base_token_id.value.native),
      lst_token_id: new UintN64(this.lst_token_id.value.native),
      buyout_token_id: new UintN64(this.buyout_token_id.value.native),
      commission_percentage: new UintN64(this.commission_percentage.value),
      liq_bonus_bps: new UintN64(this.liq_bonus_bps.value),
      active_loan_records: new UintN64(this.active_loan_records.value),
    })
  }

  /**
   * Finalises migration by importing balances and restoring accounting on the new contract.
   * @param lstTransferTxn LST asset transfer from the migration admin to this contract.
   * @param algoFundingTxn ALGO payment accompanying the migration to restore cash on hand.
   * @param baseAssetTransferTxn Base-token asset transfer (ignored when base token is ALGO).
   * @param snapshot Snapshot of accounting fields that should be set on the new deployment.
   * @param migrationAdmin Account expected to have initiated the migration.
   */
  @abimethod({ allowActions: 'NoOp' })
  public acceptMigrationAlgoContract(
    lstTransferTxn: gtxn.AssetTransferTxn,
    algoTxn: gtxn.PaymentTxn,
    snapshot: MigrationSnapshot,
    migrationAdmin: Account,
  ): void {
    assert(op.Txn.sender === this.migration_admin.value, 'Only migration admin can accept migration')

    assertMatch(lstTransferTxn, {
      sender: migrationAdmin,
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(this.lst_token_id.value.native),
    })
    assertMatch(algoTxn, {
      sender: migrationAdmin,
      receiver: Global.currentApplicationAddress,
    })
    //set accounting state
    this.cash_on_hand.value = snapshot.cash_on_hand.native
    this.total_deposits.value = snapshot.total_deposits.native
    this.circulating_lst.value = snapshot.circulating_lst.native
    this.total_borrows.value = snapshot.total_borrows.native
    this.total_additional_rewards.value = snapshot.total_additional_rewards.native
    this.total_commission_earned.value = snapshot.total_commission_earned.native
    this.current_accumulated_commission.value = snapshot.current_accumulated_commission.native
    this.fee_pool.value = snapshot.fee_pool.native
    this.borrow_index_wad.value = snapshot.borrowIndexWad.native
    this.accepted_collaterals_count.value = snapshot.accepted_collaterals_count.native
    this.base_token_id.value = new UintN64(snapshot.base_token_id.native)
    this.lst_token_id.value = new UintN64(snapshot.lst_token_id.native)
    this.buyout_token_id.value = new UintN64(snapshot.buyout_token_id.native)
    this.commission_percentage.value = snapshot.commission_percentage.native
    this.liq_bonus_bps.value = snapshot.liq_bonus_bps.native
    this.active_loan_records.value = snapshot.active_loan_records.native

    this.contract_state.value = new UintN64(1) // active
  }

  /**
   * Reads the global go-online fee required for validator participation.
   * @returns Fee amount in microALGOs required by consensus staking.
   */
  private getGoOnlineFee(): uint64 {
    // this will be needed to determine if our pool is currently NOT eligible and we thus need to pay the fee.
    return Global.payoutsGoOnlineFee
  }

  /**
   * Registers the application account as an Algorand consensus participant.
   * @param feePayment Payment covering the go-online fee that accompanies the keyreg.
   * @param votePK Voting public key for participation.
   * @param selectionPK VRF selection key.
   * @param stateProofPK State proof key for light-client support.
   * @param voteFirst First round for which the key is valid.
   * @param voteLast Last round for which the key is valid.
   * @param voteKeyDilution Dilution factor for the participation key.
   */
  @abimethod({ allowActions: 'NoOp' })
  public goOnline(
    feePayment: gtxn.PaymentTxn,
    votePK: bytes,
    selectionPK: bytes,
    stateProofPK: bytes,
    voteFirst: uint64,
    voteLast: uint64,
    voteKeyDilution: uint64,
  ): void {
    assert(op.Txn.sender === this.admin_account.value, 'Only admin can go online')

    const extraFee = this.getGoOnlineFee()
    assertMatch(feePayment, {
      sender: this.admin_account.value,
      receiver: Global.currentApplicationAddress,
      amount: extraFee,
    })
    itxn
      .keyRegistration({
        voteKey: votePK,
        selectionKey: selectionPK,
        stateProofKey: stateProofPK,
        voteFirst: voteFirst,
        voteLast: voteLast,
        voteKeyDilution: voteKeyDilution,
        fee: extraFee,
      })
      .submit()
  }

  /**
   * Unregisters the application account from consensus participation.
   */
  @abimethod({ allowActions: 'NoOp' })
  public goOffline(): void {
    /*  assert(
      op.Txn.sender === this.admin_account.value || op.Txn.sender === this.migration_admin.value,
      'Only admin can go offline',
    ) */
    itxn.keyRegistration({ fee: STANDARD_TXN_FEE }).submit()
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
