import { arc4, uint64 } from '@algorandfoundation/algorand-typescript'

export const MBR_CREATE_APP: uint64 = 400_000
export const MBR_INIT_APP: uint64 = 102_000
export const MBR_OPT_IN_LST: uint64 = 2_000
export const MBR_COLLATERAL: uint64 = 101_000
export const STANDARD_TXN_FEE: uint64 = 1_000
export const VALIDATE_BORROW_FEE: uint64 = 4_000
export const BASIS_POINTS: uint64 = 10_000
export const USD_MICRO_UNITS: uint64 = 1_000_000
export const INDEX_SCALE: uint64 = 1_000_000_000_000 // 1e12
export const DEBUG_TIMESTAMP_OFFSET: uint64 = 1_728_000
export const SECONDS_PER_YEAR: uint64 = 365 * 24 * 60 * 60
export const MINIMUM_ADDITIONAL_REWARD: uint64 = 10_000
export const MIGRATION_FEE: uint64 = 500_000 // 0.5 Algo

export class AcceptedCollateral extends arc4.Struct<{
  assetId: arc4.UintN64
  baseAssetId: arc4.UintN64
  marketBaseAssetId: arc4.UintN64
  totalCollateral: arc4.UintN64
  originatingAppId: arc4.UintN64
}> {}

export class AcceptedCollateralKey extends arc4.Struct<{
  assetId: arc4.UintN64
}> {}

export class DebtChange extends arc4.Struct<{
  amount: arc4.UintN64
  changeType: arc4.UintN8 // 0 = borrow, 1 = interest, 2 = repayment
  timestamp: arc4.UintN64
}> {}

export class LoanRecord extends arc4.Struct<{
  borrowerAddress: arc4.Address
  collateralTokenId: arc4.UintN64
  collateralAmount: arc4.UintN64
  lastDebtChange: DebtChange
  borrowedTokenId: arc4.UintN64
  principal: arc4.UintN64
  userIndexWad: arc4.UintN64
}> {}

export class InterestAccrualReturn extends arc4.Struct<{
  change: DebtChange
  totalDebt: arc4.UintN64
}> {}

export class MigrationSnapshot extends arc4.Struct<{
  totalDeposits: arc4.UintN64
  totalBorrows: arc4.UintN64
  circulatingLst: arc4.UintN64
  cashOnHand: arc4.UintN64
  feePool: arc4.UintN64
  totalAdditionalRewards: arc4.UintN64
  currentAccumulatedCommission: arc4.UintN64
  totalCommissionEarned: arc4.UintN64
}> {}
