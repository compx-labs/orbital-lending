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
import { AcceptedCollateral, Oracle } from './config.algo'
@contract({ name: 'weLend', avmVersion: 11 })
export class WeLend extends Contract {
  // The main lending token of this contract - used for deposit and borrowing
  base_token_id = GlobalState<Asset>({ initialValue: Asset() })

  // LST token of this contract - used for borrowing - generated in the contract at creation time
  lst_token_id = GlobalState<Asset>({ initialValue: Asset() })

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

  //Number of oracle pools
  oracle_pools_count = GlobalState<uint64>()

  //Number of accepted collateral types
  accepted_collaterals_count = GlobalState<uint64>()

  @abimethod({ allowActions: 'NoOp', onCreate: 'require' })
  public createApplication(admin: Account, baseTokenId: Asset): void {
    this.admin_account.value = admin
    this.base_token_id.value = baseTokenId
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
        xferAsset: this.base_token_id.value,
        assetAmount: 0,
      })
      .submit()

    //Create LST token
    const result = itxn
      .assetConfig({
        sender: Global.currentApplicationAddress,
        total: this.base_token_id.value.total,
        decimals: this.base_token_id.value.decimals,
        defaultFrozen: false,
        manager: Global.currentApplicationAddress,
        unitName: 'c' + String(this.base_token_id.value.unitName),
      })
      .submit()
    this.lst_token_id.value = result.configAsset
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
    const [token_1_cumulative_price, token_1_cumulative_price_exists] = op.AppLocal.getExUint64(poolAddress.native, contractAppId.native, Bytes('asset_1_cumulative_price'))
    const [token_2_cumulative_price, token_2_cumulative_price_exists] = op.AppLocal.getExUint64(poolAddress.native, contractAppId.native, Bytes('asset_2_cumulative_price'))
    const [cumulativePriceLastTimestamp, cumulativePriceLastTimestampExists] = op.AppLocal.getExUint64(poolAddress.native, contractAppId.native, Bytes('cumulative_price_update_timestamp'))
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
    const [new_cumulative_timestamp, new_cumulative_timestamp_exists] = op.AppLocal.getExUint64(address.native, contractAppIdObj, Bytes('cumulative_price_update_timestamp'))
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
    const previousTimestamp = oracle.cumulativePriceLastTimestamp.native;
    const deltaTime = new_cumulative_timestamp - previousTimestamp;
    const deltaPrice = newCummulativePrice - oracle.asset1LastCumulativePrice.native;
    const scaling_factor = 2 ** 64
    const instantaneous_price = (deltaPrice / deltaTime) / scaling_factor
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
    assert(op.Txn.sender === this.admin_account.value)
    assert(collateralTokenId.native !== this.base_token_id.value.id)
    assert(baseTokenId.native !== this.base_token_id.value.id)
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
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: this.base_token_id.value,
      assetAmount: amount,
    })

    let lstDue: uint64 = 0
    const depositBalance = op.AssetHolding.assetBalance(Global.currentApplicationAddress, this.base_token_id.value)
    if (depositBalance[0] === 0) {
      lstDue = amount
    } else {
      lstDue = this.calculateLSTDue(amount)
    }
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.lst_token_id.value,
        assetAmount: lstDue,
      })
      .submit()
  }

  @abimethod({ allowActions: 'NoOp' })
  withdrawDeposit(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64): void {
    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      xferAsset: this.lst_token_id.value,
      assetAmount: amount,
    })

    //Calculate the return amount of ASA
    const asaDue = this.calculateASADue(amount)

    assert(op.AssetHolding.assetBalance(Global.currentApplicationAddress, this.base_token_id.value)[0] >= asaDue)
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.base_token_id.value,
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
    // Use the external LST contract to get conversion factors.
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: lstApp,
    }).returnValue
    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: lstApp,
    }).returnValue
    // Calculate underlying collateral:
    //    underlyingCollateral = collateralDeposit * totalDepositsExternal / circulatingExternalLST
    const [hiCollateral, loCollateral] = mulw(totalDepositsExternal, collateralDeposit)
    const underlyingCollateral: uint64 = divw(hiCollateral, loCollateral, circulatingExternalLST)

    // ─── 4. Price the underlying collateral in USD via the oracle ────────
    // Query the oracles to fetch an average price for the base asset of the collateral.
    const oraclePrice: uint64 = this.getPricesFromOracles(acceptedCollateral.baseAssetId.native)
    // Assume oraclePrice is expressed in fixed-point (e.g. 6 decimals, meaning price is scaled by 1e6)
    // Compute USD value of the collateral deposit:
    //    collateralUSD = (underlyingCollateral * oraclePrice) / 1e6
    // Use safe arithmetic (you can use mulw/divw if required):
    const [hiUSD, loUSD] = mulw(underlyingCollateral, oraclePrice)
    // Hardcoding scaling factor of 1e6—adjust if your oracle uses a different scaling.
    const collateralUSD: uint64 = divw(hiUSD, loUSD, 1000000)

    // ─── 5. Calculate Maximum Borrowable Amount ───────────────────────────
    // Apply LTV: maxBorrowUSD = collateralUSD * ltv_bps / 10000
    const maxBorrowUSD: uint64 = (collateralUSD * this.ltv_bps.value) / 10000

    // ─── 6. Check that the requested loan does not exceed this amount ───────
    assert(requestedLoanAmount <= maxBorrowUSD)

    // ─── 7. Compute origination fee and actual disbursement ───────────────
    const fee: uint64 = (requestedLoanAmount * this.origination_fee_bps.value) / 10000
    const disbursement: uint64 = requestedLoanAmount - fee

    // ─── 8. Disburse the loan ─────────────────────────────────────────────
    // This transfers the lending contract’s base token (e.g. a stablecoin) to the borrower.
    itxn
      .assetTransfer({
        assetReceiver: op.Txn.sender,
        xferAsset: this.base_token_id.value,
        assetAmount: disbursement,
      })
      .submit()

    // ─── 9. (Optional) Record the borrowing position ─────────────────────
    // You might want to update state variables here to track outstanding debt,
    // collateral locked, etc., for future repayment and liquidation logic.
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
