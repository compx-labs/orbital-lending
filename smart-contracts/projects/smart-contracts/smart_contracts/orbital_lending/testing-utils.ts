import algosdk from 'algosdk'
import { OrbitalLendingClient } from '../artifacts/orbital_lending/orbital-lendingClient'

export interface getBoxValueReturnType {
  assetId: bigint
  baseAssetId: bigint
  totalCollateral: bigint
}

export async function getBoxValue(index: bigint, appClient: OrbitalLendingClient): Promise<getBoxValueReturnType> {
  const acceptedCollateralType = new algosdk.ABITupleType([
    new algosdk.ABIUintType(64), // assetId
    new algosdk.ABIUintType(64), // baseAssetId
    new algosdk.ABIUintType(64), // totalCollateral
  ])

  const boxNames = await appClient.appClient.getBoxNames();
  console.log('Box names:', boxNames);

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
  }
}
