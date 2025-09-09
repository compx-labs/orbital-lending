/* eslint-disable @typescript-eslint/no-explicit-any */
import algosdk from 'algosdk'
import { OrbitalLendingClient } from '../artifacts/orbital_lending/orbital-lendingClient'

export const BASIS_POINTS: bigint = 10_000n
export const USD_MICRO_UNITS: bigint = 1_000_000n

export const SECONDS_PER_YEAR: bigint = 365n * 24n * 60n * 60n

export interface getBoxValueReturnType {
  assetId: bigint
  baseAssetId: bigint
  marketBaseAssetId: bigint
  totalCollateral: bigint
  boxRef: algosdk.BoxReference
}

export async function getCollateralBoxValue(
  index: bigint,
  appClient: OrbitalLendingClient,
  appId: bigint,
): Promise<getBoxValueReturnType> {
  const acceptedCollateralType = new algosdk.ABITupleType([
    new algosdk.ABIUintType(64), // assetId
    new algosdk.ABIUintType(64), // baseAssetId
    new algosdk.ABIUintType(64), // marketBaseAssetId
    new algosdk.ABIUintType(64), // totalCollateral
  ])

  const boxNames = await appClient.appClient.getBoxNames()
  console.log('Box names:', boxNames)

  const keyBytes = new Uint8Array(8)
  const view = new DataView(keyBytes.buffer)
  view.setBigUint64(0, index, false) // false for big-endian
  const prefix = new TextEncoder().encode('accepted_collaterals')
  const boxName = new Uint8Array(prefix.length + keyBytes.length)
  boxName.set(prefix, 0)
  boxName.set(keyBytes, prefix.length)
  const collateral = await appClient.appClient.getBoxValueFromABIType(boxName, acceptedCollateralType)
  const [assetId, baseAssetId, marketBaseAssetId, totalCollateral] = collateral as bigint[]
  return {
    assetId,
    baseAssetId,
    marketBaseAssetId,
    totalCollateral,
    boxRef: {
      appIndex: appId,
      name: new TextEncoder().encode('accepted_collaterals' + index),
    },
  }
}

export const INDEX_SCALE = 1_000_000_000_000n; // 1e12 (match contract)

export function liveDebtFromSnapshot(principal: bigint, userIndexWad: bigint, borrowIndexWad: bigint): bigint {
  if (principal === 0n) return 0n
  return (principal * borrowIndexWad) / userIndexWad
}

/* borrowerAddress: arc4.Address
  collateralTokenId: arc4.UintN64
  collateralAmount: arc4.UintN64
  lastDebtChange: DebtChange
  borrowedTokenId: arc4.UintN64
  principal: arc4.UintN64 
  userIndexWad: arc4.UintN64 */
export interface getLoanRecordReturnType {
  borrowerAddress: string
  collateralTokenId: bigint
  collateralAmount: bigint
  lastDebtChange: number[]
  borrowedTokenId: bigint
  principal: bigint
  userIndexWad: bigint
  boxRef: algosdk.BoxReference
  
}

/* borrowerAddress: arc4.Address
  collateralTokenId: arc4.UintN64
  collateralAmount: arc4.UintN64
  lastDebtChange: DebtChange
  borrowedTokenId: arc4.UintN64
  principal: arc4.UintN64 
  userIndexWad: arc4.UintN64 */
export async function getLoanRecordBoxValue(
  borrower: string,
  appClient: OrbitalLendingClient,
  appId: bigint,
): Promise<getLoanRecordReturnType> {
  const loanRecordType = new algosdk.ABITupleType([
    new algosdk.ABIAddressType(), // borrowerAddress
    new algosdk.ABIUintType(64), // collateralTokenId
    new algosdk.ABIUintType(64), // collateralAmount
    new algosdk.ABITupleType([
      // struct
      new algosdk.ABIUintType(64), // debtChange amount
      new algosdk.ABIUintType(8), // changeType
      new algosdk.ABIUintType(64), // timestamp
    ]),
    new algosdk.ABIUintType(64), // principal
    new algosdk.ABIUintType(64), // borrowedTokenId
    new algosdk.ABIUintType(64), // userIndexWad
  ])

  const boxNames = await appClient.appClient.getBoxNames()
  for (const boxName of boxNames) {
    console.log('boxname getloanrecord', boxName.name)
    console.log('Box name (base64):', Buffer.from(boxName.name).toString('base64'))
  }
  // Encode the key as "loan_records" + <borrower address as bytes>
  const prefix = new TextEncoder().encode('loan_record')
  const addressBytes = algosdk.decodeAddress(borrower).publicKey
  const boxName = new Uint8Array(prefix.length + addressBytes.length)
  boxName.set(prefix, 0)
  boxName.set(addressBytes, prefix.length)

  const value = await appClient.appClient.getBoxValueFromABIType(boxName, loanRecordType)
  const [
    borrowerAddress,
    collateralTokenId,
    collateralAmount,
    lastDebtChange,
    borrowedTokenId,
    principal,
    userIndexWad,
  ] = value as any[]

  console.log('value from box:', value)

  return {
    borrowerAddress,
    collateralTokenId,
    collateralAmount,
    lastDebtChange,
    principal,
    borrowedTokenId,
    userIndexWad,
    boxRef: {
      appIndex: appId,
      name: boxName,
    },
  }
}

export function calculateDisbursement({
  collateralAmount,
  collateralPrice,
  ltvBps,
  baseTokenPrice,
  requestedLoanAmount,
  originationFeeBps,
}: {
  collateralAmount: bigint
  collateralPrice: bigint
  ltvBps: bigint
  baseTokenPrice: bigint
  requestedLoanAmount: bigint
  originationFeeBps: bigint
}): {
  allowed: boolean
  disbursement: bigint
  fee: bigint
} {
  // Step 1: collateral value in USD
  const collateralUSD = (collateralAmount * collateralPrice) / 1_000_000n

  // Step 2: max borrow USD
  const maxBorrowUSD = (collateralUSD * ltvBps) / 10_000n
  console.log('collateralUSD:', collateralUSD)
  console.log('ltvBps:', ltvBps)


  // Step 3: requested borrow value in USD
  const borrowValueUSD = (requestedLoanAmount * baseTokenPrice) / 1_000_000n

  const allowed = borrowValueUSD <= maxBorrowUSD
  console.log('borrowValueUSD:', borrowValueUSD)
  console.log('maxBorrowUSD:', maxBorrowUSD)
  console.log('allowed:', allowed)

  // Step 4: fee and disbursement
  const fee = (requestedLoanAmount * originationFeeBps) / 10_000n
  const disbursement = requestedLoanAmount - fee

  return { allowed, disbursement, fee }
}


export function utilNormBps(totalDeposits: bigint, totalBorrows: bigint, utilCapBps: bigint) {
  if (totalDeposits === 0n) return 0n
  // capBorrow = floor(D * util_cap_bps / 10_000)
  const capBorrow = (totalDeposits * utilCapBps) / BASIS_POINTS
  if (capBorrow === 0n) return 0n
  const cappedB = totalBorrows <= capBorrow ? totalBorrows : capBorrow
  return (cappedB * BASIS_POINTS) / capBorrow // 0..10_000
}

/**
 * APR (bps) from normalized utilization for the kinked model.
 * Params: { base_bps, kink_norm_bps, slope1_bps, slope2_bps, max_apr_bps }
 */
export function aprBpsKinked(
  U_norm_bps: bigint,
  params: {
    base_bps: bigint
    kink_norm_bps: bigint
    slope1_bps: bigint
    slope2_bps: bigint
    max_apr_bps: bigint
  },
) {
  const { base_bps, kink_norm_bps, slope1_bps, slope2_bps, max_apr_bps = 0n } = params

  let apr
  if (U_norm_bps <= kink_norm_bps) {
    // base + slope1 * U / kink
    apr = base_bps + (slope1_bps * U_norm_bps) / kink_norm_bps
  } else {
    // base + slope1 + slope2 * (U - kink) / (1 - kink)
    const over = U_norm_bps - kink_norm_bps
    const denom = BASIS_POINTS - kink_norm_bps
    apr = base_bps + slope1_bps + (slope2_bps * over) / denom
  }
  if (max_apr_bps > 0n && apr > max_apr_bps) apr = max_apr_bps
  return apr
}

export function currentAprBps(state: {
  totalDeposits: bigint
  totalBorrows: bigint
  base_bps: bigint
  util_cap_bps: bigint
  kink_norm_bps: bigint
  slope1_bps: bigint
  slope2_bps: bigint
  max_apr_bps: bigint
  ema_alpha_bps: bigint
  max_apr_step_bps: bigint
  prev_apr_bps: bigint
  util_ema_bps: bigint
  rate_model_type: bigint // 0 = kinked, 1 = fixed-rate fallback
  interest_bps_fallback: bigint // used if rate_model_type is 1
}) {
  const {
    totalDeposits,
    totalBorrows,
    base_bps,
    util_cap_bps,
    kink_norm_bps,
    slope1_bps,
    slope2_bps,
    max_apr_bps = 0n,
    ema_alpha_bps = 0n,
    max_apr_step_bps = 0n,
    prev_apr_bps = 0n,
    util_ema_bps = 0n,
    rate_model_type = 0n,
    interest_bps_fallback = 0n,
  } = state

  // 1) Utilization (normalized 0..10_000 over the capped band)
  const U_raw = utilNormBps(totalDeposits, totalBorrows, util_cap_bps)

  // 2) Optional EMA smoothing
  let U_used
  let next_util_ema_bps = util_ema_bps
  if (ema_alpha_bps === 0n) {
    U_used = U_raw
  } else {
    // U_smooth = α*U_raw + (1-α)*prev
    const oneMinus = BASIS_POINTS - ema_alpha_bps
    U_used = (ema_alpha_bps * U_raw) / BASIS_POINTS + (oneMinus * util_ema_bps) / BASIS_POINTS
    next_util_ema_bps = U_used
  }

  // 3) Base APR from selected model
  let apr_bps =
    rate_model_type === 0n
      ? aprBpsKinked(U_used, {
          base_bps,
          kink_norm_bps,
          slope1_bps,
          slope2_bps,
          max_apr_bps,
        })
      : interest_bps_fallback // fixed-rate fallback if you want it

  // 4) Optional per-step change limiter
  if (max_apr_step_bps > 0n) {
    const prev = prev_apr_bps === 0n ? base_bps : prev_apr_bps
    const lo = prev > max_apr_step_bps ? prev - max_apr_step_bps : 0n
    const hi = prev + max_apr_step_bps
    if (apr_bps < lo) apr_bps = lo
    if (apr_bps > hi) apr_bps = hi
  }

  return {
    apr_bps,
    next_prev_apr_bps: apr_bps,
    next_util_ema_bps,
  }
}

export function accrueMarketSlice({
  now,
  lastAccrualTs,
  lastAprBps,
  totalBorrows,     // aggregate debt before this slice
  totalDeposits,    // TVL before slice (principal TVL)
  feePool,
}: {
  now: bigint
  lastAccrualTs: bigint
  lastAprBps: bigint         // APR in bps for the CLOSED interval
  totalBorrows: bigint
  totalDeposits: bigint
  feePool: bigint
}) {
  const SECONDS_PER_YEAR = 60n * 60n * 24n * 365n
  const BASIS_POINTS = 10_000n

  if (now <= lastAccrualTs) {
    return {
      interest: 0n,
      newTotalBorrows: totalBorrows,
      newTotalDeposits: totalDeposits,
      newFeePool: feePool,
      newLastAccrualTs: lastAccrualTs,
      simpleWad: 0n,       // for index update: (INDEX_SCALE * rateBps * dt / YEAR / 10_000)
    }
  }

  const dt = now - lastAccrualTs

  // simpleWad = INDEX_SCALE * (lastAprBps / 10_000) * (dt / YEAR)
  const simpleWad = (INDEX_SCALE * lastAprBps * dt) / SECONDS_PER_YEAR / BASIS_POINTS

  // interest = totalBorrows * simple   (simple in WAD)
  const interest = (totalBorrows * simpleWad) / INDEX_SCALE

  const depositorBps = BASIS_POINTS - 0n // you’ll pass protocol split below
  // We’ll split using protocolBps supplied by the test, so make it a param:
  return { interest, simpleWad, dt }
}

export function applyInterestSplit({
  interest,
  protocolBps,
  totalBorrows,
  totalDeposits,
  feePool,
  lastAccrualTs,
  now,
}: {
  interest: bigint
  protocolBps: bigint
  totalBorrows: bigint
  totalDeposits: bigint
  feePool: bigint
  lastAccrualTs: bigint
  now: bigint
}) {
  const BASIS_POINTS = 10_000n
  const depositorBps = BASIS_POINTS - protocolBps

  const depositorInterest = (interest * depositorBps) / BASIS_POINTS
  const protocolInterest  = interest - depositorInterest

  return {
    newTotalBorrows: totalBorrows + interest,
    newTotalDeposits: totalDeposits + depositorInterest,
    newFeePool: feePool + protocolInterest,
    newLastAccrualTs: now,
  }
}

export function advanceBorrowIndex(oldBorrowIndexWad: bigint, simpleWad: bigint): bigint {
  // newIndex = oldIndex * (1 + simple) = oldIndex + oldIndex*simple
  return oldBorrowIndexWad + (oldBorrowIndexWad * simpleWad) / INDEX_SCALE
}
export function recomputeNextAprBps(state: {
  totalDeposits: bigint
  totalBorrows: bigint
  base_bps: bigint
  util_cap_bps: bigint
  kink_norm_bps: bigint
  slope1_bps: bigint
  slope2_bps: bigint
  max_apr_bps: bigint
  ema_alpha_bps: bigint
  max_apr_step_bps: bigint
  prev_apr_bps: bigint
  util_ema_bps: bigint
  rate_model_type: bigint
  interest_bps_fallback: bigint
}) {
  const { apr_bps, next_prev_apr_bps, next_util_ema_bps } = currentAprBps(state)
  return {
    next_lastAprBps: apr_bps,
    next_prev_apr_bps,
    next_util_ema_bps,
  }
}
export function applyBorrow({
  principalDelta,              // disbursement
  borrower,                    // { principal, userIndexWad }
  borrowIndexWad,
  totalBorrows,
}: {
  principalDelta: bigint
  borrower: { principal: bigint, userIndexWad: bigint }
  borrowIndexWad: bigint
  totalBorrows: bigint
}) {
  const newPrincipal = borrower.principal + principalDelta
  return {
    borrower: {
      principal: newPrincipal,
      userIndexWad: borrowIndexWad,   // snapshot at post-borrow
    },
    newTotalBorrows: totalBorrows + principalDelta,
  }
}

export function applyRepay({
  repayAmount,
  borrower,
  borrowIndexWad,
  totalBorrows,
}: {
  repayAmount: bigint
  borrower: { principal: bigint, userIndexWad: bigint }
  borrowIndexWad: bigint
  totalBorrows: bigint
}) {
  const liveDebt = liveDebtFromSnapshot(borrower.principal, borrower.userIndexWad, borrowIndexWad)
  if (repayAmount > liveDebt) throw new Error('repay > liveDebt')
  const remaining = liveDebt - repayAmount
  return {
    borrower: {
      principal: remaining,
      userIndexWad: borrowIndexWad,   // resnapshot after repay
    },
    newTotalBorrows: totalBorrows - repayAmount,
    fullyRepaid: remaining === 0n,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Buyout terms (premium in buyout token, debt repayment in base token)
// ───────────────────────────────────────────────────────────────────────────
// LST collateral valuation in micro-USD using on-chain exchange rate
// underlying = (amountLST * totalDeposits) / circulatingLST
// valueUSD  = underlying * price(underlyingBase) / 1e6
export function collateralUSDFromLST(
  collateralLSTAmount: bigint,
  totalDepositsLST: bigint,
  circulatingLST: bigint,
  underlyingBasePrice: bigint // µUSD per 1 unit of the LST's underlying base asset
): bigint {
  if (collateralLSTAmount === 0n || totalDepositsLST === 0n || circulatingLST === 0n) return 0n
  const underlying = (collateralLSTAmount * totalDepositsLST) / circulatingLST
  return (underlying * underlyingBasePrice) / USD_MICRO_UNITS
}

// Base-token-denominated debt → micro-USD
export function debtUSD(
  debtBaseUnits: bigint,
  baseTokenPrice: bigint // µUSD per 1 base token
): bigint {
  if (debtBaseUnits === 0n) return 0n
  return (debtBaseUnits * baseTokenPrice) / USD_MICRO_UNITS
}
/**
 * Compute buyout premium and debt repayment amounts.
 *
 * @param params
 *  - collateralLSTAmount: amount of LST being bought out (borrower’s full collateral)
 *  - totalDepositsLST, circulatingLST: from LST app
 *  - underlyingBasePrice: µUSD price of the LST’s underlying base asset (e.g., xUSD=1e6)
 *  - baseTokenPrice: µUSD price of the market base token (debt is in this token)
 *  - buyoutTokenPrice: µUSD price of the token used to pay the premium (e.g., xUSD)
 *  - principal, userIndexWad, borrowIndexWad: borrower snapshot + market index
 *  - liq_threshold_bps: liquidation threshold in bps (e.g., 8500)
 *
 * @returns
 *  - eligible: whether CR_bps > liq_threshold_bps
 *  - premiumTokens: amount of buyout token (xUSD) needed to pay the premium
 *  - premiumUSD: premium value in µUSD (for debugging/asserts)
 *  - debtRepayAmountBase: full live debt in base token units (ASA/ALGO) to be repaid
 *  - collateralUSD, debtUSDv, CR_bps, premiumRateBps: intermediates for assertions
 */
export function computeBuyoutTerms(params: {
  collateralLSTAmount: bigint
  totalDepositsLST: bigint
  circulatingLST: bigint
  underlyingBasePrice: bigint
  baseTokenPrice: bigint
  buyoutTokenPrice: bigint
  principal: bigint
  userIndexWad: bigint
  borrowIndexWad: bigint
  liq_threshold_bps: bigint
}) {
  const {
    collateralLSTAmount,
    totalDepositsLST,
    circulatingLST,
    underlyingBasePrice,
    baseTokenPrice,
    buyoutTokenPrice,
    principal,
    userIndexWad,
    borrowIndexWad,
    liq_threshold_bps,
  } = params

  // 1) Live debt (base token units)
  const debtRepayAmountBase = liveDebtFromSnapshot(principal, userIndexWad, borrowIndexWad)

  // 2) Collateral USD via LST exchange rate
  const collateralUSD = collateralUSDFromLST(
    collateralLSTAmount,
    totalDepositsLST,
    circulatingLST,
    underlyingBasePrice
  )

  // 3) Debt USD
  const debtUSDv = debtUSD(debtRepayAmountBase, baseTokenPrice)

  // Edge-guards
  if (debtRepayAmountBase === 0n || debtUSDv === 0n) {
    // No debt → buyout not applicable
    return {
      eligible: false as const,
      premiumTokens: 0n,
      premiumUSD: 0n,
      debtRepayAmountBase,
      collateralUSD,
      debtUSDv,
      CR_bps: 0n,
      premiumRateBps: 0n,
    }
  }

  // 4) Collateral Ratio in bps: (collateralUSD / debtUSD) * 10_000
  const CR_bps = (collateralUSD * BASIS_POINTS) / debtUSDv
  const eligible = CR_bps > liq_threshold_bps

  if (!eligible) {
    return {
      eligible,
      premiumTokens: 0n,
      premiumUSD: 0n,
      debtRepayAmountBase,
      collateralUSD,
      debtUSDv,
      CR_bps,
      premiumRateBps: 0n,
    }
  }

  // 5) Premium rate (bps): (CR_bps / liq_threshold_bps) * 10_000 - 10_000
  // Equivalent to: premiumRateBps = (CR_bps * 10_000 / liq_threshold_bps) - 10_000
  const premiumRateBps = (CR_bps * BASIS_POINTS) / liq_threshold_bps - BASIS_POINTS

  // 6) Premium USD = collateralUSD * premiumRateBps / 10_000
  const premiumUSD = (collateralUSD * premiumRateBps) / BASIS_POINTS

  // 7) Premium in buyout token units: premiumTokens = premiumUSD * 1e6 / buyoutTokenPrice
  // (e.g., if buyout token is xUSD at 1_000_000 µUSD, this is a 1:1 conversion)
  const premiumTokens =
    buyoutTokenPrice === 0n ? 0n : (premiumUSD * USD_MICRO_UNITS) / buyoutTokenPrice

  return {
    eligible,
    premiumTokens,        // pay this much xUSD (or other buyout token)
    premiumUSD,           // µUSD, useful for asserts/logs
    debtRepayAmountBase,  // repay this much in the market base token
    collateralUSD,
    debtUSDv,
    CR_bps,
    premiumRateBps,
  }
}
