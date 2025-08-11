import { arc4 } from "@algorandfoundation/algorand-typescript"



export class AcceptedCollateral extends arc4.Struct<{
  assetId: arc4.UintN64
  baseAssetId: arc4.UintN64
  totalCollateral: arc4.UintN64
}> {}

export class AcceptedCollateralKey extends arc4.Struct<{
  assetId: arc4.UintN64
}> {}

export class DebtChange extends arc4.Struct<{
  amount: arc4.UintN64
  changeType: arc4.UintN8  // 0 = borrow, 1 = interest, 2 = repayment
  timestamp: arc4.UintN64
}> {}

export class LoanRecord extends arc4.Struct<{
  borrowerAddress: arc4.Address
  collateralTokenId: arc4.UintN64
  collateralAmount: arc4.UintN64
  lastDebtChange: DebtChange
  totalDebt: arc4.UintN64
  borrowedTokenId: arc4.UintN64
  lastAccrualTimestamp: arc4.UintN64
}> {}

export class InterestAccrualReturn extends arc4.Struct<{
  change: DebtChange,
  totalDebt: arc4.UintN64
}> {}

