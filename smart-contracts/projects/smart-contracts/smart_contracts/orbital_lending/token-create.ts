import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { Account } from 'algosdk'

export const createToken = async (deployer: Account, tokenName: string, decimals: number) => {
  const localnet = algorandFixture()
  await localnet.newScope() // Ensure context is initialized before accessing it
  localnet.algorand.setSignerFromAccount(deployer)
  //create xusd asset for contract 1
  const assetCreateTxn = await localnet.context.algorand.send.assetCreate({
    sender: deployer.addr,
    total: 1_700_000_000_000n,
    decimals: decimals,
    defaultFrozen: false,
    unitName: tokenName,
    assetName: tokenName,
    manager: deployer.addr,
    reserve: deployer.addr,
    url: 'https://compx.io',
  })
  return assetCreateTxn.assetId
}
