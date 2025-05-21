/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { WeLendClient, WeLendFactory } from '../artifacts/we_lend/weLendClient'
import algosdk, { Account, Address } from 'algosdk'
import { exp, len } from '@algorandfoundation/algorand-typescript/op'
let lendingContractClient: WeLendClient
let managerAccount: Account

let basetokenId = 0n
const INIT_CONTRACT_AMOUNT = 400000n
const ltv_bps = 2500n
const liq_threshold_bps = 1000000n
const interest_bps = 500n
const origination_fee_bps = 1000n
const protocol_interest_fee_bps = 1000n

describe('weLend Testing - config', () => {
  const localnet = algorandFixture()

  // -------------------------------------------------------------------------------------------------
  beforeAll(async () => {
    await localnet.newScope() // Ensure context is initialized before accessing it

    Config.configure({
      debug: true,
    })
    registerDebugEventHandlers()

    const deploy = async () => {
      const { generateAccount } = localnet.context
      managerAccount = await generateAccount({ initialFunds: microAlgo(10000000) })
      const factory = localnet.algorand.client.getTypedAppFactory(WeLendFactory, {
        defaultSender: managerAccount.addr,
      })

      //create baseToken for contract creation
      const assetCreateTxn = await localnet.context.algorand.send.assetCreate({
        sender: managerAccount.addr,
        total: 1000000n,
        decimals: 6,
        defaultFrozen: false,
        unitName: 'BASE',
        assetName: 'BaseToken',
        manager: managerAccount.addr,
        reserve: managerAccount.addr,
        url: 'https://algorand.com',
      })
      basetokenId = assetCreateTxn.assetId

      const { appClient } = await factory.deploy({
        createParams: {
          sender: managerAccount.addr,
          args: [managerAccount.addr.publicKey, basetokenId],
          method: 'createApplication',
          extraFee: microAlgo(2000),
        },
        onUpdate: 'append',
        onSchemaBreak: 'append',
      })
      appClient.algorand.setSignerFromAccount(managerAccount)
      console.log('app Created, address', algosdk.encodeAddress(appClient.appAddress.publicKey));
      return { client: appClient }
    }

    const { client } = await deploy()
    lendingContractClient = client
  }, 30000)

  test('we lend initialization', async () => {
    expect(lendingContractClient).toBeDefined()

    const payTxn = lendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: lendingContractClient.appClient.appAddress,
      amount: microAlgo(INIT_CONTRACT_AMOUNT),
      note: 'Funding weLend',
    })

    /* mbrTxn: 
        gtxn.PaymentTxn,
        ltv_bps: uint64,
        liq_threshold_bps: uint64,
        interest_bps: uint64,
        origination_fee_bps: uint64,
        protocol_interest_fee_bps: uint64, */
    await lendingContractClient.send.initApplication({
      args: [payTxn, ltv_bps, liq_threshold_bps, interest_bps, origination_fee_bps, protocol_interest_fee_bps],
    })
    const globalState = await lendingContractClient.state.global.getAll()
    expect(globalState).toBeDefined()
    expect(globalState.baseTokenId).toEqual(basetokenId)
    
    const adminAddress = globalState.adminAccount;
    const adminAddressBytes = adminAddress?.asByteArray();
    const adminAddressString = adminAddressBytes ? algosdk.encodeAddress(adminAddressBytes) : undefined;
    const managerAccountBytes = managerAccount.addr;
    const managerAccountString = algosdk.encodeAddress(managerAccountBytes.publicKey);
    console.log('adminAddress', adminAddressString);
    expect(adminAddressString).toEqual(managerAccountString)
    expect(globalState.ltvBps).toEqual(ltv_bps)
    expect(globalState.liqThresholdBps).toEqual(liq_threshold_bps)
    expect(globalState.interestBps).toEqual(interest_bps)
    expect(globalState.originationFeeBps).toEqual(origination_fee_bps)
    expect(globalState.protocolInterestFeeBps).toEqual(protocol_interest_fee_bps)
  })
})
