import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { OrbitalLendingAsaFactory } from '../artifacts/orbital_lending/orbital-lending-asaClient'
import algosdk, { Account } from 'algosdk'

type AdminRoles = {
  paramAdmin?: Account
  feeAdmin?: Account
}

export const deploy = async (baseAssetId: bigint, deployer: Account, admins: AdminRoles = {}) => {
  const localnet = algorandFixture()
  await localnet.newScope() // Ensure context is initialized before accessing it
  localnet.algorand.setSignerFromAccount(deployer)
  const paramAdmin = admins.paramAdmin ?? deployer
  const feeAdmin = admins.feeAdmin ?? deployer

  const factory = localnet.algorand.client.getTypedAppFactory(OrbitalLendingAsaFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient } = await factory.send.create.createApplication({
    args: {
      paramAdmin: paramAdmin.addr.publicKey,
      feeAdmin: feeAdmin.addr.publicKey,
      baseTokenId: baseAssetId,
    },
    sender: deployer.addr,
    accountReferences: [deployer.addr, paramAdmin.addr, feeAdmin.addr],
    assetReferences: [baseAssetId],
  })
  appClient.algorand.setSignerFromAccount(deployer)
  console.log('app Created, address', algosdk.encodeAddress(appClient.appAddress.publicKey))
  return appClient
}
