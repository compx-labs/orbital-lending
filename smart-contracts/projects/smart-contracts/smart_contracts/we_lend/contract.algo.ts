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
import { Oracle } from './config.algo'
@contract({ name: 'weLend', avmVersion: 11 })
export class WeLend extends Contract {
  // The main lending token of this contract - used for deposit and borrowing
  base_token_id = GlobalState<Asset>({ initialValue: Asset() })

  // LST token of this contract - used for borrowing - generated in the contract at creation time
  lst_token_id = GlobalState<Asset>({ initialValue: Asset() })

  circulating_lst = GlobalState<uint64>()

  total_deposits = GlobalState<uint64>()

  //Admin account
  admin_account = GlobalState<Account>()

  ltv_bps = GlobalState<uint64>()

  liq_threshold_bps = GlobalState<uint64>()

  interest_bps = GlobalState<uint64>()

  origination_fee_bps = GlobalState<uint64>()

  oracle_pools = BoxMap<UintN64, Oracle>({ keyPrefix: 'oracle_pools' })

  oracle_pools_count = GlobalState<uint64>()

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

    /// Submit opt-in transaction: 0 asset transfer to self§
    itxn
      .assetTransfer({
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: this.base_token_id.value,
        assetAmount: 0,
      })
      .submit()

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

  addOraclePool(poolAddress: Address, contractAppId: UintN64): void {
    assert(op.Txn.sender === this.admin_account.value)
    const newOracle: Oracle = new Oracle({
      address: poolAddress,
      contractAppId: contractAppId,
    })
    this.oracle_pools(new arc4.UintN64(this.oracle_pools_count.value + 1)).value = newOracle.copy()
    this.oracle_pools_count.value = this.oracle_pools_count.value + 1
  }

  getOraclePrice(tokenId: uint64, oracleIndex: uint64): uint64 {
    const oracle = this.oracle_pools(new arc4.UintN64(oracleIndex)).value.copy()
    const address = oracle.address
    const contractAppId = oracle.contractAppId

    
    const contractAppIdObj = Application(contractAppId.native);

    const [token_1_id, token_1_exists] = op.AppLocal.getExUint64(address.native, contractAppIdObj, Bytes('asset_1_id'))

    if (token_1_id === tokenId) {
      const [price, priceExists] = op.AppLocal.getExUint64(address.native, contractAppIdObj, Bytes('asset_1_cumulative_price'))
      return price
    } else {
      const [price, priceExists] = op.AppLocal.getExUint64(address.native, contractAppIdObj, Bytes('asset_2_cumulative_price'))
      return price
    }
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

  @abimethod({ allowActions: 'NoOp' })
  addNewCollateralType(collateralTokenId: uint64): void {
    assert(op.Txn.sender === this.admin_account.value)
    itxn
      .assetTransfer({
        sender: Global.currentApplicationAddress,
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: collateralTokenId,
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
  borrow(assetTransferTxn: gtxn.AssetTransferTxn, amount: uint64, app: uint64): void {
    assert(op.AssetHolding.assetBalance(Global.currentApplicationAddress, assetTransferTxn.xferAsset.id)[0] >= 0)

    assertMatch(assetTransferTxn, {
      assetReceiver: Global.currentApplicationAddress,
      assetAmount: amount,
    })

    //Get the circulating LST value from the application that created the LST
    const circulatingExternalLST = abiCall(TargetContract.prototype.getCirculatingLST, {
      appId: app,
    }).returnValue
    const totalDepositsExternal = abiCall(TargetContract.prototype.getTotalDeposits, {
      appId: app,
    }).returnValue
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
