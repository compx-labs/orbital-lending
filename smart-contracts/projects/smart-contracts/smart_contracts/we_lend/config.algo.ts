import { arc4 } from "@algorandfoundation/algorand-typescript"


export class Oracle extends arc4.Struct<{
  address: arc4.Address
  contractAppId: arc4.UintN64
  asset1LastCumulativePrice: arc4.UintN64
  asset2LastCumulativePrice: arc4.UintN64
  cumulativePriceLastTimestamp: arc4.UintN64
}> {}

export class AcceptedCollateral extends arc4.Struct<{
  assetId: arc4.UintN64
  baseAssetId: arc4.UintN64
}> {}

