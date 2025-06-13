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
  disbursement: bigint
  scaledDownDisbursement: bigint
  borrowedTokenId: bigint
  loanRecordASAId: bigint
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
    new algosdk.ABIUintType(64), // disbursement
    new algosdk.ABIUintType(64), // scaledDownDisbursement
    new algosdk.ABIUintType(64), // borrowedTokenId
    new algosdk.ABIUintType(64), // loanRecordASAId
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
    disbursement,
    scaledDownDisbursement,
    borrowedTokenId,
    loanRecordASAId,
    lastAccrualTimestamp,
  ] = value as any[]

  return {
    borrowerAddress,
    collateralTokenId,
    collateralAmount,
    disbursement,
    scaledDownDisbursement,
    borrowedTokenId,
    loanRecordASAId,
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
