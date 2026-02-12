/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/explicit-member-accessibility */
import { Account, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  abimethod,
  assert,
  BoxMap,
  contract,
  Contract,
  err,
  Global,
  GlobalState,
  op,
} from '@algorandfoundation/algorand-typescript'
import { UintN64 } from '@algorandfoundation/algorand-typescript/arc4'
import { OracleKey, TokenPrice } from './config.algo'

@contract({ name: 'oracle', avmVersion: 11 })
export class Oracle extends Contract {
  token_prices = BoxMap<OracleKey, TokenPrice>({ keyPrefix: 'prices' })

  //Admin account
  admin_account = GlobalState<Account>()

  @abimethod({ allowActions: 'NoOp', onCreate: 'require' })
  public createApplication(admin: Account): void {
    this.admin_account.value = admin
  }

  @abimethod({ allowActions: 'NoOp' })
  public addTokenListing(assetId: UintN64, initialPrice: uint64): void {
    assert(op.Txn.sender === this.admin_account.value)
    assert(initialPrice > 0, 'PRICE_MUST_BE_POSITIVE')
    const key = new OracleKey({ assetId: assetId })
    assert(!this.token_prices(key).exists, 'ASSET_ALREADY_LISTED')

    const newTokenPrice = new TokenPrice({
      assetId: assetId,
      price: new UintN64(initialPrice),
      lastUpdated: new UintN64(Global.latestTimestamp),
    })
    this.token_prices(key).value = newTokenPrice.copy()
  }

  @abimethod({ allowActions: 'NoOp' })
  public updateTokenPrice(assetId: UintN64, newPrice: uint64): void {
    assert(op.Txn.sender === this.admin_account.value)
    assert(newPrice > 0, 'PRICE_MUST_BE_POSITIVE')

    const key = new OracleKey({ assetId: assetId })
    assert(this.token_prices(key).exists)

    const newTokenPrice = new TokenPrice({
      assetId: assetId,
      price: new UintN64(newPrice),
      lastUpdated: new UintN64(Global.latestTimestamp),
    })
    this.token_prices(key).value = newTokenPrice.copy()
  }

  @abimethod({ allowActions: 'NoOp' })
  public getTokenPrice(assetId: UintN64): TokenPrice {
    const key = new OracleKey({ assetId: assetId })
    assert(this.token_prices(key).exists)
    return this.token_prices(key).value.copy()
  }

  @abimethod({ allowActions: 'NoOp' })
  public removeTokenListing(assetId: UintN64): void {
    assert(op.Txn.sender === this.admin_account.value)
    assert(this.token_prices(new OracleKey({ assetId: assetId })).exists, 'ASSET_NOT_LISTED')

    const key = new OracleKey({ assetId: assetId })
    assert(this.token_prices(key).exists)

    this.token_prices(key).delete()
  }
}
