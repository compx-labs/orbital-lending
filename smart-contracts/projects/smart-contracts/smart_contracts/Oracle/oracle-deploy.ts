import { microAlgo } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Account } from 'algosdk'
import { OracleFactory } from '../artifacts/Oracle/oracleClient'

export const deployOracle = async (deployer: Account) => {
  const localnet = algorandFixture()
  await localnet.newScope() // Ensure context is initialized before accessing it
  localnet.algorand.setSignerFromAccount(deployer)

  const oracleFactory = localnet.algorand.client.getTypedAppFactory(OracleFactory, {
    defaultSender: deployer.addr,
  })
  const { appClient } = await oracleFactory.send.create.createApplication({
    args: [
      deployer.addr.publicKey, // manager address
    ],
    sender: deployer.addr,
    accountReferences: [deployer.addr],
  })

  appClient.algorand.send.payment({
    sender: deployer.addr,
    receiver: appClient.appAddress,
    amount: microAlgo(1000000),
    note: 'Funding oracle contract',
  })

  return appClient
}
