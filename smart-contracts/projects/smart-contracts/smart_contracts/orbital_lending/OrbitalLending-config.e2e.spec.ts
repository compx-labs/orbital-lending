/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { OrbitalLendingClient, OrbitalLendingFactory } from '../artifacts/orbital_lending/orbital-lendingClient'
import algosdk, { Account, Address } from 'algosdk'
import { exp, len } from '@algorandfoundation/algorand-typescript/op'
import { OracleClient, OracleFactory } from '../artifacts/Oracle/oracleClient'

let xUSDLendingContractClient: OrbitalLendingClient
let algoLendingContractClient: OrbitalLendingClient
let oracleAppClient: OracleClient
let managerAccount: Account

let xUSDAssetId = 0n
const INIT_CONTRACT_AMOUNT = 400000n
const ltv_bps = 2500n
const liq_threshold_bps = 1000000n
const liq_bonus_bps = 500n
const origination_fee_bps = 1000n
const protocol_interest_fee_bps = 1000n
const borrow_gate_enabled = 1n // 0 = false, 1 = true

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
        liq_bonus_bps,
        origination_fee_bps,
        protocol_interest_fee_bps,
        borrow_gate_enabled,
        oracleAppClient.appId,
        xUSDAssetId
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
        liq_bonus_bps,
        origination_fee_bps,
        protocol_interest_fee_bps,
        borrow_gate_enabled,
        oracleAppClient.appId,
        xUSDAssetId
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
        args: [
          mbrTxn,
          ltv_bps,
          liq_threshold_bps,
          liq_bonus_bps,
          origination_fee_bps,
          protocol_interest_fee_bps,
          borrow_gate_enabled,
          oracleAppClient.appId,
          xUSDAssetId,
        ],
        sender: outsider.addr,
      })
    ).rejects.toThrowError()
  })

  test('non-admin cannot call setRateParams', async () => {
    const outsider = await localnet.context.generateAccount({ initialFunds: microAlgo(1_000_000) })

    xUSDLendingContractClient.algorand.setSignerFromAccount(outsider)

    await expect(
      xUSDLendingContractClient.send.setRateParams({
        args: {
          baseBps: 50n,
          utilCapBps: 8000n,
          kinkNormBps: 5000n,
          slope1Bps: 1000n,
          slope2Bps: 2000n,
          maxAprBps: 6000n,
          borrowGateEnabled: 1n,
          emaAlphaBps: 0n,
          maxAprStepBps: 0n,
          rateModelType: 0n,
          powerGammaQ16: 0n,
          scarcityKBps: 0n,
          liqBonusBps: liq_bonus_bps,
        },
        sender: outsider.addr,
      })
    ).rejects.toThrowError()

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
  })

  test('setRateParams rejects invalid util cap', async () => {
    await expect(
      xUSDLendingContractClient.send.setRateParams({
        args: {
          baseBps: 50n,
          utilCapBps: 0n,
          kinkNormBps: 5000n,
          slope1Bps: 1000n,
          slope2Bps: 2000n,
          maxAprBps: 6000n,
          borrowGateEnabled: 1n,
          emaAlphaBps: 0n,
          maxAprStepBps: 0n,
          rateModelType: 0n,
          powerGammaQ16: 0n,
          scarcityKBps: 0n,
          liqBonusBps: liq_bonus_bps,
        },
      })
    ).rejects.toThrowError()
  })

  /* 
  public setRateParams(
      base_bps: uint64,
      util_cap_bps: uint64,
      kink_norm_bps: uint64,
      slope1_bps: uint64,
      slope2_bps: uint64,
      max_apr_bps: uint64,
      borrow_gate_enabled: uint64, // or uint8
      ema_alpha_bps: uint64,
      max_apr_step_bps: uint64,
      rate_model_type: uint64, // or uint8
      power_gamma_q16: uint64,
      scarcity_K_bps: uint64,
    )
   */
  test('Set Rate params on xUSD Lending', async () => {
    const previousNonce = (await xUSDLendingContractClient.state.global.getAll()).paramsUpdateNonce ?? 0n

    await xUSDLendingContractClient.send.setRateParams({
      /* args: [50n, 8000n, 5000n, 1000n, 2000n, 6000n, 1n, 0n, 0n, 0n, 0n, 0n], */
      args: {baseBps: 50n,
        utilCapBps: 8000n,
        kinkNormBps: 5000n,
        slope1Bps: 1000n,
        slope2Bps: 2000n,
        maxAprBps: 6000n,
        borrowGateEnabled: 1n, // or uint8
        emaAlphaBps: 0n,
        maxAprStepBps: 0n,
        rateModelType: 0n, // or uint8
        powerGammaQ16: 0n,
        scarcityKBps: 0n,
        liqBonusBps: 500n
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
    expect(globalState.borrowGateEnabled).toEqual(1n)
    expect(globalState.maxAprBps).toEqual(6000n)
    expect(globalState.emaAlphaBps).toEqual(0n)
    expect(globalState.maxAprStepBps).toEqual(0n)
    expect(globalState.rateModelType).toEqual(0n) // kinked
    expect(globalState.powerGammaQ16).toEqual(0n)
    expect(globalState.scarcityKBps).toEqual(0n)
    expect(globalState.paramsUpdateNonce).toEqual(previousNonce + 1n)
  })
})
