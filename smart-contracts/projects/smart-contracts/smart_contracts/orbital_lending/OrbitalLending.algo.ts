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
import { abiCall, Address, UintN64 } from '@algorandfoundation/algorand-typescript/arc4'
import { divw, mulw } from '@algorandfoundation/algorand-typescript/op'
import { AcceptedCollateral, AcceptedCollateralKey, LoanRecord } from './config.algo'
import { TokenPrice } from '../Oracle/config.algo'

// Number of seconds in a (e.g.) 365-day year
const SECONDS_PER_YEAR: uint64 = 365 * 24 * 60 * 60

// Instead of scattered magic numbers, centralize them
const FEES = {
  MBR_CREATE_APP: 400_000,
  MBR_INIT_APP: 102_000,
  MBR_OPT_IN_LST: 2_000,
  MBR_COLLATERAL: 101_000,
  STANDARD_TXN_FEE: 1_000,
} as const

const PRECISION = {
  BASIS_POINTS: 10_000,
  USD_MICRO_UNITS: 1_000_000,
} as const

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
  
  /** Annual interest rate charged to borrowers (e.g., 500 = 5% APR) */
  interest_bps = GlobalState<uint64>()
  
  /** One-time fee charged on loan origination (e.g., 100 = 1%) */
  origination_fee_bps = GlobalState<uint64>()
  
  /** Protocol's share of interest income (e.g., 2000 = 20%) */
  protocol_share_bps = GlobalState<uint64>()
  
  /** Depositors' share of interest income (calculated as 10000 - protocol_share) */
  depositor_share_bps = GlobalState<uint64>()

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

  @abimethod({ allowActions: 'NoOp', onCreate: 'require' })
  public createApplication(admin: Account, baseTokenId: uint64): void {
    this.admin_account.value = admin
    this.base_token_id.value = new UintN64(baseTokenId)
  }

  @abimethod({ allowActions: 'NoOp' })
  public initApplication(
    mbrTxn: gtxn.PaymentTxn,
    ltv_bps: uint64,
    liq_threshold_bps: uint64,
    interest_bps: uint64,
    origination_fee_bps: uint64,
    protocol_share_bps: uint64,

    oracle_app_id: Application,
  ): void {
    assert(op.Txn.sender === this.admin_account.value)

    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: FEES.MBR_INIT_APP,
    })

    this.ltv_bps.value = ltv_bps
    this.liq_threshold_bps.value = liq_threshold_bps
    this.interest_bps.value = interest_bps
    this.origination_fee_bps.value = origination_fee_bps
    this.accepted_collaterals_count.value = 0
    this.fee_pool.value = 0
    this.circulating_lst.value = 0
    this.total_deposits.value = 0
    this.active_loan_records.value = 0
    this.protocol_share_bps.value = protocol_share_bps
    this.depositor_share_bps.value = PRECISION.BASIS_POINTS - protocol_share_bps
    this.oracle_app.value = oracle_app_id
    this.lst_token_id.value = new UintN64(99)

    if (this.base_token_id.value.native !== 0) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          xferAsset: this.base_token_id.value.native,
          assetAmount: 0,
          fee: FEES.STANDARD_TXN_FEE,
        })
        .submit()
    }
  }

  //If generating a new LST for the base token.
  public generateLSTToken(mbrTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.admin_account.value)
    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: FEES.MBR_INIT_APP,
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
        assetName: 'c' + String(this.base_token_id.value.bytes),
        fee: FEES.STANDARD_TXN_FEE,
      })
      .submit()
    this.lst_token_id.value = new UintN64(result.createdAsset.id)
  }

  //If LST already created externally.
  public optInToLST(lstAssetId: uint64, mbrTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.admin_account.value)
    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: FEES.MBR_OPT_IN_LST,
    })
    this.lst_token_id.value = new UintN64(lstAssetId)

    //Opt-in to the LST token
    itxn
      .assetTransfer({
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: lstAssetId,
        assetAmount: 0,
        fee: FEES.STANDARD_TXN_FEE,
      })
      .submit()
  }

  public configureLSTToken(axferTxn: gtxn.AssetTransferTxn, circulating_lst: uint64): void {
    assert(op.Txn.sender === this.admin_account.value)
    assert(this.lst_token_id.value.native === axferTxn.xferAsset.id, 'LST token not set')

    assertMatch(axferTxn, {
      sender: this.admin_account.value,
      assetReceiver: Global.currentApplicationAddress,
    })
    this.circulating_lst.value = circulating_lst
  }

  getCirculatingLST(): uint64 {
    return this.circulating_lst.value
  }

  getTotalDeposits(): uint64 {
    return this.total_deposits.value
  }

  getAcceptedCollateralsCount(): uint64 {
    return this.accepted_collaterals_count.value
  }

  getOraclePrice(tokenId: UintN64): uint64 {
    const oracle: Application = this.oracle_app.value
    const address = oracle.address
    const contractAppId = oracle.id

    const result = abiCall(PriceOracleStub.prototype.getTokenPrice, {
      appId: contractAppId,
      args: [tokenId],
      fee: FEES.STANDARD_TXN_FEE,
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

    if (collateral.assetId.native === collateralTokenId.native) {
      const newTotal: uint64 = collateral.totalCollateral.native + amount
      this.accepted_collaterals(key).value = new AcceptedCollateral({
        assetId: collateral.assetId,
        baseAssetId: collateral.baseAssetId,
        totalCollateral: new UintN64(newTotal),
      }).copy()
    }
  }

  @abimethod({ allowActions: 'NoOp' })
  addNewCollateralType(collateralTokenId: UintN64, mbrTxn: gtxn.PaymentTxn): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assert(op.Txn.sender === this.admin_account.value)
    assert(collateralTokenId.native !== baseToken.id)
    assert(!this.collateralExists(collateralTokenId))
    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: FEES.MBR_COLLATERAL,
    })

    const newAcceptedCollateral: AcceptedCollateral = new AcceptedCollateral({
      assetId: collateralTokenId,
      baseAssetId: this.base_token_id.value,
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
        fee: FEES.STANDARD_TXN_FEE,
      })
      .submit()

    assert(this.collateralExists(collateralTokenId), 'unsupported collateral')
  }

  private calculateLSTDue(amount: uint64): uint64 {
    const [highBits1, lowBits1] = mulw(this.circulating_lst.value, 10000)

    const lstRatio = divw(highBits1, lowBits1, this.total_deposits.value)

    const [highBits2, lowBits2] = mulw(lstRatio, amount)
    return divw(highBits2, lowBits2, 10000)
  }

  // Calculate how much underlying ASA to return for a given LST amount,
  // by querying the external LST contract’s circulatingLST & totalDeposits.
  private calculateASADue(amount: uint64, lstApp: uint64): uint64 {
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstApp,
      fee: FEES.STANDARD_TXN_FEE,
    }).returnValue
    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstApp,
      fee: FEES.STANDARD_TXN_FEE,
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

  @abimethod({ allowActions: 'NoOp' })
  depositASA(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64, mbrTxn: gtxn.PaymentTxn): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: baseToken,
      assetAmount: amount,
    })
    assertMatch(mbrTxn, {
      amount: FEES.STANDARD_TXN_FEE,
    })

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
        fee: FEES.STANDARD_TXN_FEE,
      })
      .submit()

    this.circulating_lst.value += lstDue
    this.total_deposits.value += amount
  }

  @abimethod({ allowActions: 'NoOp' })
  depositAlgo(depositTxn: gtxn.PaymentTxn, amount: uint64, mbrTxn: gtxn.PaymentTxn): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(depositTxn, {
      receiver: Global.currentApplicationAddress,
      amount: amount,
    })
    assertMatch(mbrTxn, {
      amount: FEES.STANDARD_TXN_FEE,
    })

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
        fee: FEES.STANDARD_TXN_FEE,
      })
      .submit()

    this.circulating_lst.value += lstDue
    this.total_deposits.value += amount
  }

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
        fee: FEES.STANDARD_TXN_FEE,
      })
      .submit()

    this.circulating_lst.value -= amount // LST burned
    this.total_deposits.value -= asaDue // ASA returned
  }

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
    let collateralToUse: uint64 = 0
    if (hasLoan) {
      const existingCollateral = this.getLoanRecord(op.Txn.sender).collateralAmount
      collateralToUse = existingCollateral.native
    } else {
      collateralToUse = collateralAmount
    }
    this.validateBorrowRequest(assetTransferTxn, collateralAmount, collateralTokenId, mbrTxn)
    const collateralUSD = this.calculateCollateralValueUSD(collateralTokenId, collateralToUse, lstApp)
    const maxBorrowUSD: uint64 = (collateralUSD * this.ltv_bps.value) / PRECISION.BASIS_POINTS
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
      this.mintLoanRecord(disbursement, disbursement, collateralTokenId, op.Txn.sender, collateralAmount)
    }

    this.disburseFunds(op.Txn.sender, disbursement)
  }

  private updateLoanRecord(
    scaledDownDisbursement: uint64,
    disbursement: uint64,
    collateralTokenId: UintN64,
    borrowerAddress: Account,
    collateralAmount: uint64,
  ): void {
    const loanRecord: LoanRecord = new LoanRecord({
      borrowerAddress: new Address(borrowerAddress.bytes),
      collateralTokenId: collateralTokenId,
      collateralAmount: new UintN64(collateralAmount),
      disbursement: new UintN64(disbursement),
      scaledDownDisbursement: new UintN64(scaledDownDisbursement),
      borrowedTokenId: this.base_token_id.value,
      lastAccrualTimestamp: new UintN64(Global.latestTimestamp),
    })
    this.loan_record(borrowerAddress).value = loanRecord.copy()
  }

  private mintLoanRecord(
    scaledDownDisbursement: uint64,
    disbursement: uint64,
    collateralTokenId: UintN64,
    borrowerAddress: Account,
    collateralAmount: uint64,
  ): void {
    const loanRecord: LoanRecord = new LoanRecord({
      borrowerAddress: new Address(borrowerAddress.bytes),
      collateralTokenId: collateralTokenId,
      collateralAmount: new UintN64(collateralAmount),
      disbursement: new UintN64(disbursement),
      scaledDownDisbursement: new UintN64(scaledDownDisbursement),
      borrowedTokenId: this.base_token_id.value,
      lastAccrualTimestamp: new UintN64(Global.latestTimestamp),
    })
    this.loan_record(borrowerAddress).value = loanRecord.copy()
    this.active_loan_records.value = this.active_loan_records.value + 1
  }

  private accrueInterest(record: LoanRecord): LoanRecord {
    const now = Global.latestTimestamp
    const last = record.lastAccrualTimestamp.native
    // If no time has passed, nothing to do
    if (now <= last) return record

    const deltaT: uint64 = now - last
    const principal: uint64 = record.scaledDownDisbursement.native
    const rateBps: uint64 = this.interest_bps.value // e.g. 500 = 5%

    // 1) Compute principal * rateBps → wide multiply
    const [hi1, lo1] = mulw(principal, rateBps)
    // 2) Convert basis points to fraction: divide by 10_000
    const rateScaled: uint64 = divw(hi1, lo1, PRECISION.BASIS_POINTS)
    // 3) Multiply by time delta: rateScaled * deltaT  → wide multiply
    const [hi2, lo2] = mulw(rateScaled, deltaT)
    // 4) Divide by seconds_per_year to get interest amount
    const interest: uint64 = divw(hi2, lo2, SECONDS_PER_YEAR)

    const protoBps: uint64 = this.protocol_share_bps.value
    const depositorBps: uint64 = 10000 - protoBps

    // depositor’s share = interest * depositorBps / 10_000
    const [hiDep, loDep] = mulw(interest, depositorBps)
    const depositorInterest: uint64 = divw(hiDep, loDep, PRECISION.BASIS_POINTS)

    // protocol’s share = remainder
    const protocolInterest: uint64 = interest - depositorInterest

    // 3) Credit the shares
    // a) Depositors earn yield: bump total_deposits (so LSTs become worth more)
    this.total_deposits.value += depositorInterest
    // b) Protocol earnings: add to fee_pool
    this.fee_pool.value += protocolInterest

    // 4) Update borrower’s outstanding debt (principal + full interest)

    const newPrincipal: uint64 = principal + interest

    // Return an updated LoanRecord object (box write will follow)
    return new LoanRecord({
      borrowerAddress: record.borrowerAddress,
      collateralTokenId: record.collateralTokenId,
      collateralAmount: record.collateralAmount,
      disbursement: record.disbursement, // original
      scaledDownDisbursement: new UintN64(newPrincipal),
      borrowedTokenId: record.borrowedTokenId,
      lastAccrualTimestamp: new UintN64(now),
    })
  }

  getLoanRecord(borrowerAddress: Account): LoanRecord {
    return this.loan_record(borrowerAddress).value
  }

  @abimethod({ allowActions: 'NoOp' })
  repayLoanASA(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64, templateReserveAddress: Account): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: baseToken,
      assetAmount: amount,
    })

    let loanRecord = this.getLoanRecord(op.Txn.sender)
    loanRecord = this.accrueInterest(loanRecord)
    this.loan_record(op.Txn.sender).value = loanRecord.copy()

    const currentdebt: UintN64 = loanRecord.scaledDownDisbursement
    assert(amount <= currentdebt.native)
    const remainingDebt: uint64 = currentdebt.native - amount

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
        remainingDebt, // scaledDownDisbursement
        loanRecord.disbursement.native, // original disbursement (for metadata)
        loanRecord.collateralTokenId, // collateral type
        op.Txn.sender, // borrower
        loanRecord.collateralAmount.native, // collateral locked
      )
    }
  }

  @abimethod({ allowActions: 'NoOp' })
  repayLoanAlgo(paymentTxn: gtxn.PaymentTxn, amount: uint64, templateReserveAddress: Account): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(paymentTxn, {
      receiver: Global.currentApplicationAddress,
      amount: amount,
    })

    let loanRecord = this.getLoanRecord(op.Txn.sender)
    loanRecord = this.accrueInterest(loanRecord)
    this.loan_record(op.Txn.sender).value = loanRecord.copy()

    const currentdebt: UintN64 = loanRecord.scaledDownDisbursement
    assert(amount <= currentdebt.native)
    const remainingDebt: uint64 = currentdebt.native - amount

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
        remainingDebt, // scaledDownDisbursement
        loanRecord.disbursement.native, // original disbursement (for metadata)
        loanRecord.collateralTokenId, // collateral type
        op.Txn.sender, // borrower
        loanRecord.collateralAmount.native, // collateral locked
      )
    }
  }

  @abimethod({ allowActions: 'NoOp' })
  withdrawFees(): void {
    assert(op.Txn.sender === this.admin_account.value)
    itxn
      .assetTransfer({
        assetReceiver: this.admin_account.value,
        xferAsset: this.base_token_id.value.native,
        assetAmount: this.fee_pool.value,
      })
      .submit()
    this.fee_pool.value = 0
  }

  @abimethod({ allowActions: 'NoOp' })
  accrueLoanInterest(debtor: Account, templateReserveAddress: Account): void {
    assert(this.loan_record(debtor).exists, 'Loan record does not exist')
    const currentLoanRecord = this.loan_record(debtor).value.copy()
    //Apply interest
    const newLoanRecord = this.accrueInterest(currentLoanRecord)

    //update loan record - nft and box
    this.updateLoanRecord(
      newLoanRecord.scaledDownDisbursement.native,
      newLoanRecord.disbursement.native,
      newLoanRecord.collateralTokenId,
      debtor,
      newLoanRecord.collateralAmount.native,
    )
  }

  @abimethod({ allowActions: 'NoOp' })
  buyoutASA(buyer: Account, debtor: Account, axferTxn: gtxn.AssetTransferTxn): void {
    assert(this.loan_record(debtor).exists, 'Loan record does not exist')
    const currentLoanRecord = this.loan_record(debtor).value.copy()
    this.loan_record(debtor).value = currentLoanRecord.copy()

    const collateralAmount = currentLoanRecord.collateralAmount.native
    const debtAmount = currentLoanRecord.scaledDownDisbursement.native
    const collateralTokenId: UintN64 = new UintN64(currentLoanRecord.collateralTokenId.native)
    const acceptedCollateral = this.getCollateral(collateralTokenId)

    assert(acceptedCollateral.totalCollateral.native >= collateralAmount, 'Collateral amount exceeds current total')

    // Price via oracle
    const oraclePrice: uint64 = this.getOraclePrice(collateralTokenId)
    const [hU, lU] = mulw(collateralAmount, oraclePrice)
    const collateralUSD: uint64 = divw(hU, lU, 1)
    const CR: uint64 = collateralUSD / debtAmount
    assert(CR > this.liq_threshold_bps.value, 'loan is not eligible for buyout')

    const premiumRate: uint64 = (CR * 10000) / this.liq_threshold_bps.value - 10000 // in basis points
    const buyoutPrice: uint64 = collateralUSD * (1 + premiumRate / 10000)

    assertMatch(axferTxn, {
      xferAsset: Asset(this.base_token_id.value.native),
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: buyoutPrice,
    })

    //Buyout can proceed

    //Update the loan record for the debtor
    this.loan_record(debtor).delete()
    this.active_loan_records.value = this.active_loan_records.value - 1

    //Transfer the collateral to the buyer
    itxn
      .assetTransfer({
        assetReceiver: buyer,
        xferAsset: collateralTokenId.native,
        assetAmount: collateralAmount,
      })
      .submit()
    //Update collateral total
    const newTotal: uint64 = acceptedCollateral.totalCollateral.native - collateralAmount
    this.updateCollateralTotal(collateralTokenId, newTotal)
  }

  @abimethod({ allowActions: 'NoOp' })
  buyoutAlgo(buyer: Account, debtor: Account, paymentTxn: gtxn.PaymentTxn): void {
    assert(this.loan_record(debtor).exists, 'Loan record does not exist')
    const currentLoanRecord = this.loan_record(debtor).value.copy()
    this.loan_record(debtor).value = currentLoanRecord.copy()

    const collateralAmount = currentLoanRecord.collateralAmount.native
    const debtAmount = currentLoanRecord.scaledDownDisbursement.native
    const collateralTokenId: UintN64 = new UintN64(currentLoanRecord.collateralTokenId.native)
    const acceptedCollateral = this.getCollateral(collateralTokenId)

    assert(acceptedCollateral.totalCollateral.native >= collateralAmount, 'Collateral amount exceeds current total')

    // Price via oracle
    const oraclePrice: uint64 = this.getOraclePrice(collateralTokenId)
    const [hU, lU] = mulw(collateralAmount, oraclePrice)
    const collateralUSD: uint64 = divw(hU, lU, 1)
    const CR: uint64 = collateralUSD / debtAmount
    assert(CR > this.liq_threshold_bps.value, 'loan is not eligible for buyout')

    const premiumRate: uint64 = (CR * 10000) / this.liq_threshold_bps.value - 10000 // in basis points
    const buyoutPrice: uint64 = collateralUSD * (1 + premiumRate / 10000)

    assertMatch(paymentTxn, {
      receiver: Global.currentApplicationAddress,
      amount: buyoutPrice,
    })

    //Buyout can proceed

    //Update the loan record for the debtor
    this.loan_record(debtor).delete()
    this.active_loan_records.value = this.active_loan_records.value - 1

    //Transfer the collateral to the buyer
    itxn
      .assetTransfer({
        assetReceiver: buyer,
        xferAsset: collateralTokenId.native,
        assetAmount: collateralAmount,
      })
      .submit()
    //Update collateral total
    const newTotal: uint64 = acceptedCollateral.totalCollateral.native - collateralAmount
    this.updateCollateralTotal(collateralTokenId, newTotal)
  }

  @abimethod({ allowActions: 'NoOp' })
  liquidateASA(debtor: Account, axferTxn: gtxn.AssetTransferTxn): void {
    assert(this.loan_record(debtor).exists, 'Loan record does not exist')

    const record = this.loan_record(debtor).value.copy()
    const collateralAmount = record.collateralAmount.native
    const debtAmount = record.scaledDownDisbursement.native
    const collateralTokenId = record.collateralTokenId
    const acceptedCollateral = this.getCollateral(collateralTokenId)

    const oraclePrice = this.getOraclePrice(collateralTokenId)
    const [h, l] = mulw(collateralAmount, oraclePrice)
    const collateralUSD = divw(h, l, 1)

    const CR: uint64 = collateralUSD / debtAmount
    assert(CR <= this.liq_threshold_bps.value, 'loan is not liquidatable')

    //Transfer must be full amount of the loan
    assertMatch(axferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: Asset(this.base_token_id.value.native),
      assetAmount: debtAmount,
    })

    //Clawback ASA if needed

    //Delete the loan record
    this.loan_record(debtor).delete()
    this.active_loan_records.value = this.active_loan_records.value - 1

    //transfer the collateral to the liquidator (the sender of the txn)
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: collateralTokenId.native,
        assetAmount: collateralAmount,
      })
      .submit()

    //Update the collateral total
    const newTotal: uint64 = acceptedCollateral.totalCollateral.native - collateralAmount
    this.updateCollateralTotal(collateralTokenId, newTotal)
  }

  @abimethod({ allowActions: 'NoOp' })
  liquidateAlgo(debtor: Account, paymentTxn: gtxn.PaymentTxn): void {
    assert(this.loan_record(debtor).exists, 'Loan record does not exist')

    const record = this.loan_record(debtor).value.copy()
    const collateralAmount = record.collateralAmount.native
    const debtAmount = record.scaledDownDisbursement.native
    const collateralTokenId = record.collateralTokenId
    const acceptedCollateral = this.getCollateral(collateralTokenId)

    const oraclePrice = this.getOraclePrice(collateralTokenId)
    const [h, l] = mulw(collateralAmount, oraclePrice)
    const collateralUSD = divw(h, l, 1)

    const CR: uint64 = collateralUSD / debtAmount
    assert(CR <= this.liq_threshold_bps.value, 'loan is not liquidatable')

    //Transfer must be full amount of the loan
    assertMatch(paymentTxn, {
      receiver: Global.currentApplicationAddress,
      amount: debtAmount,
    })

    //Delete the loan record
    this.loan_record(debtor).delete()
    this.active_loan_records.value = this.active_loan_records.value - 1

    //transfer the collateral to the liquidator (the sender of the txn)
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: collateralTokenId.native,
        assetAmount: collateralAmount,
      })
      .submit()

    //Update the collateral total
    const newTotal: uint64 = acceptedCollateral.totalCollateral.native - collateralAmount
    this.updateCollateralTotal(collateralTokenId, newTotal)
  }

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
    let record = this.loan_record(borrower).value.copy()
    record = this.accrueInterest(record) // simulate interest accrual for latest status

    const debt: uint64 = record.scaledDownDisbursement.native
    const collateralAmount: uint64 = record.collateralAmount.native
    const liqBps: uint64 = this.liq_threshold_bps.value

    const acceptedCollateral = this.getCollateral(record.collateralTokenId)
    const oraclePrice = this.getOraclePrice(record.collateralTokenId)
    const [hi, lo] = mulw(collateralAmount, oraclePrice)
    const collateralValueUSD = divw(hi, lo, 1)

    const CR: uint64 = (collateralValueUSD * 10000) / debt
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
    assertMatch(mbrTxn, { amount: 4000 })

    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: collateralAmount,
    })

    assert(this.collateralExists(collateralTokenId), 'unsupported collateral')
  }

  private calculateCollateralValueUSD(collateralTokenId: UintN64, collateralAmount: uint64, lstApp: uint64): uint64 {
    // Get LST exchange rate
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstApp,
      fee: FEES.STANDARD_TXN_FEE,
    }).returnValue

    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstApp,
      fee: FEES.STANDARD_TXN_FEE,
    }).returnValue

    // Convert LST → Underlying Collateral
    const [hC, lC] = mulw(totalDepositsExternal, collateralAmount)
    const underlyingCollateral = divw(hC, lC, circulatingExternalLST)

    // Get Oracle Price and convert to USD
    const collateralOraclePrice = this.getOraclePrice(collateralTokenId)
    const [hU, lU] = mulw(underlyingCollateral, collateralOraclePrice)
    const collateralUSD = divw(hU, lU, PRECISION.USD_MICRO_UNITS)

    return collateralUSD
  }

  private validateLoanAmount(requestedLoanAmount: uint64, maxBorrowUSD: uint64, baseTokenOraclePrice: uint64): uint64 {
    // Convert requested loan to USD
    const [rH, rL] = mulw(requestedLoanAmount, baseTokenOraclePrice)
    const requestedLoanUSD = divw(rH, rL, PRECISION.USD_MICRO_UNITS)

    // Store for debugging
    this.last_requested_loan.value = requestedLoanUSD
    this.debug_diff.value = maxBorrowUSD - requestedLoanUSD

    assert(requestedLoanUSD <= maxBorrowUSD, 'exceeds LTV limit')

    return requestedLoanUSD
  }

  private calculateDisbursement(requestedAmount: uint64): { disbursement: uint64; fee: uint64 } {
    const fee = (requestedAmount * this.origination_fee_bps.value) / PRECISION.BASIS_POINTS
    const disbursement = requestedAmount - fee

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
    let existingLoan = this.getLoanRecord(borrower)
    existingLoan = this.accrueInterest(existingLoan).copy()
    this.loan_record(borrower).value = existingLoan.copy()

    // Validate total debt doesn't exceed LTV
    const [h1, l1] = mulw(existingLoan.scaledDownDisbursement.native, baseTokenOraclePrice)
    const oldLoanUSD = divw(h1, l1, PRECISION.USD_MICRO_UNITS)

    const [h2, l2] = mulw(requestedLoanAmount, baseTokenOraclePrice)
    const newLoanUSD = divw(h2, l2, PRECISION.USD_MICRO_UNITS)

    const totalRequestedUSD = oldLoanUSD + newLoanUSD
    assert(totalRequestedUSD <= maxBorrowUSD, 'exceeds LTV limit with existing debt')

    // Combine collateral & debt
    const totalCollateral = existingLoan.collateralAmount.native + collateralAmount
    const newDebt = existingLoan.scaledDownDisbursement.native + disbursement
    const newTotalDisb = existingLoan.disbursement.native + disbursement

    this.updateLoanRecord(newDebt, newTotalDisb, existingLoan.collateralTokenId, borrower, totalCollateral)
    this.updateCollateralTotal(collateralTokenId, collateralAmount)
  }
  private disburseFunds(borrower: Account, amount: uint64): void {
    if (this.base_token_id.value.native === 0) {
      itxn
        .payment({
          receiver: borrower,
          amount: amount,
          fee: FEES.STANDARD_TXN_FEE,
        })
        .submit()
    } else {
      itxn
        .assetTransfer({
          assetReceiver: borrower,
          xferAsset: this.base_token_id.value.native,
          assetAmount: amount,
          fee: FEES.STANDARD_TXN_FEE,
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
