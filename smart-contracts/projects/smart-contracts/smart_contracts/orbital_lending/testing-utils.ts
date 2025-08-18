/* eslint-disable @typescript-eslint/no-explicit-any */
import algosdk from 'algosdk'
import { OrbitalLendingClient } from '../artifacts/orbital_lending/orbital-lendingClient'

export const BASIS_POINTS: bigint = 10_000n
export const USD_MICRO_UNITS: bigint = 1_000_000n

export const SECONDS_PER_YEAR: bigint = 365n * 24n * 60n * 60n

export interface getBoxValueReturnType {
  assetId: bigint
  baseAssetId: bigint
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
  const [assetId, baseAssetId, totalCollateral] = collateral as bigint[]
  return {
    assetId,
    baseAssetId,
    totalCollateral,
    boxRef: {
      appIndex: appId,
      name: new TextEncoder().encode('accepted_collaterals' + index),
    },
  }
}

export interface getLoanRecordReturnType {
  borrowerAddress: string
  collateralTokenId: bigint
  collateralAmount: bigint
  lastDebtChange: number[]
  totalDebt: bigint
  borrowedTokenId: bigint
  lastAccrualTimestamp: bigint
  boxRef: algosdk.BoxReference
}
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
    new algosdk.ABIUintType(64), // totalDebt
    new algosdk.ABIUintType(64), // borrowedTokenId
    new algosdk.ABIUintType(64), // lastAccrualTimestamp
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
    totalDebt,
    borrowedTokenId,
    lastAccrualTimestamp,
  ] = value as any[]

  console.log('value from box:', value)

  return {
    borrowerAddress,
    collateralTokenId,
    collateralAmount,
    lastDebtChange,
    totalDebt,
    borrowedTokenId,
    lastAccrualTimestamp,
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

  // Step 3: requested borrow value in USD
  const borrowValueUSD = (requestedLoanAmount * baseTokenPrice) / 1_000_000n

  const allowed = borrowValueUSD <= maxBorrowUSD

  // Step 4: fee and disbursement
  const fee = (requestedLoanAmount * originationFeeBps) / 10_000n
  const disbursement = requestedLoanAmount - fee

  return { allowed, disbursement, fee }
}

export function calculateInterest({
  disbursement,
  interestRateBps,
  lastAccrualTimestamp,
  currentTimestamp,
  protocolBPS,
  totalDeposits,
}: {
  disbursement: bigint
  interestRateBps: bigint
  lastAccrualTimestamp: bigint
  currentTimestamp: bigint
  protocolBPS: bigint
  totalDeposits: bigint
}): {
  newTotalDeposits: bigint
  protocolFees: bigint
  interest: bigint
  newPrincipal: bigint
} {
  
  const deltaT = currentTimestamp - lastAccrualTimestamp
  const principal = disbursement
  const rateBps = interestRateBps
  const SECONDS_PER_YEAR = 60n * 60n * 24n * 365n
  // 1) Compute principal * rateBps → wide multiply
  const principleTimesRate = principal * rateBps
  // 2) Convert basis points to fraction: divide by 10_000
  const rateScaled = principleTimesRate / 10_000n
  // 3) Multiply by time delta: rateScaled * deltaT  → wide multiply
  const interest = (rateScaled * deltaT) / SECONDS_PER_YEAR

  const protoBps = protocolBPS
  const depositorBps = 10_000n - protoBps

  const depositorInterest = (interest * depositorBps) / 10_000n
  const protocolInterest = interest - depositorInterest

  return {
    newTotalDeposits: totalDeposits + depositorInterest,
    protocolFees: protocolInterest,
    interest, // full interest added to borrower’s debt
    newPrincipal: principal + interest,
  }
}

export function utilNormBps(totalDeposits: bigint, totalBorrows: bigint, utilCapBps: bigint) {
  if (totalDeposits === 0n) return 0n;
  // capBorrow = floor(D * util_cap_bps / 10_000)
  const capBorrow = (totalDeposits * utilCapBps) / BASIS_POINTS;
  if (capBorrow === 0n) return 0n;
  const cappedB = totalBorrows <= capBorrow ? totalBorrows : capBorrow;
  return (cappedB * BASIS_POINTS) / capBorrow; // 0..10_000
}

/**
 * APR (bps) from normalized utilization for the kinked model.
 * Params: { base_bps, kink_norm_bps, slope1_bps, slope2_bps, max_apr_bps }
 */
export function aprBpsKinked(U_norm_bps: bigint, params: {
  base_bps: bigint,
  kink_norm_bps: bigint,
  slope1_bps: bigint,
  slope2_bps: bigint,
  max_apr_bps: bigint
}) {
  const {
    base_bps,
    kink_norm_bps,
    slope1_bps,
    slope2_bps,
    max_apr_bps = 0n,
  } = params;

  let apr;
  if (U_norm_bps <= kink_norm_bps) {
    // base + slope1 * U / kink
    apr = base_bps + (slope1_bps * U_norm_bps) / kink_norm_bps;
  } else {
    // base + slope1 + slope2 * (U - kink) / (1 - kink)
    const over = U_norm_bps - kink_norm_bps;
    const denom = BASIS_POINTS - kink_norm_bps;
    apr = base_bps + slope1_bps + (slope2_bps * over) / denom;
  }
  if (max_apr_bps > 0n && apr > max_apr_bps) apr = max_apr_bps;
  return apr;
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
  } = state;

  // 1) Utilization (normalized 0..10_000 over the capped band)
  const U_raw = utilNormBps(totalDeposits, totalBorrows, util_cap_bps);

  // 2) Optional EMA smoothing
  let U_used;
  let next_util_ema_bps = util_ema_bps;
  if (ema_alpha_bps === 0n) {
    U_used = U_raw;
  } else {
    // U_smooth = α*U_raw + (1-α)*prev
    const oneMinus = BASIS_POINTS - ema_alpha_bps;
    U_used =
      (ema_alpha_bps * U_raw) / BASIS_POINTS +
      (oneMinus * util_ema_bps) / BASIS_POINTS;
    next_util_ema_bps = U_used;
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
      : interest_bps_fallback; // fixed-rate fallback if you want it

  // 4) Optional per-step change limiter
  if (max_apr_step_bps > 0n) {
    const prev = prev_apr_bps === 0n ? base_bps : prev_apr_bps;
    const lo = prev > max_apr_step_bps ? prev - max_apr_step_bps : 0n;
    const hi = prev + max_apr_step_bps;
    if (apr_bps < lo) apr_bps = lo;
    if (apr_bps > hi) apr_bps = hi;
  }

  return {
    apr_bps,
    next_prev_apr_bps: apr_bps,
    next_util_ema_bps,
  };
}
