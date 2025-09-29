import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { OrbitalLendingAsaFactory } from '../artifacts/orbital_lending/orbital-lending-asaClient'
import algosdk, { Account } from 'algosdk'

export const deploy = async (baseAssetId: bigint, deployer: Account) => {
  const localnet = algorandFixture()
  await localnet.newScope() // Ensure context is initialized before accessing it
  localnet.algorand.setSignerFromAccount(deployer)

  const factory = localnet.algorand.client.getTypedAppFactory(OrbitalLendingAsaFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient } = await factory.send.create.createApplication({
    args: [
      deployer.addr.publicKey, // manager address
      baseAssetId, // base asset id
    ],
    sender: deployer.addr,
    accountReferences: [deployer.addr],
    assetReferences: [baseAssetId],
  })
  appClient.algorand.setSignerFromAccount(deployer)
  console.log('app Created, address', algosdk.encodeAddress(appClient.appAddress.publicKey))
  return appClient
}
