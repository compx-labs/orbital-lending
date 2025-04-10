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

  //List of oracle pools
  oracle_pools = BoxMap<UintN64, Oracle>({ keyPrefix: 'oracle_pools' })

  //List of accepted collateral types
  accepted_collaterals = BoxMap<UintN64, AcceptedCollateral>({ keyPrefix: 'accepted_collaterals' })

  loan_records = BoxMap<Account, LoanRecord>({ keyPrefix: 'loan_records' })

  active_loan_records = GlobalState<uint64>()

  //Number of oracle pools
  oracle_pools_count = GlobalState<uint64>()

  //Number of accepted collateral types
  accepted_collaterals_count = GlobalState<uint64>()

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
    this.oracle_pools(new arc4.UintN64(this.oracle_pools_count.value + 1)).value = newOracle.copy()
    this.oracle_pools_count.value = this.oracle_pools_count.value + 1
  }

  getOraclePrice(tokenId: uint64, oracleIndex: uint64): uint64 {
    const oracle = this.oracle_pools(new arc4.UintN64(oracleIndex)).value.copy()
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
      const oracle = this.oracle_pools(new arc4.UintN64(i)).value.copy()
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

  //Need to udpate this
  private calculateASADue(amount: uint64): uint64 {
    const [highBits1, lowBits1] = mulw(this.total_deposits.value, 10000)

    const lstRatio = divw(highBits1, lowBits1, this.circulating_lst.value)

    const [highBits2, lowBits2] = mulw(lstRatio, amount)
    return divw(highBits2, lowBits2, 10000)
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
    const depositBalance = op.AssetHolding.assetBalance(Global.currentApplicationAddress, this.base_token_id.value.native)
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
  }

  @abimethod({ allowActions: 'NoOp' })
  withdrawDeposit(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64): void {
    const baseToken = Asset(this.base_token_id.value.native)
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: baseToken,
      assetAmount: amount,
    })

    //Calculate the return amount of ASA
    const asaDue = this.calculateASADue(amount)

    assert(op.AssetHolding.assetBalance(Global.currentApplicationAddress, this.base_token_id.value.native)[0] >= asaDue)
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.base_token_id.value.native,
        assetAmount: asaDue,
      })
      .submit()
  }

  @abimethod({ allowActions: 'NoOp' })
  borrow(
    assetTransferTxn: gtxn.AssetTransferTxn, // The collateral deposit transaction
    requestedLoanAmount: uint64, // The loan amount the user wants to borrow (assumed in USD-equivalent units)
    lstApp: uint64, // External LST contract (used for collateral conversion)
    collateralTokenId: UintN64, // The asset id of the collateral LST token deposited
  ): void {
    // ─── 1. Validate the collateral deposit ─────────────────────────────
    // Check that the collateral deposit came into the contract.
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      // Note: We do not require that assetAmount equals requestedLoanAmount,
      // as the collateral deposit and the loan request are related by LTV.
    })
    const collateralDeposit: uint64 = assetTransferTxn.assetAmount

    // ─── 2. Verify that the deposit is for an accepted collateral type ──
    // Retrieve the accepted collateral information (which includes its base asset id).
    const acceptedCollateral = this.getCollateral(collateralTokenId)

    // ─── 3. Convert the collateral deposit (LST) into its underlying base asset ─
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstApp,
    }).returnValue
    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstApp,
    }).returnValue
    // Calculate underlying collateral:
    const [hiCollateral, loCollateral] = mulw(totalDepositsExternal, collateralDeposit)
    const underlyingCollateral: uint64 = divw(hiCollateral, loCollateral, circulatingExternalLST)

    // ─── 4. Price the underlying collateral in USD via the oracle ────────
    const oraclePrice: uint64 = this.getPricesFromOracles(acceptedCollateral.baseAssetId.native)

    const [hiUSD, loUSD] = mulw(underlyingCollateral, oraclePrice)
    const collateralUSD: uint64 = divw(hiUSD, loUSD, 1)

    const maxBorrowUSD: uint64 = (collateralUSD * this.ltv_bps.value) / 10000

    assert(requestedLoanAmount <= maxBorrowUSD)

    const fee: uint64 = (requestedLoanAmount * this.origination_fee_bps.value) / 10000
    const disbursement: uint64 = requestedLoanAmount - fee
    const [decimals, decimalsExists] = op.AssetParams.assetDecimals(this.base_token_id.value.native)
    const assetScale: uint64 = 10 ** decimals
    const [assetHi, assetLo] = mulw(disbursement, assetScale)
    const DIVISOR_1: uint64 = 2 ** 32
    const DIVISOR_2: uint64 = 2 ** 32

    // First divide the 128-bit product by 2^32 using wide division:
    const interim: uint64 = divw(assetHi, assetLo, DIVISOR_1)

    // Then complete the division by performing an integer division by 2^32:
    const scaledDownDisbursement: uint64 = interim / DIVISOR_2

    this.mintLoanRecord(scaledDownDisbursement, disbursement, collateralTokenId, op.Txn.sender, collateralDeposit)

    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.base_token_id.value.native,
        assetAmount: scaledDownDisbursement,
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
    })
    this.loan_records(borrowerAddress).value = loanRecord.copy()
  }

  getLoanRecord(borrowerAddress: Account): LoanRecord {
    return this.loan_records(borrowerAddress).value
  }

  getLoanRecordASAId(borrowerAddress: Account): uint64 {
    return this.loan_records(borrowerAddress).value.loanRecordASAId.native
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
