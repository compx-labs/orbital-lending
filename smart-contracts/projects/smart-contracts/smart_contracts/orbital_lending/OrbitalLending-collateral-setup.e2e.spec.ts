/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { OrbitalLendingClient, OrbitalLendingFactory } from '../artifacts/orbital_lending/orbital-lendingClient'
import algosdk, { Account, Address } from 'algosdk'
import { exp, len } from '@algorandfoundation/algorand-typescript/op'
import { getCollateralBoxValue } from './testing-utils'
import { OracleClient, OracleFactory } from '../artifacts/Oracle/oracleClient'
import { deploy } from './orbital-deploy'
import { deploy as deployAsa } from './orbital-deploy-asa'
import { OrbitalLendingAsaClient } from '../artifacts/orbital_lending/orbital-lending-asaClient'
import { createToken } from './token-create'
let xUSDLendingContractClient: OrbitalLendingAsaClient
let algoLendingContractClient: OrbitalLendingClient
let oracleAppClient: OracleClient
let managerAccount: Account

let xUSDAssetId = 0n
let cxUSDAssetId = 0n
let cAlgoAssetId = 0n
const MAX_FEE = 250_000n
const INIT_CONTRACT_AMOUNT = 400000n
const ltv_bps = 2500n
const liq_threshold_bps = 1000000n
const liq_bonus_bps = 500n
const origination_fee_bps = 1000n
const protocol_interest_fee_bps = 1000n
const commission_percentage = 8n
const additional_rewards_commission_percentage = 8n

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

    xUSDLendingContractClient = await deployAsa(xUSDAssetId, managerAccount)
    const xUSDGlobalState = await xUSDLendingContractClient.state.global.getAll()
    console.log('xusd contract base asset id', xUSDGlobalState.baseTokenId)
    expect(xUSDGlobalState.baseTokenId).toEqual(xUSDAssetId)

    algoLendingContractClient = await deploy(0n, managerAccount)
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

    await xUSDLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(INIT_CONTRACT_AMOUNT),
      note: 'Funding contract',
    })
    await xUSDLendingContractClient.send.initApplication({
      args: {
        ltvBps: ltv_bps,
        liqThresholdBps: liq_threshold_bps,
        originationFeeBps: origination_fee_bps,
        protocolShareBps: protocol_interest_fee_bps,
        oracleAppId: oracleAppClient.appId,
        buyoutTokenId: xUSDAssetId,
        additionalRewardsCommissionPercentage: additional_rewards_commission_percentage,
        fluxOracleAppId: 0n,
      },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(102000n),
      note: 'Funding contract',
    })

    await xUSDLendingContractClient.send.generateLstToken({
      args: {},
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
    const globalState = await xUSDLendingContractClient.state.global.getAll()
    expect(globalState).toBeDefined()
    expect(globalState.baseTokenId).toEqual(xUSDAssetId)
    expect(globalState.ltvBps).toEqual(ltv_bps)
    expect(globalState.liqThresholdBps).toEqual(liq_threshold_bps)
    expect(globalState.originationFeeBps).toEqual(origination_fee_bps)
    expect(globalState.protocolShareBps).toEqual(protocol_interest_fee_bps)
    expect(globalState.baseTokenId).toEqual(xUSDAssetId)
    expect(globalState.lstTokenId).toBeDefined()
    cxUSDAssetId = globalState.lstTokenId ? 0n : 0n
  })

  test('orbital initialization - algo client', async () => {
    expect(algoLendingContractClient).toBeDefined()

    await algoLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(INIT_CONTRACT_AMOUNT),
      note: 'Funding contract',
    })
    await algoLendingContractClient.send.initApplication({
      args: {
        ltvBps: ltv_bps,
        liqThresholdBps: liq_threshold_bps,
        originationFeeBps: origination_fee_bps,
        protocolShareBps: protocol_interest_fee_bps,
        oracleAppId: oracleAppClient.appId,
        buyoutTokenId: xUSDAssetId,
        additionalRewardsCommissionPercentage: additional_rewards_commission_percentage,
        fluxOracleAppId: 0n,
      },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const lstId = await createToken(managerAccount, 'cALGO', 6)

    await algoLendingContractClient.send.optInToLst({
      args: { lstAssetId: lstId },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const axferTxn = algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: lstId,
      amount: 1_700_000_000_000n,
      note: 'sending lst',
      maxFee: microAlgo(MAX_FEE),
    })

    await algoLendingContractClient.send.configureLstToken({
      args: [axferTxn, 12000000n],
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const globalState = await algoLendingContractClient.state.global.getAll()
    expect(globalState).toBeDefined()
    expect(globalState.baseTokenId).toEqual(0n)

    expect(globalState.ltvBps).toEqual(ltv_bps)
    expect(globalState.liqThresholdBps).toEqual(liq_threshold_bps)
    expect(globalState.originationFeeBps).toEqual(origination_fee_bps)
    expect(globalState.protocolShareBps).toEqual(protocol_interest_fee_bps)
    expect(globalState.lstTokenId).toEqual(lstId)
    expect(globalState.circulatingLst).toEqual(12000000n)
    cAlgoAssetId = lstId
    console.log('cAlgoAssetId', cAlgoAssetId)
  })

  test('add new collateral - xUSD Lending Contract - cAlgo collateral', async () => {
    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await xUSDLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(101000n),
      note: 'Funding collateral addition',
    })

    const boxNames = await xUSDLendingContractClient.appClient.getBoxNames()
    console.log('Box names before:', boxNames)

    await xUSDLendingContractClient.send.addNewCollateralType({
      args: {
        collateralTokenId: cAlgoAssetId,
        collateralBaseTokenId: 0,
        originatingAppId: algoLendingContractClient.appId,
      },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const boxValue = await getCollateralBoxValue(
      cAlgoAssetId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appClient.appId,
    )
    expect(boxValue).toBeDefined()
    expect(boxValue.assetId).toEqual(cAlgoAssetId)
    expect(boxValue.baseAssetId).toEqual(0n)
    expect(boxValue.totalCollateral).toEqual(0n)
  })

  test('add existing collateral - xUSD lending contract - Failure expected', async () => {
    await xUSDLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(101000n),
      note: 'Funding collateral addition',
    })

    await expect(
      xUSDLendingContractClient.send.addNewCollateralType({
        args: {
          collateralTokenId: cAlgoAssetId,
          collateralBaseTokenId: 0,
          originatingAppId: algoLendingContractClient.appId,
        },
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: true,
      }),
    ).rejects.toThrowError()
  })

  test('addNewCollateralType rejects non-admin caller', async () => {
    const outsider = await localnet.context.generateAccount({ initialFunds: microAlgo(500_000) })
    localnet.algorand.setSignerFromAccount(outsider)

    const outsiderAssetResult = await localnet.context.algorand.send.assetCreate({
      sender: outsider.addr,
      total: 1_000_000_000n,
      decimals: 6,
      defaultFrozen: false,
      unitName: 'tCOLL',
      assetName: 'Test Collateral',
      manager: outsider.addr,
      reserve: outsider.addr,
      url: 'https://example.com',
    })
    const outsiderCollateralId = outsiderAssetResult.assetId

    xUSDLendingContractClient.algorand.setSignerFromAccount(outsider)

    await xUSDLendingContractClient.algorand.send.payment({
      sender: outsider.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(101000n),
      note: 'Outsider collateral addition',
    })

    await expect(
      xUSDLendingContractClient.send.addNewCollateralType({
        args: {
          collateralTokenId: outsiderCollateralId,
          collateralBaseTokenId: 0,
          originatingAppId: algoLendingContractClient.appId,
        },
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: true,
        sender: outsider.addr,
      }),
    ).rejects.toThrowError()
  })
})
