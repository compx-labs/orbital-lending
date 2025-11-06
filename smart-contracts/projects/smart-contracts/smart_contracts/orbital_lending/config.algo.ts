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
export const BUYOUT_MBR: uint64 = 10_000
export const DEPOSIT_MBR: uint64 = 10_000
export const WITHDRAW_MBR: uint64 = 3_000

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
  total_deposits: arc4.UintN64
  total_borrows: arc4.UintN64
  circulating_lst: arc4.UintN64
  cash_on_hand: arc4.UintN64
  borrowIndexWad: arc4.UintN64
  base_token_id: arc4.UintN64
  commission_percentage: arc4.UintN64
  lst_token_id: arc4.UintN64
  fee_pool: arc4.UintN64
  accepted_collaterals_count: arc4.UintN64
  buyout_token_id: arc4.UintN64
  liq_bonus_bps: arc4.UintN64
  current_accumulated_commission: arc4.UintN64
  total_commission_earned: arc4.UintN64
  total_additional_rewards: arc4.UintN64
  active_loan_records: arc4.UintN64
}> {}

export class DepositRecord extends arc4.Struct<{
  depositAmount: arc4.UintN64
  assetId: arc4.UintN64
}> {}

export class DepositRecordKey extends arc4.Struct<{
  userAddress: arc4.Address
  assetId: arc4.UintN64
}> {}
