/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { OrbitalLendingClient, OrbitalLendingFactory } from '../artifacts/orbital_lending/orbital-lendingClient'
import algosdk, { Account, Address } from 'algosdk'
import { exp, len } from '@algorandfoundation/algorand-typescript/op'
import { getBoxValue } from './testing-utils'
import { OracleClient, OracleFactory } from '../artifacts/Oracle/oracleClient'
let xUSDLendingContractClient: OrbitalLendingClient
let algoLendingContractClient: OrbitalLendingClient
let oracleAppClient: OracleClient
let managerAccount: Account
let depositorAccount: Account

let xUSDAssetId = 0n
let cxUSDAssetId = 0n
let cAlgoAssetId = 0n
const INIT_CONTRACT_AMOUNT = 400000n
const ltv_bps = 2500n
const liq_threshold_bps = 1000000n
const interest_bps = 500n
const origination_fee_bps = 1000n
const protocol_interest_fee_bps = 1000n

describe('orbital-lending Testing - collateral setup', () => {
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

    depositorAccount = await generateAccount({ initialFunds: microAlgo(10000000) })

    const deploy = async (baseAssetId: bigint, appName: string) => {
      const factory = localnet.algorand.client.getTypedAppFactory(OrbitalLendingFactory, {
        defaultSender: managerAccount.addr,
      })

      const { appClient } = await factory.send.create.createApplication({
        args: [
          managerAccount.addr.publicKey, // manager address
          baseAssetId, // base asset id
        ],
        sender: managerAccount.addr,
        accountReferences: [managerAccount.addr],
        assetReferences: [baseAssetId],
      })
      appClient.algorand.setSignerFromAccount(managerAccount)
      console.log('app Created, address', algosdk.encodeAddress(appClient.appAddress.publicKey))
      return { client: appClient }
    }

    //create xusd asset for contract 1
    const assetCreateTxn = await localnet.context.algorand.send.assetCreate({
      sender: managerAccount.addr,
      total: 1700000000n,
      decimals: 6,
      defaultFrozen: false,
      unitName: 'xUSD',
      assetName: 'xUSD Stablecoin',
      manager: managerAccount.addr,
      reserve: managerAccount.addr,
      url: 'https://compx.io',
    })
    xUSDAssetId = assetCreateTxn.assetId

    const xUSDDeploymentResult = await deploy(xUSDAssetId, 'xUSD Lending')
    xUSDLendingContractClient = xUSDDeploymentResult.client
    const xUSDGlobalState = await xUSDLendingContractClient.state.global.getAll()
    console.log('xusd contract base asset id', xUSDGlobalState.baseTokenId)
    expect(xUSDGlobalState.baseTokenId).toEqual(xUSDAssetId)

    const algoDeploymentResult = await deploy(0n, 'Algo Lending')
    algoLendingContractClient = algoDeploymentResult.client
    const algoGlobalState = await algoLendingContractClient.state.global.getAll()
    console.log('algo contract base asset id', algoGlobalState.baseTokenId)
    expect(algoGlobalState.baseTokenId).toEqual(0n)

    const oracleFactory = localnet.algorand.client.getTypedAppFactory(OracleFactory, {
      defaultSender: managerAccount.addr,
    })
    const { appClient } = await oracleFactory.deploy({
      createParams: {
        sender: managerAccount.addr,
        args: [managerAccount.addr.publicKey],
        method: 'createApplication',
        extraFee: microAlgo(2000),
      },
      onUpdate: 'append',
      onSchemaBreak: 'append',
      appName: 'Oracle',
    })
    oracleAppClient = appClient

    oracleAppClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: oracleAppClient.appAddress,
      amount: microAlgo(1000000),
      note: 'Funding oracle contract',
    })
  }, 30000)

  test('orbital initialization - xUSD client', async () => {
    expect(xUSDLendingContractClient).toBeDefined()

    const payTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(INIT_CONTRACT_AMOUNT),
      note: 'Funding contract',
    })
    await xUSDLendingContractClient.send.initApplication({
      args: [
        payTxn,
        ltv_bps,
        liq_threshold_bps,
        interest_bps,
        origination_fee_bps,
        protocol_interest_fee_bps,
        oracleAppClient.appId,
      ],
    })

    const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(102000n),
      note: 'Funding contract',
    })

    await xUSDLendingContractClient.send.generateLstToken({
      args: [mbrTxn],
    })
    const globalState = await xUSDLendingContractClient.state.global.getAll()
    expect(globalState).toBeDefined()
    expect(globalState.baseTokenId).toEqual(xUSDAssetId)
    expect(globalState.ltvBps).toEqual(ltv_bps)
    expect(globalState.liqThresholdBps).toEqual(liq_threshold_bps)
    expect(globalState.interestBps).toEqual(interest_bps)
    expect(globalState.originationFeeBps).toEqual(origination_fee_bps)
    expect(globalState.protocolInterestFeeBps).toEqual(protocol_interest_fee_bps)
    expect(globalState.baseTokenId).toEqual(xUSDAssetId)
    expect(globalState.lstTokenId).toBeDefined()
    cxUSDAssetId = globalState.lstTokenId ? 0n : 0n
  })

  test('orbital initialization - algo client', async () => {
    expect(algoLendingContractClient).toBeDefined()

    const payTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(INIT_CONTRACT_AMOUNT),
      note: 'Funding contract',
    })
    await algoLendingContractClient.send.initApplication({
      args: [
        payTxn,
        ltv_bps,
        liq_threshold_bps,
        interest_bps,
        origination_fee_bps,
        protocol_interest_fee_bps,
        oracleAppClient.appId,
      ],
    })

    //create lst externally
    const assetCreateREsult = await algoLendingContractClient.algorand.send.assetCreate({
      sender: managerAccount.addr,
      total: 10000000000n,
      decimals: 6,
      defaultFrozen: false,
      unitName: 'cALGO',
      assetName: 'cALGO',
      manager: managerAccount.addr,
      reserve: managerAccount.addr,
      url: 'https://compx.io',
    })

    const lstId = assetCreateREsult.assetId

    const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(2000n),
      note: 'Funding lst optin',
    })

    await algoLendingContractClient.send.optInToLst({
      args: [lstId, mbrTxn],
    })

    const axferTxn = algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: lstId,
      amount: 1000000n,
      note: 'sending lst',
    })

    await algoLendingContractClient.send.configureLstToken({
      args: [axferTxn, 12000000n],
    })

    const globalState = await algoLendingContractClient.state.global.getAll()
    expect(globalState).toBeDefined()
    expect(globalState.baseTokenId).toEqual(0n)

    expect(globalState.ltvBps).toEqual(ltv_bps)
    expect(globalState.liqThresholdBps).toEqual(liq_threshold_bps)
    expect(globalState.interestBps).toEqual(interest_bps)
    expect(globalState.originationFeeBps).toEqual(origination_fee_bps)
    expect(globalState.protocolInterestFeeBps).toEqual(protocol_interest_fee_bps)
    expect(globalState.lstTokenId).toEqual(lstId)
    expect(globalState.circulatingLst).toEqual(12000000n)
    cAlgoAssetId = lstId
    console.log('cAlgoAssetId', cAlgoAssetId)
  })

  test('add new collateral - xUSD Lending Contract - cAlgo collateral', async () => {
    const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(101000n),
      note: 'Funding collateral addition',
    })

    const boxNames = await xUSDLendingContractClient.appClient.getBoxNames()
    console.log('Box names before:', boxNames)

    await xUSDLendingContractClient.send.addNewCollateralType({
      args: [cAlgoAssetId, mbrTxn],
      assetReferences: [cAlgoAssetId],
    })

    const boxValue = await getBoxValue(cAlgoAssetId, xUSDLendingContractClient)
    expect(boxValue).toBeDefined()
    expect(boxValue.assetId).toEqual(cAlgoAssetId)
    expect(boxValue.baseAssetId).toEqual(xUSDAssetId)
    expect(boxValue.totalCollateral).toEqual(0n)
  })

  test.skip('add existing collateral - xUSD lending contract - Failure expected', async () => {
    const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(101000n),
      note: 'Funding collateral addition',
    })

    await expect(
      xUSDLendingContractClient.send.addNewCollateralType({
        args: [cAlgoAssetId, mbrTxn],
        assetReferences: [cAlgoAssetId],
      }),
    ).rejects.toThrowError()
  })

  test('Add token price to oracle', async () => {
    const price = 1200000n // Example price for cALGO in xUSD
    await oracleAppClient.send.addTokenListing({
      args: [cAlgoAssetId, price],
      assetReferences: [cAlgoAssetId],
    })
    const tokenPrice = await oracleAppClient.send.getTokenPrice({
      args: [cAlgoAssetId],
      assetReferences: [cAlgoAssetId],
    })
    expect(tokenPrice).toBeDefined()
    const returnedPrice = tokenPrice.return?.price
    expect(returnedPrice).toBeDefined()
    expect(returnedPrice).toEqual(price)
  })

  test('Init depositor - xUSD Lending Contract', async () => {
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: depositorAccount.addr,
      assetId: xUSDAssetId,
      note: 'Opting in to xUSD asset',
    })

    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: depositorAccount.addr,
      assetId: xUSDAssetId,
      amount: 1000000n,
      note: 'Funding depositor with xUSD',
    })

    const userTokenBalance = await xUSDLendingContractClient.algorand.client.algod
      .accountAssetInformation(depositorAccount.addr, xUSDAssetId)
      .do()
    expect(userTokenBalance).toBeDefined()
    expect(userTokenBalance.assetHolding?.amount).toEqual(1000000n)
  })
})
