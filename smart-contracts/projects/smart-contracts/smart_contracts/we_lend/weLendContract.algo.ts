/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/explicit-member-accessibility */
import { Account, gtxn, uint64 } from '@algorandfoundation/algorand-typescript'
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
import { AcceptedCollateral, LoanRecord, Oracle } from './config.algo'

// Number of seconds in a (e.g.) 365-day year
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60
const PROTOCOL_SHARE_BPS = 2500 // 25% in basis points
const DEPOSITOR_SHARE_BPS = 10000 - PROTOCOL_SHARE_BPS // 7500

@contract({ name: 'weLend', avmVersion: 11 })
export class WeLend extends Contract {
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

  //List of oracle pools
  oracle_pool = BoxMap<UintN64, Oracle>({ keyPrefix: 'oracle_pool' })

  //List of accepted collateral types
  accepted_collaterals = BoxMap<UintN64, AcceptedCollateral>({ keyPrefix: 'accepted_collaterals' })

  loan_record = BoxMap<Account, LoanRecord>({ keyPrefix: 'loan_record' })

  active_loan_records = GlobalState<uint64>()

  //Number of oracle pools
  oracle_pools_count = GlobalState<uint64>()

  //Number of accepted collateral types
  accepted_collaterals_count = GlobalState<uint64>()

  fee_pool = GlobalState<uint64>()

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
  ): void {
    assert(op.Txn.sender === this.admin_account.value)

    assertMatch(mbrTxn, {
      sender: this.admin_account.value,
      amount: 34000,
    })

    this.ltv_bps.value = ltv_bps
    this.liq_threshold_bps.value = liq_threshold_bps
    this.interest_bps.value = interest_bps
    this.origination_fee_bps.value = origination_fee_bps
    this.oracle_pools_count.value = 0
    this.accepted_collaterals_count.value = 0
    this.fee_pool.value = 0
    this.circulating_lst.value = 0
    this.total_deposits.value = 0
    this.active_loan_records.value = 0
    this.protocol_interest_fee_bps.value = protocol_interest_fee_bps

    /// Submit opt-in transaction: 0 asset transfer to self
    itxn
      .assetTransfer({
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: this.base_token_id.value.native,
        assetAmount: 0,
      })
      .submit()

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
      })
      .submit()
    this.lst_token_id.value = new UintN64(result.configAsset.id)
  }

  getCirculatingLST(): uint64 {
    return this.circulating_lst.value
  }

  getTotalDeposits(): uint64 {
    return this.total_deposits.value
  }

  getOraclePoolsCount(): uint64 {
    return this.oracle_pools_count.value
  }

  getAcceptedCollateralsCount(): uint64 {
    return this.accepted_collaterals_count.value
  }

  addOraclePool(poolAddress: Address, contractAppId: UintN64): void {
    assert(op.Txn.sender === this.admin_account.value)
    const [token_1_cumulative_price, token_1_cumulative_price_exists] = op.AppLocal.getExUint64(
      poolAddress.native,
      contractAppId.native,
      Bytes('asset_1_cumulative_price'),
    )
    const [token_2_cumulative_price, token_2_cumulative_price_exists] = op.AppLocal.getExUint64(
      poolAddress.native,
      contractAppId.native,
      Bytes('asset_2_cumulative_price'),
    )
    const [cumulativePriceLastTimestamp, cumulativePriceLastTimestampExists] = op.AppLocal.getExUint64(
      poolAddress.native,
      contractAppId.native,
      Bytes('cumulative_price_update_timestamp'),
    )
    const newOracle: Oracle = new Oracle({
      address: poolAddress,
      contractAppId: contractAppId,
      asset1LastCumulativePrice: new UintN64(token_1_cumulative_price),
      asset2LastCumulativePrice: new UintN64(token_2_cumulative_price),
      cumulativePriceLastTimestamp: new UintN64(cumulativePriceLastTimestamp),
    })
    this.oracle_pool(new arc4.UintN64(this.oracle_pools_count.value + 1)).value = newOracle.copy()
    this.oracle_pools_count.value = this.oracle_pools_count.value + 1
  }

  getOraclePrice(tokenId: uint64, oracleIndex: uint64): uint64 {
    const oracle = this.oracle_pool(new arc4.UintN64(oracleIndex)).value.copy()
    const address = oracle.address
    const contractAppId = oracle.contractAppId

    const contractAppIdObj = Application(contractAppId.native)

    const [token_1_id, token_1_exists] = op.AppLocal.getExUint64(address.native, contractAppIdObj, Bytes('asset_1_id'))
    const [new_cumulative_timestamp, new_cumulative_timestamp_exists] = op.AppLocal.getExUint64(
      address.native,
      contractAppIdObj,
      Bytes('cumulative_price_update_timestamp'),
    )
    let newCummulativePrice: uint64 = 0
    if (token_1_id === tokenId) {
      const [price, priceExists] = op.AppLocal.getExUint64(
        address.native,
        contractAppIdObj,
        Bytes('asset_1_cumulative_price'),
      )
      newCummulativePrice = price
    } else {
      const [price, priceExists] = op.AppLocal.getExUint64(
        address.native,
        contractAppIdObj,
        Bytes('asset_2_cumulative_price'),
      )
      newCummulativePrice = price
    }
    const previousTimestamp = oracle.cumulativePriceLastTimestamp.native
    const deltaTime: uint64 = new_cumulative_timestamp - previousTimestamp
    const deltaPrice: uint64 = newCummulativePrice - oracle.asset1LastCumulativePrice.native
    const instantaneous_price: uint64 = deltaPrice / deltaTime
    return instantaneous_price
  }

  getPricesFromOracles(tokenId: uint64): uint64 {
    const oracleIndex = this.oracle_pools_count.value
    let totalPrice: uint64 = 0
    for (let i: uint64 = 0; i < oracleIndex; i++) {
      const oracle = this.oracle_pool(new arc4.UintN64(i)).value.copy()
      const address = oracle.address
      const contractAppId = oracle.contractAppId
      const price = this.getOraclePrice(tokenId, i)
      totalPrice += price
    }
    return totalPrice / (oracleIndex + 1)
  }

  private collateralExists(collateralTokenId: UintN64): boolean {
    for (let i: uint64 = 0; i < this.accepted_collaterals_count.value; i++) {
      const collateral = this.accepted_collaterals(new arc4.UintN64(i)).value.copy()
      if (collateral.assetId.native === collateralTokenId.native) {
        return true
      }
    }
    return false
  }

  private getCollateral(collateralTokenId: UintN64): AcceptedCollateral {
    for (let i: uint64 = 0; i < this.accepted_collaterals_count.value; i++) {
      const collateral = this.accepted_collaterals(new arc4.UintN64(i)).value.copy()
      if (collateral.assetId.native === collateralTokenId.native) {
        return collateral
      }
    }
    err('Collateral not found')
  }

  @abimethod({ allowActions: 'NoOp' })
  addNewCollateralType(collateralTokenId: UintN64, baseTokenId: UintN64): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assert(op.Txn.sender === this.admin_account.value)
    assert(collateralTokenId.native !== baseToken.id)
    assert(baseTokenId.native !== baseToken.id)
    assert(!this.collateralExists(collateralTokenId))

    const newAcceptedCollateral: AcceptedCollateral = new AcceptedCollateral({
      assetId: collateralTokenId,
      baseAssetId: baseTokenId,
    })
    this.accepted_collaterals(new arc4.UintN64(this.accepted_collaterals_count.value + 1)).value =
      newAcceptedCollateral.copy()
    this.accepted_collaterals_count.value = this.accepted_collaterals_count.value + 1
    itxn
      .assetTransfer({
        sender: Global.currentApplicationAddress,
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: collateralTokenId.native,
        assetAmount: 0,
      })
      .submit()
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
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, { appId: lstApp }).returnValue
    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, { appId: lstApp }).returnValue

    // underlyingCollateral = (amount * totalDepositsExternal) / circulatingExternalLST
    const [hi, lo] = mulw(totalDepositsExternal, amount)
    return divw(hi, lo, circulatingExternalLST)
  }

  @abimethod({ allowActions: 'NoOp' })
  depositASA(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: baseToken,
      assetAmount: amount,
    })

    let lstDue: uint64 = 0
    const depositBalance = op.AssetHolding.assetBalance(
      Global.currentApplicationAddress,
      this.base_token_id.value.native,
    )
    if (depositBalance[0] === 0) {
      lstDue = amount
    } else {
      lstDue = this.calculateLSTDue(amount)
    }
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.lst_token_id.value.native,
        assetAmount: lstDue,
      })
      .submit()

    this.circulating_lst.value += lstDue
    this.total_deposits.value += amount
  }

  @abimethod({ allowActions: 'NoOp' })
  withdrawDeposit(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64, lstAppId: uint64): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: baseToken,
      assetAmount: amount,
    })

    //Calculate the return amount of ASA
    const asaDue = this.calculateASADue(amount, lstAppId)

    assert(op.AssetHolding.assetBalance(Global.currentApplicationAddress, this.base_token_id.value.native)[0] >= asaDue)
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.base_token_id.value.native,
        assetAmount: asaDue,
      })
      .submit()

    this.circulating_lst.value -= amount // LST burned
    this.total_deposits.value -= asaDue // ASA returned
  }

  @abimethod({ allowActions: 'NoOp' })
  borrow(
    assetTransferTxn: gtxn.AssetTransferTxn,
    requestedLoanAmount: uint64,
    lstApp: uint64,
    collateralTokenId: UintN64,
  ): void {
    // ─── 0. Determine if this is a top-up or a brand-new loan ─────────────
    const hasLoan = this.loan_record(op.Txn.sender).exists

    // ─── 1. Validate the collateral deposit ────────────────────────────────
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      // user must transfer LST collateral in this txn…
    })
    assert(this.collateralExists(collateralTokenId), 'unsupported collateral')
    const collateralDeposit = assetTransferTxn.assetAmount

    // ─── 2. Price & LTV check (same for both branches) ─────────────────────
    const acceptedCollateral = this.getCollateral(collateralTokenId)
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, { appId: lstApp }).returnValue
    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, { appId: lstApp }).returnValue

    // Convert LST→underlying
    const [hC, lC] = mulw(totalDepositsExternal, collateralDeposit)
    const underlyingCollateral: uint64 = divw(hC, lC, circulatingExternalLST)

    // Price via oracle
    const oraclePrice: uint64 = this.getPricesFromOracles(acceptedCollateral.baseAssetId.native)
    const [hU, lU] = mulw(underlyingCollateral, oraclePrice)
    const collateralUSD: uint64 = divw(hU, lU, 1)

    const maxBorrowUSD: uint64 = (collateralUSD * this.ltv_bps.value) / 10000

    // ─── 3. Compute fee & net disbursement ─────────────────────────────────
    const fee: uint64 = (requestedLoanAmount * this.origination_fee_bps.value) / 10000
    const disbursement: uint64 = requestedLoanAmount - fee
    this.fee_pool.value += fee

    // Scale disbursement into asset microunits
    const [decimals, decExists] = op.AssetParams.assetDecimals(this.base_token_id.value.native)
    const assetScale: uint64 = 10 ** decimals
    const [aH, aL] = mulw(disbursement, assetScale)
    const dividerScalar = 2 ** 32
    const interim: uint64 = divw(aH, aL, dividerScalar)
    const scaledDown: uint64 = interim / dividerScalar

    // ─── 4. Branch: top-up vs new loan ─────────────────────────────────────
    if (hasLoan) {
      // — Top-Up Existing Loan —
      let old = this.getLoanRecord(op.Txn.sender)
      old = this.accrueInterest(old)
      this.loan_record(op.Txn.sender).value = old.copy()

      const totalRequested = old.scaledDownDisbursement.native + requestedLoanAmount
      assert(totalRequested <= maxBorrowUSD, 'exceeds LTV limit with existing debt')

      // burn old ASA
      itxn
        .assetConfig({
          configAsset: old.loanRecordASAId.native,
          sender: Global.currentApplicationAddress,
        })
        .submit()

      // combine collateral & debt
      const totalCollateral = old.collateralAmount.native + collateralDeposit
      const oldDebt = old.scaledDownDisbursement.native
      const newDebt = oldDebt + disbursement
      const newTotalDisb = old.disbursement.native + disbursement

      // mint replacement record ASA
      const asset = itxn
        .assetConfig({
          sender: Global.currentApplicationAddress,
          assetName: `r${old.collateralTokenId.bytes}b${this.base_token_id.value.bytes}`,
          unitName: `r${old.collateralTokenId.bytes}${this.base_token_id.value.bytes}`,
          total: newTotalDisb,
          decimals: 0,
          manager: Global.currentApplicationAddress,
          reserve: op.Txn.sender,
          url: `${op.Txn.sender.bytes}:${old.collateralTokenId.bytes}:${new UintN64(scaledDown).bytes}:${Global.latestTimestamp}`,
        })
        .submit()

      this.loan_record(op.Txn.sender).value = new LoanRecord({
        borrowerAddress: old.borrowerAddress,
        collateralTokenId: old.collateralTokenId,
        collateralAmount: new UintN64(totalCollateral),
        disbursement: new UintN64(newTotalDisb),
        scaledDownDisbursement: new UintN64(newDebt),
        borrowedTokenId: old.borrowedTokenId,
        loanRecordASAId: new UintN64(asset.createdAsset.id),
        lastAccrualTimestamp: new UintN64(Global.latestTimestamp),
      }).copy()
    } else {
      // — Brand-New Loan —
      assert(requestedLoanAmount <= maxBorrowUSD, 'exceeds LTV limit')
      this.mintLoanRecord(scaledDown, disbursement, collateralTokenId, op.Txn.sender, collateralDeposit)
    }

    // ─── 5. Disburse the funds ─────────────────────────────────────────────
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.base_token_id.value.native,
        assetAmount: scaledDown,
      })
      .submit()
  }

  private mintLoanRecord(
    scaledDownDisbursement: uint64,
    disbursement: uint64,
    collateralTokenId: UintN64,
    borrowerAddress: Account,
    collateralAmount: uint64,
  ): void {
    const asset = itxn
      .assetConfig({
        assetName: 'r' + String(collateralTokenId.bytes) + 'b' + String(this.base_token_id.value.bytes),
        url:
          String(borrowerAddress.bytes) +
          ':' +
          String(collateralTokenId.bytes) +
          ':' +
          String(new UintN64(scaledDownDisbursement).bytes) +
          ':' +
          String(new UintN64(Global.latestTimestamp).bytes),
        manager: Global.currentApplicationAddress,
        decimals: 0,
        total: disbursement,
        sender: Global.currentApplicationAddress,
        unitName: 'r' + String(collateralTokenId.bytes) + String(this.base_token_id.value.bytes),
        reserve: borrowerAddress,
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

    const protoBps = this.protocol_interest_fee_bps.value
    const depositorBps = 10000 - protoBps

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

    const newPrincipal = principal + interest

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
  repayLoan(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64): void {
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

    const currentdebt = loanRecord.scaledDownDisbursement
    assert(amount <= currentdebt.native)
    const remainingDebt = currentdebt.native - amount

    //Destroy record ASA in all cases
    itxn
      .assetConfig({
        configAsset: loanRecordASAId,
        sender: Global.currentApplicationAddress,
      })
      .submit()

    if (remainingDebt === 0) {
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
      this.mintLoanRecord(
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
