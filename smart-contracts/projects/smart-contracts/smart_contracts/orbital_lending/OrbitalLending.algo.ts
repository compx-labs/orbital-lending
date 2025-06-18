/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/explicit-member-accessibility */
import { Account, bytes, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  abimethod,
  Application,
  arc4,
  assert,
  assertMatch,
  Asset,
  BoxMap,
  Bytes,
  contract,
  Contract,
  err,
  Global,
  GlobalState,
  itxn,
  op,
  Uint64,
} from '@algorandfoundation/algorand-typescript'
import { abiCall, Address, Str, UintN128, UintN64 } from '@algorandfoundation/algorand-typescript/arc4'
import { appOptedIn, divw, mulw } from '@algorandfoundation/algorand-typescript/op'
import { AcceptedCollateral, AcceptedCollateralKey, LoanRecord, Oracle } from './config.algo'
import { TokenPrice } from '../Oracle/config.algo'

// Number of seconds in a (e.g.) 365-day year
const SECONDS_PER_YEAR: uint64 = 365 * 24 * 60 * 60
const PROTOCOL_SHARE_BPS: uint64 = 2500 // 25% in basis points
const DEPOSITOR_SHARE_BPS: uint64 = 10000 - PROTOCOL_SHARE_BPS // 7500

@contract({ name: 'orbital-lending', avmVersion: 11 })
export class OrbitalLending extends Contract {
  // The main lending token of this contract - used for deposit and borrowing
  base_token_id = GlobalState<UintN64>()

  // LST token of this contract - used for borrowing - generated in the contract at creation time
  lst_token_id = GlobalState<UintN64>()

  //Total LST currently circulating from this contract
  circulating_lst = GlobalState<uint64>()

  //Total ASA currently deposited into this contract
  total_deposits = GlobalState<uint64>()

  //Admin account
  admin_account = GlobalState<Account>()

  //LTV in basis points
  ltv_bps = GlobalState<uint64>()

  //Liquidation threshold in basis points
  liq_threshold_bps = GlobalState<uint64>()

  //Interest rate in basis points
  interest_bps = GlobalState<uint64>()

  //Origination fee in basis points
  origination_fee_bps = GlobalState<uint64>()

  protocol_interest_fee_bps = GlobalState<uint64>()

  oracle_app = GlobalState<Application>()

  //List of accepted collateral types
  accepted_collaterals = BoxMap<AcceptedCollateralKey, AcceptedCollateral>({ keyPrefix: 'accepted_collaterals' })

  loan_record = BoxMap<Account, LoanRecord>({ keyPrefix: 'loan_record' })

  active_loan_records = GlobalState<uint64>()

  //Number of accepted collateral types
  accepted_collaterals_count = GlobalState<uint64>()

  fee_pool = GlobalState<uint64>()

  last_scaled_down_disbursement = GlobalState<uint64>()

  last_max_borrow = GlobalState<uint64>()

  last_requested_loan = GlobalState<uint64>()

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
    protocol_interest_fee_bps: uint64,
    oracle_app_id: Application,
  ): void {
    assert(op.Txn.sender === this.admin_account.value)

    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: 400000,
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
    this.protocol_interest_fee_bps.value = protocol_interest_fee_bps
    this.oracle_app.value = oracle_app_id
    this.lst_token_id.value = new UintN64(99)

    if (this.base_token_id.value.native !== 0) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          xferAsset: this.base_token_id.value.native,
          assetAmount: 0,
          fee: 1000,
        })
        .submit()
    }
  }

  //If generating a new LST for the base token.
  public generateLSTToken(mbrTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.admin_account.value)
    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: 102000,
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
        fee: 1000,
      })
      .submit()
    this.lst_token_id.value = new UintN64(result.createdAsset.id)
  }

  //If LST already created externally.
  public optInToLST(lstAssetId: uint64, mbrTxn: gtxn.PaymentTxn): void {
    assert(op.Txn.sender === this.admin_account.value)
    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: 2000,
    })
    this.lst_token_id.value = new UintN64(lstAssetId)

    //Opt-in to the LST token
    itxn
      .assetTransfer({
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: lstAssetId,
        assetAmount: 0,
        fee: 1000,
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
      fee: 1000,
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
      amount: 101000,
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
        fee: 1000,
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
      fee: 1000,
    }).returnValue
    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstApp,
      fee: 1000,
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
      amount: 1000,
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
        fee: 1000,
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
      amount: 1000,
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
        fee: 1000,
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
        fee: 1000,
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
    templateReserveAddress: Account,
    arc19MetaDataStr: string,
    mbrTxn: gtxn.PaymentTxn,
  ): void {
    // ─── 0. Determine if this is a top-up or a brand-new loan ─────────────
    const hasLoan = this.loan_record(op.Txn.sender).exists
    let collateralToUse: uint64 = 0;
    if( hasLoan) {
      const existingCollateral = this.getLoanRecord(op.Txn.sender).collateralAmount
      collateralToUse = existingCollateral.native
    } else {
      collateralToUse = collateralAmount
    }
    assertMatch(mbrTxn, {
      amount: 4000,
    })

    // ─── 1. Validate the collateral deposit ────────────────────────────────
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: collateralAmount,
      // user must transfer LST collateral in this txn…
    })
    assert(this.collateralExists(collateralTokenId), 'unsupported collateral')

    // ─── 1. Fetch LST stats and collateral info ─────────────────────────────
    const acceptedCollateral = this.getCollateral(collateralTokenId)

    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstApp,
      fee: 1000,
    }).returnValue

    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstApp,
      fee: 1000,
    }).returnValue




    // ─── 2. Convert LST → Underlying Collateral ─────────────────────────────
    const [hC, lC] = mulw(totalDepositsExternal, collateralToUse)
    const underlyingCollateral: uint64 = divw(hC, lC, circulatingExternalLST)

    // ─── 3. Get Oracle Price of Collateral in USD ───────────────────────────
    const collateralOraclePrice: uint64 = this.getOraclePrice(collateralTokenId)

    const [hU, lU] = mulw(underlyingCollateral, collateralOraclePrice)
    const collateralUSD: uint64 = divw(hU, lU, 1_000_000) // USD micro-units

    // ─── 4. Calculate Max Borrowable USD via LTV ────────────────────────────
    const maxBorrowUSD: uint64 = (collateralUSD * this.ltv_bps.value) / 10_000
    this.last_max_borrow.value = maxBorrowUSD

    // ─── 5. Get Oracle Price of Base Token (borrowed token) ─────────────────
    const baseTokenOraclePrice: uint64 = this.getOraclePrice(this.base_token_id.value)

    // ─── 6. Convert Requested Loan to USD Value ─────────────────────────────
    const [rH, rL] = mulw(requestedLoanAmount, baseTokenOraclePrice)
    const requestedLoanUSD: uint64 = divw(rH, rL, 1_000_000) // since requestedLoanAmount is in base token micro
    this.last_requested_loan.value = requestedLoanUSD
    const diff: uint64 = maxBorrowUSD - requestedLoanUSD
    this.debug_diff.value = diff
    // ─── 7. Enforce LTV Cap ─────────────────────────────────────────────────
    assert(requestedLoanUSD <= maxBorrowUSD, 'exceeds LTV limit')

    // ─── 8. Apply Origination Fee ───────────────────────────────────────────
    const fee: uint64 = (requestedLoanAmount * this.origination_fee_bps.value) / 10_000
    const disbursement: uint64 = requestedLoanAmount - fee
    this.fee_pool.value += fee

    // ─── 9. Final Disbursement is Already in Micro Units ────────────────────
    this.last_scaled_down_disbursement.value = disbursement

    // ─── 4. Branch: top-up vs new loan ─────────────────────────────────────
    if (hasLoan) {
      // — Top-Up Existing Loan —
      let old = this.getLoanRecord(op.Txn.sender)
      old = this.accrueInterest(old)
      this.loan_record(op.Txn.sender).value = old.copy()

      const [h1, l1] = mulw(old.scaledDownDisbursement.native, baseTokenOraclePrice)
      const oldLoanUSD: uint64 = divw(h1, l1, 1_000_000)

      const [h2, l2] = mulw(requestedLoanAmount, baseTokenOraclePrice)
      const newLoanUSD: uint64 = divw(h2, l2, 1_000_000)

      const totalRequestedUSD: uint64 = oldLoanUSD + newLoanUSD
      assert(totalRequestedUSD <= maxBorrowUSD, 'exceeds LTV limit with existing debt')

      // combine collateral & debt
      const totalCollateral: uint64 = old.collateralAmount.native + collateralAmount
      const oldDebt: uint64 = old.scaledDownDisbursement.native
      const newDebt: uint64 = oldDebt + disbursement
      const newTotalDisb: uint64 = old.disbursement.native + disbursement

      // mint replacement record ASA
      this.updateLoanRecord(
        newDebt,
        newTotalDisb,
        old.collateralTokenId,
        op.Txn.sender,
        totalCollateral,
        templateReserveAddress,
        old.loanRecordASAId.native,
      )

      this.loan_record(op.Txn.sender).value = new LoanRecord({
        borrowerAddress: old.borrowerAddress,
        collateralTokenId: old.collateralTokenId,
        collateralAmount: new UintN64(totalCollateral),
        disbursement: new UintN64(newTotalDisb),
        scaledDownDisbursement: new UintN64(newDebt),
        borrowedTokenId: old.borrowedTokenId,
        loanRecordASAId: old.loanRecordASAId,
        lastAccrualTimestamp: new UintN64(Global.latestTimestamp),
      }).copy()
      
      this.updateCollateralTotal(collateralTokenId, collateralAmount)
    } else {
      // — Brand-New Loan —
      this.mintLoanRecord(
        disbursement,
        disbursement,
        collateralTokenId,
        op.Txn.sender,
        collateralAmount,
        arc19MetaDataStr,
        templateReserveAddress,
      )
    }

    // ─── 5. Disburse the funds ─────────────────────────────────────────────
    if (this.base_token_id.value.native === 0) {
      itxn
        .payment({
          receiver: op.Txn.sender,
          amount: disbursement,
          fee: 1000,
        })
        .submit()
    } else {
      itxn
        .assetTransfer({
          assetReceiver: op.Txn.sender,
          xferAsset: this.base_token_id.value.native,
          assetAmount: disbursement,
          fee: 1000,
        })
        .submit()
    }
  }

  private updateLoanRecord(
    scaledDownDisbursement: uint64,
    disbursement: uint64,
    collateralTokenId: UintN64,
    borrowerAddress: Account,
    collateralAmount: uint64,
    templateReserveAddress: Account,
    assetId: uint64,
  ): void {
    const asset = itxn
      .assetConfig({
        manager: Global.currentApplicationAddress,
        sender: Global.currentApplicationAddress,
        reserve: templateReserveAddress,
        freeze: Global.currentApplicationAddress,
        clawback: Global.currentApplicationAddress,
        configAsset: assetId,
        fee: 1000,
      })
      .submit()

    const loanRecord: LoanRecord = new LoanRecord({
      borrowerAddress: new Address(borrowerAddress.bytes),
      collateralTokenId: collateralTokenId,
      collateralAmount: new UintN64(collateralAmount),
      disbursement: new UintN64(disbursement),
      scaledDownDisbursement: new UintN64(scaledDownDisbursement),
      borrowedTokenId: this.base_token_id.value,
      loanRecordASAId: new UintN64(asset.createdAsset.id),
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
    arc19MetadataStr: string,
    templateReserveAddress: Account,
  ): void {
    const asset = itxn
      .assetConfig({
        assetName: 'r' + String(collateralTokenId.bytes) + 'b' + String(this.base_token_id.value.bytes),
        url: arc19MetadataStr,
        manager: Global.currentApplicationAddress,
        decimals: 0,
        total: disbursement,
        sender: Global.currentApplicationAddress,
        unitName: 'CMPXLR',
        reserve: templateReserveAddress,
        freeze: Global.currentApplicationAddress,
        clawback: Global.currentApplicationAddress,
        defaultFrozen: false,
        fee: 1000, // Set a small fee for the asset config transaction
      })
      .submit()

    const loanRecord: LoanRecord = new LoanRecord({
      borrowerAddress: new Address(borrowerAddress.bytes),
      collateralTokenId: collateralTokenId,
      collateralAmount: new UintN64(collateralAmount),
      disbursement: new UintN64(disbursement),
      scaledDownDisbursement: new UintN64(scaledDownDisbursement),
      borrowedTokenId: this.base_token_id.value,
      loanRecordASAId: new UintN64(asset.createdAsset.id),
      lastAccrualTimestamp: new UintN64(Global.latestTimestamp),
    })
    this.loan_record(borrowerAddress).value = loanRecord.copy()
    this.active_loan_records.value = this.active_loan_records.value + 1
  }

  @abimethod({ allowActions: 'NoOp' })
  claimLoanRecordASA(debtor: Account, assetId: Asset): void {
    assert(this.loan_record(debtor).exists, 'Loan record does not exist')
    const assetExists = Global.currentApplicationAddress.isOptedIn(assetId)
    assert(assetExists, 'Loan record ASA does not exist')
    const loanRecord = this.loan_record(debtor).value.copy()
    itxn
      .assetTransfer({
        assetReceiver: debtor,
        xferAsset: assetId,
        assetAmount: 1,
      })
      .submit()

    //opt app out of asa
    itxn
      .assetTransfer({
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: assetId,
        assetAmount: 0,
        assetCloseTo: debtor,
      })
      .submit()
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
    const rateScaled: uint64 = divw(hi1, lo1, 10000)
    // 3) Multiply by time delta: rateScaled * deltaT  → wide multiply
    const [hi2, lo2] = mulw(rateScaled, deltaT)
    // 4) Divide by seconds_per_year to get interest amount
    const interest: uint64 = divw(hi2, lo2, SECONDS_PER_YEAR)

    const protoBps: uint64 = this.protocol_interest_fee_bps.value
    const depositorBps: uint64 = 10000 - protoBps

    // depositor’s share = interest * depositorBps / 10_000
    const [hiDep, loDep] = mulw(interest, depositorBps)
    const depositorInterest: uint64 = divw(hiDep, loDep, 10000)

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
      loanRecordASAId: record.loanRecordASAId,
      lastAccrualTimestamp: new UintN64(now),
    })
  }

  getLoanRecord(borrowerAddress: Account): LoanRecord {
    return this.loan_record(borrowerAddress).value
  }

  getLoanRecordASAId(borrowerAddress: Account): uint64 {
    return this.loan_record(borrowerAddress).value.loanRecordASAId.native
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

    const loanRecordASAId = this.getLoanRecordASAId(op.Txn.sender)

    const currentdebt: UintN64 = loanRecord.scaledDownDisbursement
    assert(amount <= currentdebt.native)
    const remainingDebt: uint64 = currentdebt.native - amount

    if (remainingDebt === 0) {
      itxn
        .assetConfig({
          configAsset: loanRecordASAId,
          sender: Global.currentApplicationAddress,
        })
        .submit()
      //return collateral asset

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
        templateReserveAddress, // arc19 metadata
        loanRecordASAId, // existing ASA ID to update
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

    const loanRecordASAId = this.getLoanRecordASAId(op.Txn.sender)

    const currentdebt: UintN64 = loanRecord.scaledDownDisbursement
    assert(amount <= currentdebt.native)
    const remainingDebt: uint64 = currentdebt.native - amount

    if (remainingDebt === 0) {
      //destroy asa
      itxn
        .assetConfig({
          configAsset: loanRecordASAId,
          sender: Global.currentApplicationAddress,
        })
        .submit()
      //return collateral asset

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
        templateReserveAddress, // arc19 metadata
        loanRecordASAId, // existing ASA ID to update
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
    this.accrueInterest(currentLoanRecord)

    //mint new nft
    this.updateLoanRecord(
      currentLoanRecord.scaledDownDisbursement.native,
      currentLoanRecord.disbursement.native,
      currentLoanRecord.collateralTokenId,
      debtor,
      currentLoanRecord.collateralAmount.native,
      templateReserveAddress,
      currentLoanRecord.loanRecordASAId.native, // existing ASA ID to update
    )
    //Update box storage
    this.loan_record(debtor).value = currentLoanRecord.copy()
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

    //Clawback the loan record ASA
    const assetExists = Global.currentApplicationAddress.isOptedIn(Asset(currentLoanRecord.loanRecordASAId.native))
    if (!assetExists) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          xferAsset: currentLoanRecord.loanRecordASAId.native,
          assetSender: debtor,
          assetAmount: currentLoanRecord.scaledDownDisbursement.native,
        })
        .submit()
    }
    //Destroy the loan record ASA
    itxn
      .assetConfig({
        configAsset: currentLoanRecord.loanRecordASAId.native,
        sender: Global.currentApplicationAddress,
      })
      .submit()

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

    //Clawback the loan record ASA
    const assetExists = Global.currentApplicationAddress.isOptedIn(Asset(currentLoanRecord.loanRecordASAId.native))
    if (!assetExists) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          xferAsset: currentLoanRecord.loanRecordASAId.native,
          assetSender: debtor,
          assetAmount: currentLoanRecord.scaledDownDisbursement.native,
        })
        .submit()
    }
    //Destroy the loan record ASA
    itxn
      .assetConfig({
        configAsset: currentLoanRecord.loanRecordASAId.native,
        sender: Global.currentApplicationAddress,
      })
      .submit()

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
    const loanRecordASAId = record.loanRecordASAId.native
    const assetExists = Global.currentApplicationAddress.isOptedIn(Asset(loanRecordASAId))
    if (!assetExists) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          assetSender: debtor,
          xferAsset: loanRecordASAId,
          assetAmount: 1,
        })
        .submit()
    }
    //Destroy the loan record ASA
    itxn
      .assetConfig({
        configAsset: loanRecordASAId,
        sender: Global.currentApplicationAddress,
      })
      .submit()

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

    //Clawback ASA if needed
    const loanRecordASAId = record.loanRecordASAId.native
    const assetExists = Global.currentApplicationAddress.isOptedIn(Asset(loanRecordASAId))
    if (!assetExists) {
      itxn
        .assetTransfer({
          assetReceiver: Global.currentApplicationAddress,
          assetSender: debtor,
          xferAsset: loanRecordASAId,
          assetAmount: 1,
        })
        .submit()
    }
    //Destroy the loan record ASA
    itxn
      .assetConfig({
        configAsset: loanRecordASAId,
        sender: Global.currentApplicationAddress,
      })
      .submit()

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
