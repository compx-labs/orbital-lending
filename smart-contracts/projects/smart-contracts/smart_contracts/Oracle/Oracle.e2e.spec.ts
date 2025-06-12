/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { OrbitalLendingClient, OrbitalLendingFactory } from '../artifacts/orbital_lending/orbital-lendingClient'
import algosdk, { Account, Address } from 'algosdk'
import { exp, len } from '@algorandfoundation/algorand-typescript/op'
import { OracleClient, OracleFactory } from '../artifacts/Oracle/oracleClient'
import { deployOracle } from './oracle-deploy'

let xUSDLendingContractClient: OrbitalLendingClient
let algoLendingContractClient: OrbitalLendingClient
let oracleAppClient: OracleClient
let managerAccount: Account

const INIT_CONTRACT_AMOUNT = 400000n
const ltv_bps = 2500n
const liq_threshold_bps = 1000000n
const interest_bps = 500n
const origination_fee_bps = 1000n
const protocol_interest_fee_bps = 1000n

describe('orbital-lending Testing - config', () => {
  const localnet = algorandFixture()

  // -------------------------------------------------------------------------------------------------
  beforeAll(async () => {
    await localnet.newScope() // Ensure context is initialized before accessing it

    Config.configure({
      debug: true,
    })
    registerDebugEventHandlers()

    const { generateAccount } = localnet.context
    managerAccount = await generateAccount({ initialFunds: microAlgo(10000000) })



    oracleAppClient = await deployOracle(managerAccount)
  }, 30000)

  test('oracle add token listing', async () => {
    const tokenId = 1223456n;
    const price = 10000n;

    await oracleAppClient.send.addTokenListing({
      args: [tokenId, price],
      sender: managerAccount.addr,
    });
  });

  test('oracle get token price', async () => {
    const tokenId = 1223456n;

    const price = await oracleAppClient.send.getTokenPrice({
      args: [tokenId],
      sender: managerAccount.addr,
    })
    console.log(price.return?.price);
  });
})
