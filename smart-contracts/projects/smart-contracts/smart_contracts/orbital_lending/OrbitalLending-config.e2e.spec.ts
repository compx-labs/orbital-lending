/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { OrbitalLendingClient, OrbitalLendingFactory } from '../artifacts/orbital_lending/orbital-lendingClient'
import algosdk, { Account } from 'algosdk'
import { OracleClient, OracleFactory } from '../artifacts/Oracle/oracleClient'
import { deploy as deployAsa } from './orbital-deploy-asa'
import { deploy } from './orbital-deploy'
import { OrbitalLendingAsaClient } from '../artifacts/orbital_lending/orbital-lending-asaClient'

let xUSDLendingContractClient: OrbitalLendingAsaClient
let algoLendingContractClient: OrbitalLendingClient
let oracleAppClient: OracleClient
let managerAccount: Account

let xUSDAssetId = 0n
const INIT_CONTRACT_AMOUNT = 400000n
const MAX_FEE = 250_000n
const ltv_bps = 2500n
const liq_threshold_bps = 1000000n
const liq_bonus_bps = 500n
const origination_fee_bps = 1000n
const protocol_interest_fee_bps = 1000n
const additional_rewards_commission_percentage = 8n

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
        additionalRewardsCommissionPercentage: additional_rewards_commission_percentage,
        buyoutTokenId: xUSDAssetId,
        oracleAppId: oracleAppClient.appId,
        protocolShareBps: protocol_interest_fee_bps,
        fluxOracleAppId: 0n,
      },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    await xUSDLendingContractClient.send.generateLstToken({
      args: {},
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const globalState = await xUSDLendingContractClient.state.global.getAll()
    console.log('global state', globalState)
    expect(globalState).toBeDefined()
    expect(globalState.baseTokenId).toEqual(xUSDAssetId)

    const adminAddressContract = globalState.adminAccount
    console.log('admin address', adminAddressContract)
    console.log('manager address', algosdk.encodeAddress(managerAccount.addr.publicKey))
    expect(adminAddressContract).toEqual(algosdk.encodeAddress(managerAccount.addr.publicKey))

    expect(globalState.ltvBps).toEqual(ltv_bps)
    expect(globalState.liqThresholdBps).toEqual(liq_threshold_bps)
    expect(globalState.originationFeeBps).toEqual(origination_fee_bps)
    expect(globalState.protocolShareBps).toEqual(protocol_interest_fee_bps)
    expect(globalState.baseTokenId).toEqual(xUSDAssetId)
    expect(globalState.lstTokenId).toBeDefined()
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
        additionalRewardsCommissionPercentage: additional_rewards_commission_percentage,
        buyoutTokenId: xUSDAssetId,
        oracleAppId: oracleAppClient.appId,
        protocolShareBps: protocol_interest_fee_bps,
        fluxOracleAppId: 0n,
      },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
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
      args: { lstAssetId: lstId },
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgo(MAX_FEE),
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
    expect(globalState.originationFeeBps).toEqual(origination_fee_bps)
    expect(globalState.protocolShareBps).toEqual(protocol_interest_fee_bps)
    expect(globalState.lstTokenId).toEqual(lstId)
    expect(globalState.circulatingLst).toEqual(12000000n)
  })

  test('initApplication rejects non-admin caller', async () => {
    const outsider = await localnet.context.generateAccount({ initialFunds: microAlgo(2_000_000) })

    const factory = localnet.algorand.client.getTypedAppFactory(OrbitalLendingFactory, {
      defaultSender: managerAccount.addr,
    })

    const { appClient: tempClient } = await factory.send.create.createApplication({
      args: [managerAccount.addr.publicKey, 0n],
      sender: managerAccount.addr,
      accountReferences: [managerAccount.addr],
      assetReferences: [0n],
    })

    tempClient.algorand.setSignerFromAccount(managerAccount)
    const mbrTxn = tempClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: tempClient.appClient.appAddress,
      amount: microAlgo(INIT_CONTRACT_AMOUNT),
      note: 'Funding contract',
    })

    tempClient.algorand.setSignerFromAccount(outsider)

    await expect(
      tempClient.send.initApplication({
        args: {
          ltvBps: ltv_bps,
          liqThresholdBps: liq_threshold_bps,
          originationFeeBps: origination_fee_bps,
          additionalRewardsCommissionPercentage: 8n,
          buyoutTokenId: xUSDAssetId,
          oracleAppId: oracleAppClient.appId,
          protocolShareBps: protocol_interest_fee_bps,
          fluxOracleAppId: 0n,
        },
        sender: outsider.addr,
      }),
    ).rejects.toThrowError()
  })

  test('non-admin cannot call setRateParams', async () => {
    const outsider = await localnet.context.generateAccount({ initialFunds: microAlgo(1_000_000) })

    xUSDLendingContractClient.algorand.setSignerFromAccount(outsider)

    await expect(
      xUSDLendingContractClient.send.setRateParams({
        args: {
          liqThresholdBps: liq_threshold_bps,
          ltvBps: ltv_bps,
          baseBps: 50n,
          utilCapBps: 8000n,
          kinkNormBps: 5000n,
          slope1Bps: 1000n,
          slope2Bps: 2000n,
          maxAprBps: 6000n,
          rateModelType: 0n,
          liqBonusBps: liq_bonus_bps,
          emaAlphaBps: 200n,
        },
        sender: outsider.addr,
      }),
    ).rejects.toThrowError()

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
  })

  test('setRateParams rejects invalid util cap', async () => {
    await expect(
      xUSDLendingContractClient.send.setRateParams({
        args: {
          liqThresholdBps: liq_threshold_bps,
          ltvBps: ltv_bps,
          baseBps: 50n,
          utilCapBps: 0n,
          kinkNormBps: 5000n,
          slope1Bps: 1000n,
          slope2Bps: 2000n,
          maxAprBps: 6000n,
          rateModelType: 0n,
          liqBonusBps: liq_bonus_bps,
          emaAlphaBps: 200n,
        },
      }),
    ).rejects.toThrowError()
  })

  test('non-admin cannot set contract state', async () => {
    const outsider = await localnet.context.generateAccount({ initialFunds: microAlgo(1_000_000) })
    xUSDLendingContractClient.algorand.setSignerFromAccount(outsider)

    await expect(
      xUSDLendingContractClient.send.setContractState({
        args: { state: 1n },
        sender: outsider.addr,
      }),
    ).rejects.toThrowError()

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
  })

  test('non-admin cannot set migration admin', async () => {
    const outsider = await localnet.context.generateAccount({ initialFunds: microAlgo(1_000_000) })
    xUSDLendingContractClient.algorand.setSignerFromAccount(outsider)

    await expect(
      xUSDLendingContractClient.send.setMigrationAdmin({
        args: [outsider.addr.toString()],
        sender: outsider.addr,
      }),
    ).rejects.toThrowError()

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
  })

  test('non-admin cannot withdraw platform fees', async () => {
    const outsider = await localnet.context.generateAccount({ initialFunds: microAlgo(2_000_000) })

    xUSDLendingContractClient.algorand.setSignerFromAccount(outsider)

    await expect(
      xUSDLendingContractClient.send.withdrawPlatformFees({
        args: { paymentReceiver: outsider.addr.toString() },
        sender: outsider.addr,
        populateAppCallResources: true,
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
      }),
    ).rejects.toThrowError()

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
  })

  test('non-admin cannot add new collateral type', async () => {
    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    const { assetId: collateralAssetId } = await localnet.context.algorand.send.assetCreate({
      sender: managerAccount.addr,
      total: 1_000_000n,
      decimals: 6,
      defaultFrozen: false,
      unitName: 'nCOL',
      assetName: 'Non Admin Collateral',
      manager: managerAccount.addr,
      reserve: managerAccount.addr,
      clawback: managerAccount.addr,
      freeze: managerAccount.addr,
    })

    const outsider = await localnet.context.generateAccount({ initialFunds: microAlgo(2_000_000) })

    xUSDLendingContractClient.algorand.setSignerFromAccount(outsider)

    await expect(
      xUSDLendingContractClient.send.addNewCollateralType({
        args: {
          collateralBaseTokenId: 0n,
          collateralTokenId: collateralAssetId,
          originatingAppId: algoLendingContractClient.appId,
        },
        coverAppCallInnerTransactionFees: true,
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        sender: outsider.addr,
      }),
    ).rejects.toThrowError()

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
  })

  test('Set Rate params on xUSD Lending', async () => {
    await xUSDLendingContractClient.send.setRateParams({
      /* args: [50n, 8000n, 5000n, 1000n, 2000n, 6000n, 1n, 0n, 0n, 0n, 0n, 0n], */
      args: {
        liqThresholdBps: liq_threshold_bps,
        ltvBps: ltv_bps,
        baseBps: 50n,
        utilCapBps: 8000n,
        kinkNormBps: 5000n,
        slope1Bps: 1000n,
        slope2Bps: 2000n,
        maxAprBps: 6000n,
        rateModelType: 0n, // or uint8
        liqBonusBps: 500n,
        emaAlphaBps: 200n,
      },
    })

    const globalState = await xUSDLendingContractClient.state.global.getAll()
    console.log('xUSD global state', globalState)
    expect(globalState).toBeDefined()
    expect(globalState.baseBps).toEqual(50n)
    expect(globalState.utilCapBps).toEqual(8000n)
    expect(globalState.kinkNormBps).toEqual(5000n)
    expect(globalState.slope1Bps).toEqual(1000n)
    expect(globalState.slope2Bps).toEqual(2000n)
    expect(globalState.maxAprBps).toEqual(6000n)
  })

  test('Set Rate params on ALGO Lending', async () => {
    await algoLendingContractClient.send.setRateParams({
      args: {
        liqThresholdBps: liq_threshold_bps,
        ltvBps: ltv_bps,
        baseBps: 50n,
        utilCapBps: 8000n,
        kinkNormBps: 5000n,
        slope1Bps: 1000n,
        slope2Bps: 2000n,
        maxAprBps: 6000n,
        rateModelType: 0n, // or uint8
        liqBonusBps: 500n,
        emaAlphaBps: 200n,
      },
    })

    const globalState = await algoLendingContractClient.state.global.getAll()
    console.log('ALGO global state', globalState)
    expect(globalState).toBeDefined()
    expect(globalState.baseBps).toEqual(50n)
    expect(globalState.utilCapBps).toEqual(8000n)
    expect(globalState.kinkNormBps).toEqual(5000n)
    expect(globalState.slope1Bps).toEqual(1000n)
    expect(globalState.slope2Bps).toEqual(2000n)
  })

  test("set migration admin and verify it's set - algo lending", async () => {
    const newAdmin = await localnet.context.generateAccount({ initialFunds: microAlgo(2_000_000) })
    await algoLendingContractClient.send.setMigrationAdmin({
      args: [newAdmin.addr.toString()],
    })
    const globalState = await algoLendingContractClient.state.global.getAll()
    expect(globalState.migrationAdmin).toEqual(newAdmin.addr.toString())
  })

  test("set migration admin and verify it's set - xUSD lending", async () => {
    const newAdmin = await localnet.context.generateAccount({ initialFunds: microAlgo(2_000_000) })
    await xUSDLendingContractClient.send.setMigrationAdmin({
      args: [newAdmin.addr.toString()],
    })
    const globalState = await xUSDLendingContractClient.state.global.getAll()
    expect(globalState.migrationAdmin).toEqual(newAdmin.addr.toString())
  })
})
