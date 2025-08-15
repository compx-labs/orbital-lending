/* eslint-disable @typescript-eslint/no-explicit-any */
import algosdk from 'algosdk'
import { OrbitalLendingClient } from '../artifacts/orbital_lending/orbital-lendingClient'

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
  /* 
    const deltaT: uint64 = now - last
      const principal: uint64 = record.scaledDownDisbursement.native
      const rateBps: uint64 = this.interest_bps.value // e.g. 500 = 5%
  
      // 1) Compute principal * rateBps → wide multiply
      const [hi1, lo1] = mulw(principal, rateBps)
      // 2) Convert basis points to fraction: divide by 10_000
      const rateScaled: uint64 = divw(hi1, lo1, 10000)
      // 3) Multiply by time delta: rateScaled * deltaT  → wide multiply
      const [hi2, lo2] = mulw(rateScaled, deltaT)
      // 4) Divide by seconds_per_year to get interest amount
      const interest: uint64 = divw(hi2, lo2, SECONDS_PER_YEAR)
  
      const protoBps: uint64 = this.protocol_interest_fee_bps.value
      const depositorBps: uint64 = 10000 - protoBps
  
      // depositor’s share = interest * depositorBps / 10_000
      const [hiDep, loDep] = mulw(interest, depositorBps)
      const depositorInterest: uint64 = divw(hiDep, loDep, 10000)
  
      // protocol’s share = remainder
      const protocolInterest: uint64 = interest - depositorInterest
  
      // 3) Credit the shares
      // a) Depositors earn yield: bump total_deposits (so LSTs become worth more)
      this.total_deposits.value += depositorInterest
      // b) Protocol earnings: add to fee_pool
      this.fee_pool.value += protocolInterest
  
      // 4) Update borrower’s outstanding debt (principal + full interest)
  
      const newPrincipal: uint64 = principal + interest */

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
