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
  totalCollateral: arc4.UintN64
}> {}

export class AcceptedCollateralKey extends arc4.Struct<{
  assetId: arc4.UintN64
}> {}

export class LoanRecord extends arc4.Struct<{
  borrowerAddress: arc4.Address
  collateralTokenId: arc4.UintN64
  collateralAmount: arc4.UintN64
  disbursement: arc4.UintN64
  scaledDownDisbursement: arc4.UintN64
  borrowedTokenId: arc4.UintN64
  lastAccrualTimestamp: arc4.UintN64
}> {}

