/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo, microAlgos } from '@algorandfoundation/algokit-utils'
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

let xUSDLendingContractClient: OrbitalLendingAsaClient
let algoLendingContractClient: OrbitalLendingClient
let oracleAppClient: OracleClient
let managerAccount: Account
let buyerAccount: Account
let liquidatorAccount: Account

let xUSDAssetId = 0n
let cAlgoAssetId = 0n
const INIT_CONTRACT_AMOUNT = 400000n
const ltv_bps = 8500n
const liquidation_bonus_bps = 500n
const liq_threshold_bps = BASIS_POINTS + liquidation_bonus_bps + 500n
const origination_fee_bps = 500n
const protocol_interest_fee_bps = 500n
const borrow_gate_enabled = 1n // 0 = false, 1 = true

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
        liquidation_bonus_bps,
        origination_fee_bps,
        protocol_interest_fee_bps,
        oracleAppClient.appId,
        xUSDAssetId,
        8n,
        0n
      ],
    })

    const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
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
      args: [mbrTxn],
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
        liquidation_bonus_bps,
        origination_fee_bps,
        protocol_interest_fee_bps,
        oracleAppClient.appId,
        xUSDAssetId,
        8n,
        0n
      ],
    })
    const lstId = await createToken(managerAccount, 'cALGO', 6)

    const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(2000n),
      note: 'Funding lst optin',
    })

    await algoLendingContractClient.send.optInToLst({
      args: [lstId, mbrTxn],
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
      args: {
        collateralTokenId: cAlgoAssetId,
        collateralBaseTokenId: 0n,
        mbrTxn,
        originatingAppId: algoLendingContractClient.appId,
      },
      assetReferences: [cAlgoAssetId],
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
      args: [0, price],
    })
  })
  test('Add xusd price to oracle', async () => {
    const price = 1_000_000n // Example price for xusd
    const globalState = await algoLendingContractClient.state.global.getAll()
    await oracleAppClient.send.addTokenListing({
      args: [xUSDAssetId, price],
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
      })

      await xUSDLendingContractClient.algorand.send.assetTransfer({
        sender: managerAccount.addr,
        receiver: depositorAccount.addr,
        assetId: xUSDAssetId,
        amount: DEPOSITOR_XUSD_INITIAL_BALANCE,
        note: 'Funding depositor with xUSD',
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
    })

    await localnet.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: b.addr,
      assetId: xUSDAssetId,
      amount: 100_000_000_000n,
      note: 'Funding buyer with xUSD',
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
        })

        const depositTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
          sender: depositorAccount.addr,
          receiver: xUSDLendingContractClient.appClient.appAddress,
          assetId: xUSDAssetId,
          amount: depositAmount,
          note: 'Depositing xUSD',
        })

        const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
          sender: depositorAccount.addr,
          receiver: xUSDLendingContractClient.appClient.appAddress,
          amount: microAlgo(10_000n),
          note: 'Funding deposit',
        })

        await xUSDLendingContractClient.send.depositAsa({
          args: [depositTxn, depositAmount, mbrTxn],
          assetReferences: [xUSDAssetId],
          sender: depositorAccount.addr,
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
        })

        const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
          sender: depositorAccount.addr,
          receiver: xUSDLendingContractClient.appClient.appAddress,
          amount: microAlgo(3000n),
          note: 'Funding withdraw',
        })

        await xUSDLendingContractClient.send.withdrawDeposit({
          args: [axferTxn, withdrawAmount, xUSDLendingContractClient.appId, mbrTxn],
          assetReferences: [lstTokenId],
          appReferences: [xUSDLendingContractClient.appId],
          sender: depositorAccount.addr,
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
    })
    feeTracker += 1000n

    const { amount: algoBalanceBeforeDeposit } = await algod.accountInformation(managerAccount.addr).do()

    const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(10_000n),
      note: 'Funding algo contract',
    })
    feeTracker += 10_000n

    const depositTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(ALGO_DEPOSIT_AMOUNT),
      note: 'Depositing algo',
    })
    feeTracker += 1000n

    await algoLendingContractClient.send.depositAlgo({
      args: [depositTxn, ALGO_DEPOSIT_AMOUNT, mbrTxn],
      sender: managerAccount.addr,
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

    const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(101000n),
      note: 'Funding collateral addition',
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
          mbrTxn,
          originatingAppId: xUSDLendingContractClient.appId,
        },
        assetReferences: [lstTokenId],
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
      const arc19String = 'this-is-a-test-arc19-metadata-string'
      const { amount: algoBalanceBefore } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(borrowerAccount.addr)
        .do()

      expect(cxusd).toBeDefined()
      expect(cxusd).toBeGreaterThan(0n)

      const algoPrice = await oracleAppClient.send.getTokenPrice({
        args: [0n], // 0n for Algo
        assetReferences: [0n],
      })

      const xUSDPrice = await oracleAppClient.send.getTokenPrice({
        args: [xUSDAssetId],
        assetReferences: [xUSDAssetId],
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
        })
        feeTracker += 1000n
        const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
          sender: borrowerAccount.addr,
          receiver: algoLendingContractClient.appClient.appAddress,
          amount: microAlgo(4000n),
          note: 'Funding borrow',
        })
        feeTracker += 5000n
        const reserve = await localnet.context.generateAccount({ initialFunds: microAlgo(100000n) })

        //log out params
        const globalsStateAlgo = await algoLendingContractClient.state.global.getAll()
        const xusdGlobalState = await xUSDLendingContractClient.state.global.getAll()
        const totalDeposits = xusdGlobalState.totalDeposits
        const circulatingcXUSD = xusdGlobalState.circulatingLst
        console.log('Total deposits:', totalDeposits)
        console.log('Circulating cXUSD:', circulatingcXUSD)

        const collateralPriceReturn = await algoLendingContractClient.send.calculateCollateralValueUsd({
          args: [cxusd, collateralAmount, lstAppId],
          sender: borrowerAccount.addr,
        })
        const cxusdPrice =
          collateralPriceReturn?.returns && collateralPriceReturn.returns.length > 0
            ? (collateralPriceReturn.returns[0].returnValue as bigint)
            : 0

        console.log('collateralPriceReturn', collateralPriceReturn)
        console.log('cxUSD price:', cxusdPrice)
        console.log('Collateral amount:', collateralAmount)
        const preCalculated = calculateDisbursement({
          collateralAmount,
          collateralPrice: cxusdPrice || 0n, //cxusd price
          ltvBps: ltv_bps,
          baseTokenPrice: algoPrice.return?.price || 0n, //algo price
          requestedLoanAmount: borrowAmount,
          originationFeeBps: origination_fee_bps,
        })
        //console.log('preCalculated disbursement:', preCalculated)

        await algoLendingContractClient
          .newGroup()
          .gas()
          .borrow({
            args: [axferTxn, borrowAmount, collateralAmount, lstAppId, cxusd, mbrTxn],
            assetReferences: [cxusd],
            appReferences: [lstAppId, oracleAppClient.appId],
            boxReferences: [
              {
                appId: boxValue.boxRef.appIndex as bigint,
                name: boxValue.boxRef.name,
              },
            ],
            sender: borrowerAccount.addr,
          })
          .send()
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

    const computeLiquidationPrice = (repayAmount: bigint): bigint | undefined => {
      if (repayAmount <= 0n) return undefined
      const { collateralAmount } = loanBefore
      let candidatePrice = priceNeeded > 0n ? priceNeeded : 1n
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

    const circulatingLst = xusdGlobalState.circulatingLst ?? 1n
    const totalDeposits = xusdGlobalState.totalDeposits ?? 0n
    const underlyingCollateral = (loanBefore.collateralAmount * totalDeposits) / circulatingLst
    expect(underlyingCollateral).toBeGreaterThan(0n)

    const algoPriceInfo = await oracleAppClient.send.getTokenPrice({
      args: [0n],
      assetReferences: [0n],
    })
    const algoPrice = algoPriceInfo.return?.price ?? 0n
    expect(algoPrice).toBeGreaterThan(0n)
    const debtUsd = (liveDebtBefore * algoPrice) / USD_MICRO_UNITS

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
      const closeFactorRepay = liveDebtBefore / 2n
      repayAttempt = closeFactorRepay > 0n ? closeFactorRepay : 1n
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

    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: [xUSDAssetId, chosenLiquidationPrice],
    })

    try {
      algoLendingContractClient.algorand.setSignerFromAccount(liquidatorAccount)
      localnet.algorand.setSignerFromAccount(liquidatorAccount)

      const algod = algoLendingContractClient.algorand.client.algod
      const liquidatorAssetInfoBefore = await algod
        .accountAssetInformation(liquidatorAccount.addr, loanBefore.collateralTokenId)
        .do()
      const liquidatorCollateralBefore = BigInt(liquidatorAssetInfoBefore.assetHolding?.amount ?? 0)

      const repayTxn = algoLendingContractClient.algorand.createTransaction.payment({
        sender: liquidatorAccount.addr,
        receiver: algoLendingContractClient.appClient.appAddress,
        amount: microAlgos(repayAttempt),
        note: 'Repaying debt for liquidation',
      })

      await algoLendingContractClient
        .newGroup()
        .gas()
        .liquidatePartialAlgo({
          args: [debtor.addr.publicKey, repayTxn, repayAttempt, lstAppId],
          sender: liquidatorAccount.addr,
          appReferences: [algoLendingContractClient.appId, lstAppId, oracleAppClient.appId],
          assetReferences: [loanBefore.collateralTokenId],
          boxReferences: [
            {
              appId: loanBefore.boxRef.appIndex as bigint,
              name: loanBefore.boxRef.name,
            },
            {
              appId: collateralBox.boxRef.appIndex as bigint,
              name: collateralBox.boxRef.name,
            },
          ],
        })
        .send()

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
        args: [xUSDAssetId, currentXusdPrice],
      })
    }
  })

  test('partial liquidation requires full repayment when remaining collateral cannot support bonus cushion', async () => {
    const debtor = depositors[0]
    const lstAppId = xUSDLendingContractClient.appId

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
    })
    const algoPrice = algoPriceInfo.return?.price ?? 0n
    expect(algoPrice).toBeGreaterThan(0n)

    const currentXusdPriceInfo = await oracleAppClient.send.getTokenPrice({
      args: [xUSDAssetId],
      assetReferences: [xUSDAssetId],
    })
    const currentXusdPrice = currentXusdPriceInfo.return?.price ?? 0n
    expect(currentXusdPrice).toBeGreaterThan(0n)

    const depressedPrice = currentXusdPrice > 1000n ? currentXusdPrice / 20n : 1n

    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: [xUSDAssetId, depressedPrice],
    })

    const totalDeposits = xusdGlobalState.totalDeposits ?? 0n
    const circulatingLst = xusdGlobalState.circulatingLst ?? 1n
    const bonusBps = algoGlobalState.liqBonusBps ?? 0n

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
    })

    await expect(
      algoLendingContractClient
        .newGroup()
        .gas()
        .liquidatePartialAlgo({
          args: [debtor.addr.publicKey, partialRepayTxn, repayAttempt, lstAppId],
          sender: liquidatorAccount.addr,
          appReferences: [algoLendingContractClient.appId, lstAppId, oracleAppClient.appId],
          assetReferences: [loanBefore.collateralTokenId],
          boxReferences: [
            {
              appId: loanBefore.boxRef.appIndex as bigint,
              name: loanBefore.boxRef.name,
            },
            {
              appId: collateralBox.boxRef.appIndex as bigint,
              name: collateralBox.boxRef.name,
            },
          ],
        })
        .send(),
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
      .gas()
      .liquidatePartialAlgo({
        args: [debtor.addr.publicKey, fullRepayTxn, fullRepayAmount, lstAppId],
        sender: liquidatorAccount.addr,
        appReferences: [algoLendingContractClient.appId, lstAppId, oracleAppClient.appId],
        assetReferences: [loanBefore.collateralTokenId],
        boxReferences: [
          {
            appId: loanBefore.boxRef.appIndex as bigint,
            name: loanBefore.boxRef.name,
          },
          {
            appId: collateralBox.boxRef.appIndex as bigint,
            name: collateralBox.boxRef.name,
          },
        ],
      })
      .send()

    const algoGlobalStateAfter = await algoLendingContractClient.state.global.getAll()
    const activeLoanRecordsAfter = (algoGlobalStateAfter.activeLoanRecords ?? activeLoanRecordsBefore) as bigint
    expect(activeLoanRecordsAfter).toEqual(activeLoanRecordsBefore - 1n)

    await expect(
      getLoanRecordBoxValue(
        debtor.addr.toString(),
        algoLendingContractClient,
        algoLendingContractClient.appId,
      ),
    ).rejects.toThrow()

    const liquidatorAssetInfoAfter = await algod
      .accountAssetInformation(liquidatorAccount.addr, loanBefore.collateralTokenId)
      .do()
    const liquidatorCollateralAfter = BigInt(liquidatorAssetInfoAfter.assetHolding?.amount ?? 0)
    expect(liquidatorCollateralAfter - liquidatorCollateralBefore).toEqual(loanBefore.collateralAmount)

    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.updateTokenPrice({
      args: [xUSDAssetId, currentXusdPrice],
    })
  })

  test.skip('Buyout loan - algo Lending Contract', async () => {
    const debtor = depositors[0]
    const buyer = buyerAccount
    algoLendingContractClient.algorand.setSignerFromAccount(buyer)
    xUSDLendingContractClient.algorand.setSignerFromAccount(buyer)
    localnet.algorand.setSignerFromAccount(buyer)
    const record = await getLoanRecordBoxValue(
      debtor.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    expect(record).toBeDefined()
    const collateralTokenId = record.collateralTokenId

    //Confirm buyer is opted in to collateral token.
    const algod = algoLendingContractClient.algorand.client.algod
    try {
      const tokenHoldingRequest = await algod.accountAssetInformation(buyer.addr, collateralTokenId).do()
    } catch (e) {
      console.log('Buyer not opted in to collateral token, opting in now.')
      await algoLendingContractClient.algorand.send.assetOptIn({
        sender: buyer.addr,
        assetId: collateralTokenId,
        note: 'Opting in to collateral asset for buyout',
      })
    }
    const algoGlobalState = await algoLendingContractClient.state.global.getAll()
    const xusdGlobalState = await xUSDLendingContractClient.state.global.getAll()

    const xUSDPrice = await oracleAppClient.send.getTokenPrice({
      args: [xUSDAssetId],
      assetReferences: [xUSDAssetId],
    })
    console.log('xUSD price:', xUSDPrice.return?.price)

    const algoPrice = await oracleAppClient.send.getTokenPrice({
      args: [0n], // 0n for Algo
      assetReferences: [0n],
    })
    console.log('Algo price:', algoPrice.return?.price)
    // Get buyout amount and total debt to repay
    const params = {
      collateralLSTAmount: record.collateralAmount as bigint, // borrower’s LST balance locked
      totalDepositsLST: xusdGlobalState.totalDeposits as bigint,
      circulatingLST: xusdGlobalState.circulatingLst as bigint,
      underlyingBasePrice: xUSDPrice.return?.price || 0n,
      baseTokenPrice: algoPrice.return?.price || 0n,
      buyoutTokenPrice: xUSDPrice.return?.price || 0n,
      principal: record.principal as bigint,
      userIndexWad: record.userIndexWad as bigint,
      borrowIndexWad: algoGlobalState.borrowIndexWad as bigint,
      liq_threshold_bps: algoGlobalState.liqThresholdBps as bigint,
    }

    const r = computeBuyoutTerms(params)
    expect(r.premiumTokens).toBeGreaterThan(0n)

    //check current manager and debtor account xUSD balance
    const managerxUSDBalanceBeforeRequest = await algod.accountAssetInformation(managerAccount.addr, xUSDAssetId).do()
    const managerxUSDBalanceBefore = managerxUSDBalanceBeforeRequest.assetHolding?.amount || 0n
    const debtorxUSDBalanceBeforeRequest = await algod.accountAssetInformation(debtor.addr, xUSDAssetId).do()
    const debtorxUSDBalanceBefore = debtorxUSDBalanceBeforeRequest.assetHolding?.amount || 0n
    const buyerxUSDBalanceBeforeRequest = await algod.accountAssetInformation(buyer.addr, xUSDAssetId).do()
    const buyerxUSDBalanceBefore = buyerxUSDBalanceBeforeRequest.assetHolding?.amount || 0n
    const buyerCollateralBalanceBeforeRequest = await algod.accountAssetInformation(buyer.addr, collateralTokenId).do()
    const buyerCollateralBalanceBefore = buyerCollateralBalanceBeforeRequest.assetHolding?.amount || 0n
    // buyout loan

    // premium xusd transafer
    const xUSDPremiumTransferTxn = await algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: buyer.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: r.premiumTokens,
      note: 'Paying buyout premium in xUSD',
    })

    //reapyment pay txn (algo lending)
    const repayPayTxn = await algoLendingContractClient.algorand.createTransaction.payment({
      sender: buyer.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(r.debtRepayAmountBase),
      note: 'Repaying loan with algo',
    })
    const mbrTxn = await algoLendingContractClient.algorand.createTransaction.payment({
      sender: buyer.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(10_000n),
      note: 'Funding buyout',
    })

    await algoLendingContractClient
      .newGroup()
      .gas({ args: [], note: '1' })
      .buyoutSplitAlgo({
        args: [
          buyer.addr.publicKey,
          debtor.addr.publicKey,
          xUSDPremiumTransferTxn,
          repayPayTxn,
          xUSDLendingContractClient.appId,
          mbrTxn,
        ],
        assetReferences: [xUSDAssetId, collateralTokenId],
        appReferences: [algoLendingContractClient.appId, xUSDLendingContractClient.appId, oracleAppClient.appId],
      })
      .send()

    // check balances after buyout
    const managerxUSDBalanceAfterRequest = await algod.accountAssetInformation(managerAccount.addr, xUSDAssetId).do()
    const managerxUSDBalanceAfter = managerxUSDBalanceAfterRequest.assetHolding?.amount || 0n
    const debtorxUSDBalanceAfterRequest = await algod.accountAssetInformation(debtor.addr, xUSDAssetId).do()
    const debtorxUSDBalanceAfter = debtorxUSDBalanceAfterRequest.assetHolding?.amount || 0n
    const buyerxUSDBalanceAfterRequest = await algod.accountAssetInformation(buyer.addr, xUSDAssetId).do()
    const buyerxUSDBalanceAfter = buyerxUSDBalanceAfterRequest.assetHolding?.amount || 0n
    const buyerCollateralBalanceAfterRequest = await algod.accountAssetInformation(buyer.addr, collateralTokenId).do()
    const buyerCollateralBalanceAfter = buyerCollateralBalanceAfterRequest.assetHolding?.amount || 0n

    expect(managerxUSDBalanceAfter).toEqual(managerxUSDBalanceBefore + r.premiumTokens / 2n)
    expect(debtorxUSDBalanceAfter).toEqual(debtorxUSDBalanceBefore + r.premiumTokens / 2n)
    expect(buyerxUSDBalanceAfter).toEqual(buyerxUSDBalanceBefore - r.premiumTokens)
    expect(buyerCollateralBalanceAfter).toEqual(buyerCollateralBalanceBefore + record.collateralAmount)
  })
})
