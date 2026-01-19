/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo, microAlgos, populateAppCallResources } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { OrbitalLendingClient } from '../artifacts/orbital_lending/orbital-lendingClient'
import { Account } from 'algosdk'
import {
  BASIS_POINTS,
  USD_MICRO_UNITS,
  calculateDisbursement,
  computeBuyoutTerms,
  computePartialLiquidationOutcome,
  getCollateralBoxValue,
  getLoanRecordBoxValue,
  liveDebtFromSnapshot,
} from './testing-utils'
import { OracleClient } from '../artifacts/Oracle/oracleClient'
import { deploy } from './orbital-deploy'
import { createToken } from './token-create'
import { deployOracle } from '../Oracle/oracle-deploy'
import { OrbitalLendingAsaClient } from '../artifacts/orbital_lending/orbital-lending-asaClient'
import { deploy as deployAsa } from './orbital-deploy-asa'
import { FluxGateClient } from '../fluxOracle/flux-gateClient'
import { deploy as deployFluxOracle } from '../fluxOracle/deploy'

let xUSDLendingContractClient: OrbitalLendingAsaClient
let algoLendingContractClient: OrbitalLendingClient
let fluxOracleAppClient: FluxGateClient

let oracleAppClient: OracleClient
let managerAccount: Account
let buyerAccount: Account
let liquidatorAccount: Account
const USER_TIER = 1n
let xUSDAssetId = 0n
let cAlgoAssetId = 0n
const INIT_CONTRACT_AMOUNT = 400000n
const MAX_FEE = 250_000n
const ltv_bps = 8500n
const liquidation_bonus_bps = 500n
const liq_threshold_bps = 9000n
const origination_fee_bps = 500n
const protocol_interest_fee_bps = 500n
const additional_rewards_commission_percentage = 8n

const NUM_DEPOSITORS = 1
const DEPOSITOR_XUSD_INITIAL_BALANCE = 500_000_000n
const DEPOSITOR_INITIAL_DEPOSIT_AMOUNT = 200_000_050n
const DEPOSITOR_INITIAL_WITHDRAW_AMOUNT = 50n
const DEPOSITOR_INITIAL_BORROW_AMOUNT = 10_000_000n
const DEPOSITOR_INITIAL_COLLATERAL_AMOUNT = 20_000_000n
const DEPOSITOR_SECONDARY_BORROW_AMOUNT = 5_000_000n

const ALGO_DEPOSIT_AMOUNT = 5_000_000_000n

const depositors: Account[] = []

describe('orbital-lending Testing - deposit / borrow', async () => {
  const localnet = algorandFixture()

  // -------------------------------------------------------------------------------------------------
  beforeAll(async () => {
    await localnet.newScope() // Ensure context is initialized before accessing it

    Config.configure({
      debug: true,
    })
    registerDebugEventHandlers()

    const { generateAccount } = localnet.context
    managerAccount = await generateAccount({ initialFunds: microAlgo(6_000_000_000) })
    xUSDAssetId = await createToken(managerAccount, 'xUSD', 6)

    xUSDLendingContractClient = await deployAsa(xUSDAssetId, managerAccount)
    algoLendingContractClient = await deploy(0n, managerAccount)
    oracleAppClient = await deployOracle(managerAccount)
    fluxOracleAppClient = await deployFluxOracle({ deployer: managerAccount })

    const fluxMbrTxn = await localnet.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: fluxOracleAppClient.appAddress,
      amount: microAlgo(400_000),
    })

    fluxOracleAppClient.algorand.setSignerFromAccount(managerAccount)

    await fluxOracleAppClient.send.initApplication({
      sender: managerAccount.addr,
      args: {
        mbrTxn: fluxMbrTxn,
      },
      populateAppCallResources: true,
    })

    await fluxOracleAppClient.send.addFluxTier({
      sender: managerAccount.addr,
      args: {
        minRequired: 0n,
        tierNumber: 0,
      },
      populateAppCallResources: true,
    })
    await fluxOracleAppClient.send.addFluxTier({
      sender: managerAccount.addr,
      args: {
        minRequired: 1000n,
        tierNumber: 1,
      },
      populateAppCallResources: true,
    })
    await fluxOracleAppClient.send.addFluxTier({
      sender: managerAccount.addr,
      args: {
        minRequired: 10000n,
        tierNumber: 2,
      },
      populateAppCallResources: true,
    })
    await fluxOracleAppClient.send.addFluxTier({
      sender: managerAccount.addr,
      args: {
        minRequired: 100000n,
        tierNumber: 3,
      },
      populateAppCallResources: true,
    })
    await fluxOracleAppClient.send.addFluxTier({
      sender: managerAccount.addr,
      args: {
        minRequired: 1000000n,
        tierNumber: 4,
      },
      populateAppCallResources: true,
    })
    await fluxOracleAppClient.send.setUserTier({
      sender: managerAccount.addr,
      args: {
        user: managerAccount.addr.toString(),
        tier: USER_TIER,
      },
      populateAppCallResources: true,
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
        additionalRewardsCommissionPercentage: additional_rewards_commission_percentage,
        buyoutTokenId: xUSDAssetId,
        fluxOracleAppId: fluxOracleAppClient.appId,
        liqThresholdBps: liq_threshold_bps,
        ltvBps: ltv_bps,
        oracleAppId: oracleAppClient.appId,
        originationFeeBps: origination_fee_bps,
        protocolShareBps: protocol_interest_fee_bps,
      },
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    await xUSDLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(102000n),
      note: 'Funding contract',
    })

    await xUSDLendingContractClient.send.setContractState({
      args: { state: 1n },
      sender: managerAccount.addr,
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
    expect(globalState.lstTokenId).not.toEqual(99n)
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
        additionalRewardsCommissionPercentage: 8n,
        buyoutTokenId: xUSDAssetId,
        fluxOracleAppId: fluxOracleAppClient.appId,
        liqThresholdBps: liq_threshold_bps,
        ltvBps: ltv_bps,
        oracleAppId: oracleAppClient.appId,
        originationFeeBps: origination_fee_bps,
        protocolShareBps: protocol_interest_fee_bps,
      },
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    const lstId = await createToken(managerAccount, 'cALGO', 6)

    await algoLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(2000n),
      note: 'Funding lst optin',
    })

    await algoLendingContractClient.send.optInToLst({
      args: { lstAssetId: lstId },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    await algoLendingContractClient.send.setContractState({
      args: { state: 1n },
      sender: managerAccount.addr,
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
        collateralBaseTokenId: 0n,
        originatingAppId: algoLendingContractClient.appId,
      },
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    const boxValue = await getCollateralBoxValue(
      cAlgoAssetId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )
    expect(boxValue).toBeDefined()
    expect(boxValue.assetId).toEqual(cAlgoAssetId)
    expect(boxValue.marketBaseAssetId).toEqual(xUSDAssetId)
    expect(boxValue.baseAssetId).toEqual(0n)
    expect(boxValue.totalCollateral).toEqual(0n)
  })

  test('Add algo price to oracle', async () => {
    const price = 215000n // Example price for algo
    const globalState = await algoLendingContractClient.state.global.getAll()
    await oracleAppClient.send.addTokenListing({
      args: { assetId: 0n, initialPrice: price },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
  })
  test('Add xusd price to oracle', async () => {
    const price = 1_000_000n // Example price for xusd
    const globalState = await algoLendingContractClient.state.global.getAll()
    await oracleAppClient.send.addTokenListing({
      args: { assetId: xUSDAssetId, initialPrice: price },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
  })

  test('Init depositors - xUSD Lending Contract', async () => {
    const { generateAccount } = localnet.context
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const depositorAccount = await generateAccount({ initialFunds: microAlgo(1_000_000) })
      xUSDLendingContractClient.algorand.setSignerFromAccount(depositorAccount)

      await xUSDLendingContractClient.algorand.send.assetOptIn({
        sender: depositorAccount.addr,
        assetId: xUSDAssetId,
        note: 'Opting in to xUSD asset',
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })

      await xUSDLendingContractClient.algorand.send.assetTransfer({
        sender: managerAccount.addr,
        receiver: depositorAccount.addr,
        assetId: xUSDAssetId,
        amount: DEPOSITOR_XUSD_INITIAL_BALANCE,
        note: 'Funding depositor with xUSD',
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })

      const userTokenBalance = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(depositorAccount.addr, xUSDAssetId)
        .do()
      expect(userTokenBalance).toBeDefined()
      expect(userTokenBalance.assetHolding?.amount).toEqual(DEPOSITOR_XUSD_INITIAL_BALANCE)

      depositors.push(depositorAccount)
    }
  })

  test('init buyer account', async () => {
    const { generateAccount } = localnet.context
    const b = await generateAccount({ initialFunds: microAlgo(1_000_000_000) })

    //Opt in to xUSd and fund
    localnet.algorand.setSignerFromAccount(b)
    await localnet.algorand.send.assetOptIn({
      sender: b.addr,
      assetId: xUSDAssetId,
      note: 'Opting in to xUSD asset',
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    await localnet.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: b.addr,
      assetId: xUSDAssetId,
      amount: 100_000_000_000n,
      note: 'Funding buyer with xUSD',
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    buyerAccount = b
  })

  test('Deposit xUSD - xUSD Lending Contract', async () => {
    const depositAmount = DEPOSITOR_INITIAL_DEPOSIT_AMOUNT
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const depositorAccount = depositors[i]
      xUSDLendingContractClient.algorand.setSignerFromAccount(depositorAccount)
      localnet.algorand.setSignerFromAccount(depositorAccount)
      const globalState = await xUSDLendingContractClient.state.global.getAll()
      const lstTokenId = globalState.lstTokenId
      expect(lstTokenId).toBeDefined()

      if (lstTokenId) {
        await xUSDLendingContractClient.algorand.send.assetOptIn({
          sender: depositorAccount.addr,
          assetId: lstTokenId,
          note: 'Opting in to cxUSD asset',
          maxFee: microAlgo(MAX_FEE),
          populateAppCallResources: true,
          coverAppCallInnerTransactionFees: true,
        })

        const depositTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
          sender: depositorAccount.addr,
          receiver: xUSDLendingContractClient.appClient.appAddress,
          assetId: xUSDAssetId,
          amount: depositAmount,
          note: 'Depositing xUSD',
          maxFee: microAlgo(MAX_FEE),
        })

        await xUSDLendingContractClient.send.depositAsa({
          args: { amount: depositAmount, assetTransferTxn: depositTxn },
          assetReferences: [xUSDAssetId],
          sender: depositorAccount.addr,
          maxFee: microAlgo(MAX_FEE),
          populateAppCallResources: true,
          coverAppCallInnerTransactionFees: true,
        })

        const userTokenBalance = await xUSDLendingContractClient.algorand.client.algod
          .accountAssetInformation(depositorAccount.addr, lstTokenId)
          .do()
        expect(userTokenBalance).toBeDefined()
        expect(userTokenBalance.assetHolding?.amount).toEqual(DEPOSITOR_INITIAL_DEPOSIT_AMOUNT)
      }
    }
  })

  test('init liquidator account', async () => {
    const { generateAccount } = localnet.context
    liquidatorAccount = await generateAccount({ initialFunds: microAlgo(2_500_000_000) })

    const globalState = await xUSDLendingContractClient.state.global.getAll()
    const lstTokenId = globalState.lstTokenId
    expect(lstTokenId).toBeDefined()

    if (lstTokenId) {
      localnet.algorand.setSignerFromAccount(liquidatorAccount)
      await localnet.algorand.send.assetOptIn({
        sender: liquidatorAccount.addr,
        assetId: lstTokenId,
        note: 'Opting in to cxUSD for liquidation rewards',
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })
    }
  })

  test('Withdraw deposited xUSD - xUSD Lending Contract', async () => {
    const withdrawAmount = DEPOSITOR_INITIAL_WITHDRAW_AMOUNT
    const algod = xUSDLendingContractClient.algorand.client.algod
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const depositorAccount = depositors[i]
      localnet.algorand.setSignerFromAccount(depositorAccount)
      //Ensure we use the asset from global state instead of global const
      const globalState = await xUSDLendingContractClient.state.global.getAll()
      const lstTokenId = globalState.lstTokenId
      expect(lstTokenId).toBeDefined()
      if (lstTokenId) {
        const lstTokenBalanceInfo = await algod.accountAssetInformation(depositorAccount.addr, lstTokenId).do()
        expect(lstTokenBalanceInfo).toBeDefined()
        expect(lstTokenBalanceInfo.assetHolding?.amount).toEqual(DEPOSITOR_INITIAL_DEPOSIT_AMOUNT)
        const lstTokenBalanceBeforeWithdraw = lstTokenBalanceInfo.assetHolding?.amount || 0n

        // Get xUSD asset balance prior to withdraw call
        const xUSDUserTokenInfo = await algod.accountAssetInformation(depositorAccount.addr, xUSDAssetId).do()
        expect(xUSDUserTokenInfo).toBeDefined()
        const xUSDUserBalanceBeforeWithdraw = xUSDUserTokenInfo.assetHolding?.amount || 0n

        const axferTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
          sender: depositorAccount.addr,
          receiver: xUSDLendingContractClient.appClient.appAddress,
          assetId: lstTokenId,
          amount: withdrawAmount,
          note: 'Returning cXUSD to contract',
          maxFee: microAlgo(MAX_FEE),
        })

        await xUSDLendingContractClient.send.withdrawDeposit({
          args: { amount: withdrawAmount, assetTransferTxn: axferTxn },
          assetReferences: [lstTokenId],
          appReferences: [xUSDLendingContractClient.appId],
          sender: depositorAccount.addr,
          maxFee: microAlgo(MAX_FEE),
          populateAppCallResources: true,
          coverAppCallInnerTransactionFees: true,
        })

        // Get xUSD asset balance prior to withdraw call
        const xUSDUserTokenInfoAfter = await algod.accountAssetInformation(depositorAccount.addr, xUSDAssetId).do()
        expect(xUSDUserTokenInfoAfter).toBeDefined()
        const xUSDUserBalanceAfterWithdraw = xUSDUserTokenInfoAfter.assetHolding?.amount || 0n

        expect(xUSDUserBalanceAfterWithdraw).toEqual(xUSDUserBalanceBeforeWithdraw + withdrawAmount)

        const lstTokenBalanceInfoAfter = await algod.accountAssetInformation(depositorAccount.addr, lstTokenId).do()
        expect(lstTokenBalanceInfoAfter).toBeDefined()
        expect(lstTokenBalanceInfoAfter.assetHolding?.amount).toEqual(lstTokenBalanceBeforeWithdraw - withdrawAmount)
      }
    }
  })

  test('manager deposit algo to contract - algo Lending Contract', async () => {
    const algod = algoLendingContractClient.algorand.client.algod
    let feeTracker = 0n

    //opt in to lst
    const globalaState = await algoLendingContractClient.state.global.getAll()
    const lstTokenId = globalaState.lstTokenId as bigint

    await algoLendingContractClient.algorand.send.assetOptIn({
      sender: managerAccount.addr,
      assetId: lstTokenId,
      note: 'Opting in to lst asset',
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    feeTracker += 1000n

    const { amount: algoBalanceBeforeDeposit } = await algod.accountInformation(managerAccount.addr).do()

    const depositTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(ALGO_DEPOSIT_AMOUNT),
      note: 'Depositing algo',
    })
    feeTracker += 1000n

    await algoLendingContractClient.send.depositAlgo({
      args: { amount: ALGO_DEPOSIT_AMOUNT, depositTxn },
      sender: managerAccount.addr,
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    feeTracker += 1000n

    //check managers algo balance after
    const { amount: algoBalanceAfterDeposit } = await algod.accountInformation(managerAccount.addr).do()
    expect(algoBalanceAfterDeposit).toEqual(algoBalanceBeforeDeposit - feeTracker - ALGO_DEPOSIT_AMOUNT)
  })

  test('confirm balances prior to borrowing - xUSD Lending Contract', async () => {
    const algod = xUSDLendingContractClient.algorand.client.algod
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const depositorAccount = depositors[i]
      localnet.algorand.setSignerFromAccount(depositorAccount)
      //Ensure we use the asset from global state instead of global const
      const globalState = await xUSDLendingContractClient.state.global.getAll()
      const lstTokenId = globalState.lstTokenId
      expect(lstTokenId).toBeDefined()
      expect(lstTokenId).toBeGreaterThan(0n)
      if (lstTokenId) {
        const lstTokenBalanceInfo = await algod.accountAssetInformation(depositorAccount.addr, lstTokenId).do()
        expect(lstTokenBalanceInfo).toBeDefined()
        expect(lstTokenBalanceInfo.assetHolding?.amount).toEqual(
          DEPOSITOR_INITIAL_DEPOSIT_AMOUNT - DEPOSITOR_INITIAL_WITHDRAW_AMOUNT,
        )

        const xUSDUserTokenInfo = await algod.accountAssetInformation(depositorAccount.addr, xUSDAssetId).do()
        expect(xUSDUserTokenInfo).toBeDefined()
        expect(xUSDUserTokenInfo.assetHolding?.amount).toEqual(
          DEPOSITOR_XUSD_INITIAL_BALANCE + DEPOSITOR_INITIAL_WITHDRAW_AMOUNT - DEPOSITOR_INITIAL_DEPOSIT_AMOUNT,
        )
      }
    }
  })

  test('Add collateral asset to algo contract', async () => {
    //  addNewCollateralType(collateralTokenId: UintN64, mbrTxn: gtxn.PaymentTxn): void {

    await algoLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(101000n),
      note: 'Funding collateral addition',
      maxFee: microAlgo(MAX_FEE),
    })

    const boxNames = await algoLendingContractClient.appClient.getBoxNames()
    console.log('Box names before:', boxNames)

    const globalState = await xUSDLendingContractClient.state.global.getAll()
    const lstTokenId = globalState.lstTokenId
    const baseTokenId = globalState.baseTokenId
    expect(lstTokenId).toBeGreaterThan(0n)
    expect(lstTokenId).toBeDefined()
    if (lstTokenId && baseTokenId) {
      await algoLendingContractClient.send.addNewCollateralType({
        args: {
          collateralTokenId: lstTokenId,
          collateralBaseTokenId: baseTokenId,
          originatingAppId: xUSDLendingContractClient.appId,
        },
        assetReferences: [lstTokenId],
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })

      const boxValue = await getCollateralBoxValue(
        lstTokenId,
        algoLendingContractClient,
        algoLendingContractClient.appId,
      )
      expect(boxValue).toBeDefined()
      expect(boxValue.assetId).toEqual(lstTokenId)
      console.log('Box assetId:', boxValue.assetId)
      expect(boxValue.marketBaseAssetId).toEqual(0n)
      expect(boxValue.baseAssetId).toEqual(baseTokenId)
      expect(boxValue.totalCollateral).toEqual(0n)
    }
  })

  test('Borrow Algo with cxUSD - algo Lending Contract', async () => {
    const borrowAmount = DEPOSITOR_INITIAL_BORROW_AMOUNT
    const collateralAmount = DEPOSITOR_INITIAL_COLLATERAL_AMOUNT
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const borrowerAccount = depositors[i]
      algoLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)
      let feeTracker = 0n

      const globalStateXUSDContract = await xUSDLendingContractClient.state.global.getAll()
      const cxusd: bigint = globalStateXUSDContract.lstTokenId as bigint
      console.log('cxusd', cxusd)
      const lstAppId = xUSDLendingContractClient.appId
      const { amount: algoBalanceBefore } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(borrowerAccount.addr)
        .do()

      expect(cxusd).toBeDefined()
      expect(cxusd).toBeGreaterThan(0n)

      const algoPrice = await oracleAppClient.send.getTokenPrice({
        args: [0n], // 0n for Algo
        assetReferences: [0n],
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })

      const xUSDPrice = await oracleAppClient.send.getTokenPrice({
        args: [xUSDAssetId],
        assetReferences: [xUSDAssetId],
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })

      console.log('Algo price:', algoPrice.return?.price)
      console.log('xUSD price:', xUSDPrice.return?.price)

      if (cxusd) {
        const boxValue = await getCollateralBoxValue(cxusd, algoLendingContractClient, algoLendingContractClient.appId)
        console.log('collateral box value cxusd', boxValue)
        expect(boxValue).toBeDefined()
        expect(boxValue.assetId).toEqual(cxusd)
        console.log('Box assetId:', boxValue.assetId)
        expect(boxValue.marketBaseAssetId).toEqual(0n)
        expect(boxValue.baseAssetId).toEqual(globalStateXUSDContract.baseTokenId)

        const axferTxn = algoLendingContractClient.algorand.createTransaction.assetTransfer({
          sender: borrowerAccount.addr,
          receiver: algoLendingContractClient.appClient.appAddress,
          assetId: cxusd,
          amount: collateralAmount,
          note: 'Depositing cxUSD collateral for borrowing',
          maxFee: microAlgo(MAX_FEE),
        })
        feeTracker += 1000n
        feeTracker += 5000n

        //log out params
        const xusdGlobalState = await xUSDLendingContractClient.state.global.getAll()
        const totalDeposits = xusdGlobalState.totalDeposits
        const circulatingcXUSD = xusdGlobalState.circulatingLst
        console.log('Total deposits:', totalDeposits)
        console.log('Circulating cXUSD:', circulatingcXUSD)

        const collateralPriceReturn = await algoLendingContractClient.send.calculateCollateralValueUsd({
          args: { collateralAmount: collateralAmount, collateralTokenId: cxusd },
          sender: borrowerAccount.addr,
          maxFee: microAlgo(MAX_FEE),
          populateAppCallResources: true,
          coverAppCallInnerTransactionFees: true,
        })
        const cxusdPrice =
          collateralPriceReturn?.returns && collateralPriceReturn.returns.length > 0
            ? (collateralPriceReturn.returns[0].returnValue as bigint)
            : 0

        console.log('collateralPriceReturn', collateralPriceReturn)
        console.log('cxUSD price:', cxusdPrice)
        console.log('Collateral amount:', collateralAmount)

        await algoLendingContractClient.send.borrow({
          args: {
            assetTransferTxn: axferTxn,
            requestedLoanAmount: borrowAmount,
            collateralAmount: collateralAmount,
            collateralTokenId: cxusd,
          },
          sender: borrowerAccount.addr,
          populateAppCallResources: true,
          maxFee: microAlgo(MAX_FEE),
          coverAppCallInnerTransactionFees: true,
        })
        feeTracker += 1000n

        // Confirm borrow was succesful
        //Check for algo increase in account
        await algoLendingContractClient.state.global.getAll()

        const { amount: algoBalanceAfter } = await algoLendingContractClient.algorand.client.algod
          .accountInformation(borrowerAccount.addr)
          .do()
        console.log('Borrower account balance before borrow:', algoBalanceBefore - feeTracker, 'microAlgos')
        console.log('Borrower account balance after borrow:', algoBalanceAfter, 'microAlgos')
        expect(algoBalanceAfter).toBeDefined()
        expect(algoBalanceAfter).toBeGreaterThan(algoBalanceBefore - feeTracker)
        const diff = algoBalanceAfter - algoBalanceBefore + feeTracker

        console.log(`Borrower account difference in Algo balance: ${diff} microAlgos`)

        //Confirm it is the correct amount
        const calculatedDisbursment = calculateDisbursement({
          collateralAmount,
          collateralPrice: cxusdPrice || 0n, //cxusd price
          ltvBps: ltv_bps,
          baseTokenPrice: algoPrice.return?.price || 0n, //algo price
          requestedLoanAmount: borrowAmount,
          originationFeeBps: origination_fee_bps,
        })
        console.log('Calculated disbursement:', calculatedDisbursment)

        const globalStateAfter = await algoLendingContractClient.state.global.getAll()
        const coount_loanRecords = globalStateAfter.activeLoanRecords
        console.log('Active loan records count:', coount_loanRecords)

        //check loan record box
        const loanRecordBoxValue = await getLoanRecordBoxValue(
          borrowerAccount.addr.toString(),
          algoLendingContractClient,
          algoLendingContractClient.appId,
        )

        console.log('Loan record box value:', loanRecordBoxValue)
        expect(loanRecordBoxValue).toBeDefined()
      }
    }
  })

  test('Partial liquidation transfers collateral on Algo market', async () => {
    const debtor = depositors[0]
    expect(liquidatorAccount).toBeDefined()

    const lstAppId = xUSDLendingContractClient.appId

    const loanBefore = await getLoanRecordBoxValue(
      debtor.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    expect(loanBefore.principal).toBeGreaterThan(0n)

    const collateralBox = await getCollateralBoxValue(
      loanBefore.collateralTokenId,
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )

    const algoGlobalState = await algoLendingContractClient.state.global.getAll()
    const xusdGlobalState = await xUSDLendingContractClient.state.global.getAll()
    const borrowIndexWadBefore = (algoGlobalState.borrowIndexWad ?? 0n) as bigint
    const userIndexWadBefore = loanBefore.userIndexWad ?? 0n
    const liveDebtBefore =
      userIndexWadBefore > 0n && borrowIndexWadBefore > 0n
        ? liveDebtFromSnapshot(loanBefore.principal, userIndexWadBefore, borrowIndexWadBefore)
        : loanBefore.principal
    expect(liveDebtBefore).toBeGreaterThan(0n)

    const algoPriceInfo = await oracleAppClient.send.getTokenPrice({
      args: [0n],
      assetReferences: [0n],
    })
    const algoPrice = algoPriceInfo.return?.price ?? 0n
    expect(algoPrice).toBeGreaterThan(0n)
    const debtUsd = (liveDebtBefore * algoPrice) / USD_MICRO_UNITS
    const circulatingLst = xusdGlobalState.circulatingLst ?? 1n
    const totalDeposits = xusdGlobalState.totalDeposits ?? 0n
    const underlyingCollateral = (loanBefore.collateralAmount * totalDeposits) / circulatingLst
    expect(underlyingCollateral).toBeGreaterThan(0n)
    const breakevenPrice = debtUsd > 0n ? (debtUsd * USD_MICRO_UNITS) / underlyingCollateral : 1n

    const computeLiquidationPrice = (repayAmount: bigint): bigint | undefined => {
      if (repayAmount <= 0n) return undefined
      const { collateralAmount } = loanBefore
      let candidatePrice = priceNeeded > breakevenPrice ? priceNeeded : breakevenPrice + 1n
      if (candidatePrice >= currentXusdPrice) {
        candidatePrice = currentXusdPrice - 1n > 0n ? currentXusdPrice - 1n : 1n
      }
      let priceMatch: bigint | undefined

      for (let i = 0; i < 500 && candidatePrice > 0n; i++) {
        const outcome = computePartialLiquidationOutcome({
          repayBaseAmount: repayAmount,
          liveDebt: liveDebtBefore,
          collateralLSTBalance: collateralAmount,
          totalDeposits,
          circulatingLst,
          basePrice: algoPrice,
          collateralUnderlyingPrice: candidatePrice,
          bonusBps,
        })

        if (outcome.repayUsed > 0n && !outcome.fullRepayRequired) {
          priceMatch = candidatePrice
          break
        }

        const step = candidatePrice / 40n
        candidatePrice -= step > 0n ? step : 1n
      }

      return priceMatch
    }

    let repayAttempt = (() => {
      const tenPercent = liveDebtBefore / 10n
      return tenPercent > 0n ? tenPercent : 1n
    })()
    expect(repayAttempt).toBeGreaterThan(0n)

    const liquidationThreshold = algoGlobalState.liqThresholdBps ?? 0n
    const thresholdCollateralUsd = (debtUsd * liquidationThreshold) / BASIS_POINTS
    expect(thresholdCollateralUsd).toBeGreaterThan(0n)

    const bonusBps = algoGlobalState.liqBonusBps ?? 0n

    const currentXusdPriceInfo = await oracleAppClient.send.getTokenPrice({
      args: [xUSDAssetId],
      assetReferences: [xUSDAssetId],
    })
    const currentXusdPrice = currentXusdPriceInfo.return?.price ?? 0n
    expect(currentXusdPrice).toBeGreaterThan(0n)

    const priceNeeded = (thresholdCollateralUsd * USD_MICRO_UNITS) / underlyingCollateral
    expect(priceNeeded).toBeGreaterThan(0n)
    expect(priceNeeded).toBeLessThan(currentXusdPrice)

    let liquidationPrice = computeLiquidationPrice(repayAttempt)

    if (!liquidationPrice) {
      // Try a smaller partial amount before giving up.
      const smallerRepay = liveDebtBefore / 20n
      repayAttempt = smallerRepay > 0n ? smallerRepay : 1n
      liquidationPrice = computeLiquidationPrice(repayAttempt)
    }

    expect(liquidationPrice).toBeDefined()
    const chosenLiquidationPrice = liquidationPrice ?? 1n
    expect(chosenLiquidationPrice).toBeGreaterThan(0n)
    expect(chosenLiquidationPrice).toBeLessThan(currentXusdPrice)

    const liquidationPreview = computePartialLiquidationOutcome({
      repayBaseAmount: repayAttempt,
      liveDebt: liveDebtBefore,
      collateralLSTBalance: loanBefore.collateralAmount,
      totalDeposits,
      circulatingLst,
      basePrice: algoPrice,
      collateralUnderlyingPrice: chosenLiquidationPrice,
      bonusBps,
    })
    expect(liquidationPreview.repayUsed).toBeGreaterThan(0n)
    expect(liquidationPreview.fullRepayRequired).toBe(false)

    // Debug: capture inputs used for the on-chain call (single-liquidator scenario).
    const debtUsdPreview = (liveDebtBefore * algoPrice) / USD_MICRO_UNITS
    const collatUsdPreview = (loanBefore.collateralAmount * chosenLiquidationPrice) / USD_MICRO_UNITS
    console.log(
      '[Single partial] debt:',
      liveDebtBefore.toString(),
      'repayAttempt:',
      repayAttempt.toString(),
      'debtUSD:',
      debtUsdPreview.toString(),
      'collatUSD:',
      collatUsdPreview.toString(),
      'bonusBps:',
      bonusBps.toString(),
    )

    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: { assetId: xUSDAssetId, newPrice: chosenLiquidationPrice },
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    try {
      algoLendingContractClient.algorand.setSignerFromAccount(liquidatorAccount)
      localnet.algorand.setSignerFromAccount(liquidatorAccount)

      const algod = algoLendingContractClient.algorand.client.algod
      const liquidatorAssetInfoBefore = await algod
        .accountAssetInformation(liquidatorAccount.addr, loanBefore.collateralTokenId)
        .do()
      const liquidatorCollateralBefore = BigInt(liquidatorAssetInfoBefore.assetHolding?.amount ?? 0)

      console.log('Attempting liquidation with repay amount:', repayAttempt)

      const repayTxn = algoLendingContractClient.algorand.createTransaction.payment({
        sender: liquidatorAccount.addr,
        receiver: algoLendingContractClient.appClient.appAddress,
        amount: microAlgos(repayAttempt),
        note: 'Repaying debt for liquidation',
        maxFee: microAlgo(MAX_FEE),
      })

      await algoLendingContractClient
        .newGroup()
        .gas({ sender: liquidatorAccount.addr, args: {}, maxFee: microAlgo(MAX_FEE) })
        .liquidatePartialAlgo({
          args: {
            debtor: debtor.addr.toString(),
            lstAppId,
            repayBaseAmount: repayAttempt,
            repayPay: repayTxn,
          },
          sender: liquidatorAccount.addr,
          maxFee: microAlgo(MAX_FEE),
        })
        .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

      const loanAfter = await getLoanRecordBoxValue(
        debtor.addr.toString(),
        algoLendingContractClient,
        algoLendingContractClient.appId,
      )
      const algoGlobalStateAfter = await algoLendingContractClient.state.global.getAll()
      const borrowIndexWadAfter = (algoGlobalStateAfter.borrowIndexWad ?? borrowIndexWadBefore) as bigint
      const liveDebtAfter =
        loanAfter.userIndexWad > 0n && borrowIndexWadAfter > 0n
          ? liveDebtFromSnapshot(loanAfter.principal, loanAfter.userIndexWad, borrowIndexWadAfter)
          : loanAfter.principal

      const actualRepaid = liveDebtBefore - liveDebtAfter
      expect(actualRepaid).toBeGreaterThan(0n)
      expect(actualRepaid).toBeLessThanOrEqual(repayAttempt)
      expect(loanAfter.collateralAmount).toBeLessThan(loanBefore.collateralAmount)

      const collateralDelta = loanBefore.collateralAmount - loanAfter.collateralAmount

      const liquidatorAssetInfoAfter = await algod
        .accountAssetInformation(liquidatorAccount.addr, loanBefore.collateralTokenId)
        .do()
      const liquidatorCollateralAfter = BigInt(liquidatorAssetInfoAfter.assetHolding?.amount ?? 0)

      expect(collateralDelta).toBeGreaterThan(0n)
      expect(liquidatorCollateralAfter - liquidatorCollateralBefore).toEqual(collateralDelta)
    } finally {
      oracleAppClient.algorand.setSignerFromAccount(managerAccount)
      await oracleAppClient.send.updateTokenPrice({
        args: { assetId: xUSDAssetId, newPrice: currentXusdPrice },
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })
    }
  })

  test('Multiple partial liquidations until a final full repay on Algo market', async () => {
    const debtor = depositors[0]
    const lstAppId = xUSDLendingContractClient.appId

    const initialLoan = await getLoanRecordBoxValue(
      debtor.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    expect(initialLoan.principal).toBeGreaterThan(0n)

    const algoGlobalState = await algoLendingContractClient.state.global.getAll()
    const xusdGlobalState = await xUSDLendingContractClient.state.global.getAll()
    const borrowIndexWadBefore = (algoGlobalState.borrowIndexWad ?? 0n) as bigint
    const userIndexWadBefore = initialLoan.userIndexWad ?? 0n
    const liveDebtBefore =
      userIndexWadBefore > 0n && borrowIndexWadBefore > 0n
        ? liveDebtFromSnapshot(initialLoan.principal, userIndexWadBefore, borrowIndexWadBefore)
        : initialLoan.principal
    expect(liveDebtBefore).toBeGreaterThan(0n)

    const algoPriceInfo = await oracleAppClient.send.getTokenPrice({
      args: [0n],
      assetReferences: [0n],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    const algoPrice = algoPriceInfo.return?.price ?? 0n
    expect(algoPrice).toBeGreaterThan(0n)

    const debtUsd = (liveDebtBefore * algoPrice) / USD_MICRO_UNITS
    const circulatingLst = xusdGlobalState.circulatingLst ?? 1n
    const totalDeposits = xusdGlobalState.totalDeposits ?? 0n
    const underlyingCollateral = (initialLoan.collateralAmount * totalDeposits) / circulatingLst
    const breakevenPrice = debtUsd > 0n ? (debtUsd * USD_MICRO_UNITS) / underlyingCollateral : 1n

    const liquidationThreshold = algoGlobalState.liqThresholdBps ?? 0n
    const thresholdCollateralUsd = (debtUsd * liquidationThreshold) / BASIS_POINTS

    const currentXusdPriceInfo = await oracleAppClient.send.getTokenPrice({
      args: [xUSDAssetId],
      assetReferences: [xUSDAssetId],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    const currentXusdPrice = currentXusdPriceInfo.return?.price ?? 0n

    const priceNeeded = (thresholdCollateralUsd * USD_MICRO_UNITS) / underlyingCollateral
    const chosenLiquidationPriceBase = priceNeeded > breakevenPrice ? priceNeeded : breakevenPrice + 1n
    // Add a small margin above breakeven to keep collateralUSD above debtUSD while staying at/near threshold.
    const chosenLiquidationPrice =
      chosenLiquidationPriceBase > 0n ? chosenLiquidationPriceBase + chosenLiquidationPriceBase / 100n : 1n

    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: { assetId: xUSDAssetId, newPrice: chosenLiquidationPrice },
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    // second liquidator
    const { generateAccount } = localnet.context
    const secondLiquidator = await generateAccount({ initialFunds: microAlgo(100_000_000) })

    for (const liq of [liquidatorAccount, secondLiquidator]) {
      algoLendingContractClient.algorand.setSignerFromAccount(liq)
      localnet.algorand.setSignerFromAccount(liq)
      await algoLendingContractClient.algorand.send.assetOptIn({
        sender: liq.addr,
        assetId: initialLoan.collateralTokenId,
        note: 'Opting liquidator into collateral',
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })
    }

    // First partial (~5% of debt) by liquidatorAccount
    const firstRepay = liveDebtBefore / 20n > 0n ? liveDebtBefore / 20n : 1n
    const firstDebtUsd = (liveDebtBefore * algoPrice) / USD_MICRO_UNITS
    const firstCollatUsd = (initialLoan.collateralAmount * chosenLiquidationPrice) / USD_MICRO_UNITS
    console.log(
      '[First partial] liveDebtBefore:',
      liveDebtBefore.toString(),
      'repay:',
      firstRepay.toString(),
      'debtUSD:',
      firstDebtUsd.toString(),
      'collatUSD:',
      firstCollatUsd.toString(),
    )
    const firstTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: liquidatorAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(firstRepay),
      note: 'First partial repay',
    })
    await algoLendingContractClient
      .newGroup()
      .gas({ sender: liquidatorAccount.addr, args: {}, maxFee: microAlgo(MAX_FEE) })
      .liquidatePartialAlgo({
        args: { debtor: debtor.addr.toString(), lstAppId, repayBaseAmount: firstRepay, repayPay: firstTxn },
        sender: liquidatorAccount.addr,
        maxFee: microAlgo(MAX_FEE),
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    const loanAfterFirst = await getLoanRecordBoxValue(
      debtor.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    const algoGlobalStateAfterFirst = await algoLendingContractClient.state.global.getAll()
    const borrowIndexWadAfterFirst = (algoGlobalStateAfterFirst.borrowIndexWad ?? borrowIndexWadBefore) as bigint
    const liveDebtAfterFirst =
      loanAfterFirst.userIndexWad > 0n && borrowIndexWadAfterFirst > 0n
        ? liveDebtFromSnapshot(loanAfterFirst.principal, loanAfterFirst.userIndexWad, borrowIndexWadAfterFirst)
        : loanAfterFirst.principal

    // Recompute price for second partial to preserve headroom
    const liveDebtUsdAfterFirst = (liveDebtAfterFirst * algoPrice) / USD_MICRO_UNITS
    const underlyingAfterFirst = (loanAfterFirst.collateralAmount * totalDeposits) / circulatingLst
    const breakevenPrice2 =
      liveDebtUsdAfterFirst > 0n ? (liveDebtUsdAfterFirst * USD_MICRO_UNITS) / underlyingAfterFirst : 1n
    const thresholdCollateralUsd2 = (liveDebtUsdAfterFirst * (algoGlobalState.liqThresholdBps ?? 0n)) / BASIS_POINTS
    const priceNeeded2 =
      underlyingAfterFirst > 0n ? (thresholdCollateralUsd2 * USD_MICRO_UNITS) / underlyingAfterFirst : 1n
    const chosenLiquidationPrice2Base = priceNeeded2 > breakevenPrice2 ? priceNeeded2 : breakevenPrice2 + 1n
    const chosenLiquidationPrice2 =
      chosenLiquidationPrice2Base > 0n ? chosenLiquidationPrice2Base + chosenLiquidationPrice2Base / 100n : 1n
    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: { assetId: xUSDAssetId, newPrice: chosenLiquidationPrice2 },
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    // Second partial (~10% of remaining) by secondLiquidator
    const secondRepay = liveDebtAfterFirst / 10n > 0n ? liveDebtAfterFirst / 10n : 1n
    const secondDebtUsd = (liveDebtAfterFirst * algoPrice) / USD_MICRO_UNITS
    const secondCollatUsd = (loanAfterFirst.collateralAmount * chosenLiquidationPrice2) / USD_MICRO_UNITS
    console.log(
      '[Second partial] liveDebtAfterFirst:',
      liveDebtAfterFirst.toString(),
      'repay:',
      secondRepay.toString(),
      'debtUSD:',
      secondDebtUsd.toString(),
      'collatUSD:',
      secondCollatUsd.toString(),
    )
    const secondTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: secondLiquidator.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(secondRepay),
      note: 'Second partial repay',
      maxFee: microAlgo(MAX_FEE),
    })
    await algoLendingContractClient
      .newGroup()
      .gas({ sender: secondLiquidator.addr, args: {}, maxFee: microAlgo(MAX_FEE) })
      .liquidatePartialAlgo({
        args: { debtor: debtor.addr.toString(), lstAppId, repayBaseAmount: secondRepay, repayPay: secondTxn },
        sender: secondLiquidator.addr,
        maxFee: microAlgo(MAX_FEE),
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    const loanAfterSecond = await getLoanRecordBoxValue(
      debtor.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    const algoGlobalStateAfterSecond = await algoLendingContractClient.state.global.getAll()
    const borrowIndexWadAfterSecond = (algoGlobalStateAfterSecond.borrowIndexWad ?? borrowIndexWadAfterFirst) as bigint
    const liveDebtAfterSecond =
      loanAfterSecond.userIndexWad > 0n && borrowIndexWadAfterSecond > 0n
        ? liveDebtFromSnapshot(loanAfterSecond.principal, loanAfterSecond.userIndexWad, borrowIndexWadAfterSecond)
        : loanAfterSecond.principal
    expect(liveDebtAfterSecond).toBeGreaterThan(0n)

    // Final full repay by secondLiquidator
    const finalRepay = liveDebtAfterSecond
    const finalDebtUsd = (liveDebtAfterSecond * algoPrice) / USD_MICRO_UNITS
    const finalCollatUsd = (loanAfterSecond.collateralAmount * chosenLiquidationPrice) / USD_MICRO_UNITS
    console.log(
      '[Final repay] liveDebtAfterSecond:',
      liveDebtAfterSecond.toString(),
      'repay:',
      finalRepay.toString(),
      'debtUSD:',
      finalDebtUsd.toString(),
      'collatUSD:',
      finalCollatUsd.toString(),
    )
    const finalTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: secondLiquidator.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(finalRepay),
      note: 'Final full repay',
      maxFee: microAlgo(MAX_FEE),
    })
    await algoLendingContractClient
      .newGroup()
      .gas({ sender: secondLiquidator.addr, args: {}, maxFee: microAlgo(MAX_FEE) })
      .liquidatePartialAlgo({
        args: { debtor: debtor.addr.toString(), lstAppId, repayBaseAmount: finalRepay, repayPay: finalTxn },
        sender: secondLiquidator.addr,
        maxFee: microAlgo(MAX_FEE),
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    await expect(
      getLoanRecordBoxValue(debtor.addr.toString(), algoLendingContractClient, algoLendingContractClient.appId),
    ).rejects.toThrowError()
  })

  test('Fresh loan: multiple partials then final full repay on Algo market', async () => {
    const { generateAccount } = localnet.context
    const borrower = await generateAccount({ initialFunds: microAlgo(100_000_000) })
    const liquidator1 = await generateAccount({ initialFunds: microAlgo(100_000_000) })
    const liquidator2 = await generateAccount({ initialFunds: microAlgo(100_000_000) })

    const lstAppId = xUSDLendingContractClient.appId
    const globalStateXUSDContract = await xUSDLendingContractClient.state.global.getAll()
    const cxusd: bigint = globalStateXUSDContract.lstTokenId as bigint
    expect(cxusd).toBeGreaterThan(0n)

    // Borwer deposit to xUSD lending contract and receives cxUSD in return after they opt in
    for (const acc of [borrower, liquidator1, liquidator2]) {
      xUSDLendingContractClient.algorand.setSignerFromAccount(acc)
      await xUSDLendingContractClient.algorand.send.assetOptIn({
        sender: acc.addr,
        assetId: cxusd,
        note: 'Opting liquidator into collateral',
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })
      await xUSDLendingContractClient.algorand.send.assetOptIn({
        sender: acc.addr,
        assetId: xUSDAssetId,
        note: 'Opting liquidator into collateral',
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })
    }
    // transfer xUSD from manager/admin to borrower account.
    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    const xUSDTransferAmount = 50_000_000n // 50 xUSD
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: borrower.addr,
      assetId: xUSDAssetId,
      amount: xUSDTransferAmount,
      note: 'Transferring xUSD to borrower for collateral deposit',
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    const depositAmount = 40_000_000n // 40 xUSD

    const assetTransferTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: borrower.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: depositAmount,
      note: 'Depositing xUSD to receive cxUSD',
      maxFee: microAlgo(MAX_FEE),
    })

    await xUSDLendingContractClient.send.depositAsa({
      args: { amount: depositAmount, assetTransferTxn },
      sender: borrower.addr,
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    //verify cxusd balance
    const borrowerCxusdInfo = await algoLendingContractClient.algorand.client.algod
      .accountAssetInformation(borrower.addr, cxusd)
      .do()
    const borrowerCxusdBalance = BigInt(borrowerCxusdInfo.assetHolding?.amount ?? 0)
    console.log('Borrower cxUSD balance after deposit:', borrowerCxusdBalance.toString())
    expect(borrowerCxusdBalance).toBeGreaterThan(0n)

    // Set oracle prices: ALGO $1.00, xUSD $1.20 (healthy), then drop to $0.80 for liquidation.
    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: { assetId: 0n, newPrice: 1_000_000n },
      assetReferences: [0n],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    await oracleAppClient.send.updateTokenPrice({
      args: { assetId: xUSDAssetId, newPrice: 1_200_000n },
      assetReferences: [xUSDAssetId],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    // Borrower deposits collateral and borrows ALGO
    algoLendingContractClient.algorand.setSignerFromAccount(borrower)
    const collateralAmount = 20_000_000n
    const borrowAmount = 10_000_000n
    const axferTxn = algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: borrower.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: cxusd,
      amount: collateralAmount,
      note: 'Depositing cxUSD collateral for borrowing',
      maxFee: microAlgo(MAX_FEE),
    })
    await algoLendingContractClient.send.borrow({
      args: {
        assetTransferTxn: axferTxn,
        requestedLoanAmount: borrowAmount,
        collateralAmount,
        collateralTokenId: cxusd,
      },
      sender: borrower.addr,
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgo(MAX_FEE),
    })

    // Reset oracle price: ALGO $1.00. We'll compute the xUSD liquidation price below.
    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: [0n, 1_000_000n],
      assetReferences: [0n],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    const loanBefore = await getLoanRecordBoxValue(
      borrower.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    const algoGlobalState = await algoLendingContractClient.state.global.getAll()
    const borrowIndexWadBefore = (algoGlobalState.borrowIndexWad ?? 0n) as bigint
    const liveDebtBefore =
      loanBefore.userIndexWad > 0n && borrowIndexWadBefore > 0n
        ? liveDebtFromSnapshot(loanBefore.principal, loanBefore.userIndexWad, borrowIndexWadBefore)
        : loanBefore.principal
    const algoPriceReturn = await oracleAppClient.send.getTokenPrice({
      args: [0n],
      assetReferences: [0n],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    const algoPrice = algoPriceReturn.return?.price ?? 1_000_000n
    const debtUSDv = (liveDebtBefore * algoPrice) / USD_MICRO_UNITS
    const xusdGlobalState = await xUSDLendingContractClient.state.global.getAll()
    const circulatingLst = xusdGlobalState.circulatingLst ?? 1n
    const totalDeposits = xusdGlobalState.totalDeposits ?? 0n
    const underlyingCollateral = (loanBefore.collateralAmount * totalDeposits) / circulatingLst
    const liqThresholdBps = algoGlobalState.liqThresholdBps ?? 0n
    const thresholdCollateralUsd = liqThresholdBps > 0n ? (debtUSDv * BASIS_POINTS) / liqThresholdBps : debtUSDv
    const breakevenPrice = debtUSDv > 0n ? (debtUSDv * USD_MICRO_UNITS) / underlyingCollateral : 1n
    const thresholdPrice =
      underlyingCollateral > 0n ? (thresholdCollateralUsd * USD_MICRO_UNITS) / underlyingCollateral : 1n
    const liquidationPrice = thresholdPrice > breakevenPrice ? thresholdPrice : breakevenPrice + 1n

    await oracleAppClient.send.updateTokenPrice({
      args: [xUSDAssetId, liquidationPrice],
      assetReferences: [xUSDAssetId],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    const xusdPriceReturn = await oracleAppClient.send.getTokenPrice({
      args: [xUSDAssetId],
      assetReferences: [xUSDAssetId],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    const xusdPrice = xusdPriceReturn.return?.price ?? liquidationPrice
    const collateralUSD = (loanBefore.collateralAmount * xusdPrice) / USD_MICRO_UNITS
    const ltvBps = collateralUSD === 0n ? 0n : (debtUSDv * BASIS_POINTS) / collateralUSD
    console.log(
      '[Fresh loan pre-liquidation]',
      'algoPriceµUSD:',
      algoPrice.toString(),
      'xusdPriceµUSD:',
      xusdPrice.toString(),
      'collatUSD:',
      collateralUSD.toString(),
      'debtUSD:',
      debtUSDv.toString(),
      'LTVbps:',
      ltvBps.toString(),
      'thresholdbps:',
      (algoGlobalState.liqThresholdBps ?? 0n).toString(),
    )

    // First partial by liquidator1 (25% of debt)
    const firstRepay = liveDebtBefore / 4n > 0n ? liveDebtBefore / 4n : 1n
    const firstTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: liquidator1.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(firstRepay),
      note: 'First partial repay',
      maxFee: microAlgo(MAX_FEE),
    })
    algoLendingContractClient.algorand.setSignerFromAccount(liquidator1)
    await algoLendingContractClient
      .newGroup()
      .gas({ sender: liquidator1.addr, args: {}, maxFee: microAlgo(MAX_FEE) })
      .liquidatePartialAlgo({
        args: { debtor: borrower.addr.toString(), lstAppId, repayBaseAmount: firstRepay, repayPay: firstTxn },
        sender: liquidator1.addr,
        maxFee: microAlgo(MAX_FEE),
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    const loanAfterFirst = await getLoanRecordBoxValue(
      borrower.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    const algoGlobalStateAfterFirst = await algoLendingContractClient.state.global.getAll()
    const borrowIndexWadAfterFirst = (algoGlobalStateAfterFirst.borrowIndexWad ?? borrowIndexWadBefore) as bigint
    const liveDebtAfterFirst =
      loanAfterFirst.userIndexWad > 0n && borrowIndexWadAfterFirst > 0n
        ? liveDebtFromSnapshot(loanAfterFirst.principal, loanAfterFirst.userIndexWad, borrowIndexWadAfterFirst)
        : loanAfterFirst.principal

    // Recompute liquidation price after first partial so the next liquidation stays eligible.
    const liveDebtUsdAfterFirst = (liveDebtAfterFirst * algoPrice) / USD_MICRO_UNITS
    const underlyingAfterFirst = (loanAfterFirst.collateralAmount * totalDeposits) / circulatingLst
    const thresholdCollateralUsdAfterFirst =
      liqThresholdBps > 0n ? (liveDebtUsdAfterFirst * BASIS_POINTS) / liqThresholdBps : liveDebtUsdAfterFirst
    const breakevenPriceAfterFirst =
      liveDebtUsdAfterFirst > 0n ? (liveDebtUsdAfterFirst * USD_MICRO_UNITS) / underlyingAfterFirst : 1n
    const thresholdPriceAfterFirst =
      underlyingAfterFirst > 0n
        ? (thresholdCollateralUsdAfterFirst * USD_MICRO_UNITS) / underlyingAfterFirst
        : 1n
    const liquidationPriceAfterFirst =
      thresholdPriceAfterFirst > breakevenPriceAfterFirst ? thresholdPriceAfterFirst : breakevenPriceAfterFirst + 1n

    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: [xUSDAssetId, liquidationPriceAfterFirst],
      assetReferences: [xUSDAssetId],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    // Second partial by liquidator2 (50% of remaining debt)
    const secondRepay = liveDebtAfterFirst / 2n > 0n ? liveDebtAfterFirst / 2n : 1n
    const secondTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: liquidator2.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(secondRepay),
      note: 'Second partial repay',
      maxFee: microAlgo(MAX_FEE),
    })
    algoLendingContractClient.algorand.setSignerFromAccount(liquidator2)
    await algoLendingContractClient
      .newGroup()
      .gas({ sender: liquidator2.addr, args: {}, maxFee: microAlgo(MAX_FEE) })
      .liquidatePartialAlgo({
        args: { debtor: borrower.addr.toString(), lstAppId, repayBaseAmount: secondRepay, repayPay: secondTxn },
        sender: liquidator2.addr,
        maxFee: microAlgo(MAX_FEE),
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    const loanAfterSecond = await getLoanRecordBoxValue(
      borrower.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    const algoGlobalStateAfterSecond = await algoLendingContractClient.state.global.getAll()
    const borrowIndexWadAfterSecond = (algoGlobalStateAfterSecond.borrowIndexWad ?? borrowIndexWadAfterFirst) as bigint
    const liveDebtAfterSecond =
      loanAfterSecond.userIndexWad > 0n && borrowIndexWadAfterSecond > 0n
        ? liveDebtFromSnapshot(loanAfterSecond.principal, loanAfterSecond.userIndexWad, borrowIndexWadAfterSecond)
        : loanAfterSecond.principal
    expect(liveDebtAfterSecond).toBeGreaterThan(0n)

    // Recompute liquidation price after second partial so the final repay stays eligible.
    const liveDebtUsdAfterSecond = (liveDebtAfterSecond * algoPrice) / USD_MICRO_UNITS
    const underlyingAfterSecond = (loanAfterSecond.collateralAmount * totalDeposits) / circulatingLst
    const thresholdCollateralUsdAfterSecond =
      liqThresholdBps > 0n ? (liveDebtUsdAfterSecond * BASIS_POINTS) / liqThresholdBps : liveDebtUsdAfterSecond
    const breakevenPriceAfterSecond =
      liveDebtUsdAfterSecond > 0n ? (liveDebtUsdAfterSecond * USD_MICRO_UNITS) / underlyingAfterSecond : 1n
    const thresholdPriceAfterSecond =
      underlyingAfterSecond > 0n
        ? (thresholdCollateralUsdAfterSecond * USD_MICRO_UNITS) / underlyingAfterSecond
        : 1n
    const liquidationPriceAfterSecond =
      thresholdPriceAfterSecond > breakevenPriceAfterSecond ? thresholdPriceAfterSecond : breakevenPriceAfterSecond + 1n

    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: [xUSDAssetId, liquidationPriceAfterSecond],
      assetReferences: [xUSDAssetId],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    // Final full repay by liquidator2
    const finalTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: liquidator2.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(liveDebtAfterSecond),
      note: 'Final full repay',
      maxFee: microAlgo(MAX_FEE),
    })
    await algoLendingContractClient
      .newGroup()
      .gas({ sender: liquidator2.addr, args: {}, maxFee: microAlgo(MAX_FEE) })
      .liquidatePartialAlgo({
        args: { debtor: borrower.addr.toString(), lstAppId, repayBaseAmount: liveDebtAfterSecond, repayPay: finalTxn },
        sender: liquidator2.addr,
        maxFee: microAlgo(MAX_FEE),
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    await expect(
      getLoanRecordBoxValue(borrower.addr.toString(), algoLendingContractClient, algoLendingContractClient.appId),
    ).rejects.toThrowError()

    // Reset oracle price for other tests
    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: { assetId: xUSDAssetId, newPrice: 1_200_000n },
      assetReferences: [xUSDAssetId],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
  })

  test('partial liquidation requires full repayment when remaining collateral cannot support bonus cushion', async () => {
    const { generateAccount } = localnet.context
    const debtor = await generateAccount({ initialFunds: microAlgo(50_000_000) })
    const lstAppId = xUSDLendingContractClient.appId

    const xusdGlobalStateBefore = await xUSDLendingContractClient.state.global.getAll()
    const cxusd: bigint = xusdGlobalStateBefore.lstTokenId as bigint
    expect(cxusd).toBeGreaterThan(0n)

    for (const acc of [debtor, liquidatorAccount]) {
      xUSDLendingContractClient.algorand.setSignerFromAccount(acc)
      await xUSDLendingContractClient.algorand.send.assetOptIn({
        sender: acc.addr,
        assetId: cxusd,
        note: 'Opting in to collateral',
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })
      await xUSDLendingContractClient.algorand.send.assetOptIn({
        sender: acc.addr,
        assetId: xUSDAssetId,
        note: 'Opting in to xUSD',
        maxFee: microAlgo(MAX_FEE),
        populateAppCallResources: true,
        coverAppCallInnerTransactionFees: true,
      })
    }

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: debtor.addr,
      assetId: xUSDAssetId,
      amount: 25_000_000n,
      note: 'Funding debtor with xUSD',
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    xUSDLendingContractClient.algorand.setSignerFromAccount(debtor)
    const depositAmount = 20_000_000n
    const depositTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: debtor.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: depositAmount,
      note: 'Depositing xUSD to mint cxUSD',
      maxFee: microAlgo(MAX_FEE),
    })
    await xUSDLendingContractClient.send.depositAsa({
      args: { amount: depositAmount, assetTransferTxn: depositTxn },
      sender: debtor.addr,
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: { assetId: 0n, newPrice: 1_000_000n },
      assetReferences: [0n],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    await oracleAppClient.send.updateTokenPrice({
      args: { assetId: xUSDAssetId, newPrice: 1_200_000n },
      assetReferences: [xUSDAssetId],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    algoLendingContractClient.algorand.setSignerFromAccount(debtor)
    const collateralAmount = 10_000_000n
    const borrowAmount = 5_000_000n
    const axferTxn = algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: debtor.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: cxusd,
      amount: collateralAmount,
      note: 'Depositing cxUSD collateral for borrowing',
      maxFee: microAlgo(MAX_FEE),
    })
    await algoLendingContractClient.send.borrow({
      args: {
        assetTransferTxn: axferTxn,
        requestedLoanAmount: borrowAmount,
        collateralAmount,
        collateralTokenId: cxusd,
      },
      sender: debtor.addr,
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgo(MAX_FEE),
    })

    const loanBefore = await getLoanRecordBoxValue(
      debtor.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    expect(loanBefore).toBeDefined()

    const collateralBox = await getCollateralBoxValue(
      loanBefore.collateralTokenId,
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )

    const algoGlobalState = await algoLendingContractClient.state.global.getAll()
    const xusdGlobalState = await xUSDLendingContractClient.state.global.getAll()
    const borrowIndexWadBefore = (algoGlobalState.borrowIndexWad ?? 0n) as bigint
    const activeLoanRecordsBefore = (algoGlobalState.activeLoanRecords ?? 0n) as bigint
    const userIndexWadBefore = loanBefore.userIndexWad ?? 0n
    const liveDebtBefore =
      userIndexWadBefore > 0n && borrowIndexWadBefore > 0n
        ? liveDebtFromSnapshot(loanBefore.principal, userIndexWadBefore, borrowIndexWadBefore)
        : loanBefore.principal
    expect(liveDebtBefore).toBeGreaterThan(0n)

    const repayAttempt = liveDebtBefore / 2n
    expect(repayAttempt).toBeGreaterThan(0n)

    const algoPriceInfo = await oracleAppClient.send.getTokenPrice({
      args: [0n],
      assetReferences: [0n],
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })
    const algoPrice = algoPriceInfo.return?.price ?? 0n
    expect(algoPrice).toBeGreaterThan(0n)

    const xusdGlobalState2 = await xUSDLendingContractClient.state.global.getAll()
    const totalDeposits = xusdGlobalState2.totalDeposits ?? 0n
    const circulatingLst = xusdGlobalState2.circulatingLst ?? 1n
    const underlyingCollateral = (loanBefore.collateralAmount * totalDeposits) / circulatingLst
    const debtUSDv = (liveDebtBefore * algoPrice) / USD_MICRO_UNITS
    const breakevenPrice = debtUSDv > 0n ? (debtUSDv * USD_MICRO_UNITS) / underlyingCollateral : 1n
    const depressedPrice = breakevenPrice > 1n ? breakevenPrice - 1n : 1n

    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: { assetId: xUSDAssetId, newPrice: depressedPrice },
      maxFee: microAlgo(MAX_FEE),
      populateAppCallResources: true,
      coverAppCallInnerTransactionFees: true,
    })

    algoLendingContractClient.algorand.setSignerFromAccount(liquidatorAccount)
    localnet.algorand.setSignerFromAccount(liquidatorAccount)

    const algod = algoLendingContractClient.algorand.client.algod
    const liquidatorAssetInfoBefore = await algod
      .accountAssetInformation(liquidatorAccount.addr, loanBefore.collateralTokenId)
      .do()
    const liquidatorCollateralBefore = BigInt(liquidatorAssetInfoBefore.assetHolding?.amount ?? 0)

    const partialRepayTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: liquidatorAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(repayAttempt),
      note: 'Attempt partial liquidation repay',
      maxFee: microAlgo(MAX_FEE),
    })

    await expect(
      algoLendingContractClient
        .newGroup()
        .gas({ args: {}, sender: liquidatorAccount.addr, maxFee: microAlgo(MAX_FEE) })
        .liquidatePartialAlgo({
          args: [debtor.addr.toString(), partialRepayTxn, repayAttempt, lstAppId],
          sender: liquidatorAccount.addr,
          maxFee: microAlgo(MAX_FEE),
        })
        .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true }),
    ).rejects.toThrow(/FULL_REPAY_REQUIRED/)

    const fullRepayAmount = liveDebtBefore
    const fullRepayTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: liquidatorAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(fullRepayAmount),
      note: 'Full liquidation repayment',
    })

    await algoLendingContractClient
      .newGroup()
      .gas({ args: {}, sender: liquidatorAccount.addr, maxFee: microAlgo(MAX_FEE) })
      .liquidatePartialAlgo({
        args: [debtor.addr.toString(), fullRepayTxn, fullRepayAmount, lstAppId],
        sender: liquidatorAccount.addr,
        maxFee: microAlgo(MAX_FEE),
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    const algoGlobalStateAfter = await algoLendingContractClient.state.global.getAll()
    const activeLoanRecordsAfter = (algoGlobalStateAfter.activeLoanRecords ?? activeLoanRecordsBefore) as bigint
    expect(activeLoanRecordsAfter).toEqual(activeLoanRecordsBefore - 1n)

    await expect(
      getLoanRecordBoxValue(debtor.addr.toString(), algoLendingContractClient, algoLendingContractClient.appId),
    ).rejects.toThrow()

    const liquidatorAssetInfoAfter = await algod
      .accountAssetInformation(liquidatorAccount.addr, loanBefore.collateralTokenId)
      .do()
    const liquidatorCollateralAfter = BigInt(liquidatorAssetInfoAfter.assetHolding?.amount ?? 0)
    expect(liquidatorCollateralAfter - liquidatorCollateralBefore).toEqual(loanBefore.collateralAmount)

    
  })
})
