/* eslint-disable @typescript-eslint/no-unused-vars */
import { algo, Config, microAlgo, microAlgos } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { OrbitalLendingClient } from '../artifacts/orbital_lending/orbital-lendingClient'
import { Account } from 'algosdk'
import {
  calculateDisbursement,
  computeBuyoutTerms,
  getCollateralBoxValue,
  getLoanRecordBoxValue,
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

let xUSDAssetId = 0n
let cAlgoAssetId = 0n
const INIT_CONTRACT_AMOUNT = 400000n
const ltv_bps = 8500n
const liq_threshold_bps = 9000n
const liquidation_bonus_bps = 500n
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
      args: {
        mbrTxn: payTxn,
        ltvBps: ltv_bps,
        liqThresholdBps: liq_threshold_bps,
        originationFeeBps: origination_fee_bps,
        protocolShareBps: protocol_interest_fee_bps,
        additionalRewardsCommissionPercentage: 8n,
        oracleAppId: oracleAppClient.appId,
        buyoutTokenId: xUSDAssetId,
        fluxOracleAppId: 0n,
      },
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
      args: {
        mbrTxn: payTxn,
        ltvBps: ltv_bps,
        liqThresholdBps: liq_threshold_bps,
        originationFeeBps: origination_fee_bps,
        protocolShareBps: protocol_interest_fee_bps,
        additionalRewardsCommissionPercentage: 8n,
        oracleAppId: oracleAppClient.appId,
        buyoutTokenId: xUSDAssetId,
        fluxOracleAppId: 0n,
      },
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

    await xUSDLendingContractClient.send.setContractState({
      args: { state: 1n },
    })
    await algoLendingContractClient.send.setContractState({
      args: { state: 1n },
    })
  }, 20000)

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
    feeTracker += 10000n

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

    const assetInfo = await algod.accountAssetInformation(managerAccount.addr, lstTokenId).do()
    expect(assetInfo).toBeDefined()
    //LST will be 1:1 with the deposit at this stage
    //expect(assetInfo.assetHolding?.amount).toEqual(ALGO_DEPOSIT_AMOUNT)
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

  test('Buyout loan - algo Lending Contract', async () => {
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
    // Refresh accrual before computing terms so debt matches contract path
    await algoLendingContractClient.send.accrueLoanInterest({
      args: [debtor.addr.toString(), managerAccount.addr.toString()],
      sender: managerAccount.addr,
    })
    const refreshedRecord = await algoLendingContractClient.send.getLoanRecord({ args: [debtor.addr.publicKey] })
    const refreshedGlobals = await algoLendingContractClient.state.global.getAll()

    const params = {
      collateralLSTAmount: refreshedRecord.return?.collateralAmount as bigint,
      totalDepositsLST: xusdGlobalState.totalDeposits as bigint,
      circulatingLST: xusdGlobalState.circulatingLst as bigint,
      underlyingBasePrice: xUSDPrice.return?.price || 0n,
      baseTokenPrice: algoPrice.return?.price || 0n,
      buyoutTokenPrice: xUSDPrice.return?.price || 0n,
      principal: refreshedRecord.return?.principal as bigint,
      userIndexWad: refreshedRecord.return?.userIndexWad as bigint,
      borrowIndexWad: refreshedGlobals.borrowIndexWad as bigint,
      liq_threshold_bps: refreshedGlobals.liqThresholdBps as bigint,
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
    const contractxUSDBalanceBeforeRequest = await algod
      .accountAssetInformation(algoLendingContractClient.appClient.appAddress, xUSDAssetId)
      .do()
    const contractxUSDBalanceBefore = contractxUSDBalanceBeforeRequest.assetHolding?.amount || 0n
    const buyerCollateralBalanceBeforeRequest = await algod.accountAssetInformation(buyer.addr, collateralTokenId).do()
    const buyerCollateralBalanceBefore = buyerCollateralBalanceBeforeRequest.assetHolding?.amount || 0n
    // buyout loan

    const premiumPaymentAmount = r.premiumTokens + 10n
    const repayBuffer = 10_000n

    // premium xusd transafer
    const xUSDPremiumTransferTxn = await algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: buyer.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: premiumPaymentAmount,
      note: 'Paying buyout premium in xUSD',
    })

    //reapyment pay txn (algo lending)
    const repayPayTxn = await algoLendingContractClient.algorand.createTransaction.payment({
      sender: buyer.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(r.debtRepayAmountBase + repayBuffer), // buffer for >= debt check, overage refunded
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
        args: {
          buyer: buyer.addr.publicKey,
          debtor: debtor.addr.publicKey,
          premiumAxferTxn: xUSDPremiumTransferTxn,
          repayPayTxn,
          lstAppId: xUSDLendingContractClient.appId,
          mbrTxn,
        },
        assetReferences: [xUSDAssetId, collateralTokenId],
        appReferences: [algoLendingContractClient.appId, xUSDLendingContractClient.appId, oracleAppClient.appId],
        sender: buyer.addr,
      })
      .send()

    // check balances after buyout
    const managerxUSDBalanceAfterRequest = await algod.accountAssetInformation(managerAccount.addr, xUSDAssetId).do()
    const managerxUSDBalanceAfter = managerxUSDBalanceAfterRequest.assetHolding?.amount || 0n
    const debtorxUSDBalanceAfterRequest = await algod.accountAssetInformation(debtor.addr, xUSDAssetId).do()
    const debtorxUSDBalanceAfter = debtorxUSDBalanceAfterRequest.assetHolding?.amount || 0n
    const buyerxUSDBalanceAfterRequest = await algod.accountAssetInformation(buyer.addr, xUSDAssetId).do()
    const buyerxUSDBalanceAfter = buyerxUSDBalanceAfterRequest.assetHolding?.amount || 0n
    const contractxUSDBalanceAfterRequest = await algod
      .accountAssetInformation(algoLendingContractClient.appClient.appAddress, xUSDAssetId)
      .do()
    const contractxUSDBalanceAfter = contractxUSDBalanceAfterRequest.assetHolding?.amount || 0n
    const buyerCollateralBalanceAfterRequest = await algod.accountAssetInformation(buyer.addr, collateralTokenId).do()
    const buyerCollateralBalanceAfter = buyerCollateralBalanceAfterRequest.assetHolding?.amount || 0n

    const netRepayPaid = contractxUSDBalanceAfter - contractxUSDBalanceBefore
    const actualPremiumPaid = buyerxUSDBalanceBefore - buyerxUSDBalanceAfter - netRepayPaid
    const expectedRefund = premiumPaymentAmount - r.premiumTokens
    const actualRefund = premiumPaymentAmount - actualPremiumPaid

    expect(managerxUSDBalanceAfter).toEqual(managerxUSDBalanceBefore + r.premiumTokens / 2n)
    expect(debtorxUSDBalanceAfter).toEqual(debtorxUSDBalanceBefore + r.premiumTokens / 2n)
    expect(actualPremiumPaid).toEqual(r.premiumTokens)
    expect(actualRefund).toEqual(expectedRefund)
    expect(buyerCollateralBalanceAfter).toEqual(buyerCollateralBalanceBefore + refreshedRecord.return!.collateralAmount)
  })

  test('buyout tolerates large overpay and refunds excess', async () => {
    const { generateAccount } = localnet.context
    const borrower = await generateAccount({ initialFunds: microAlgo(8_000_000) })
    const buyer = await generateAccount({ initialFunds: microAlgo(8_000_000) })

    // Opt-ins
    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: borrower.addr,
      assetId: xUSDAssetId,
      note: 'Opting borrower into xUSD',
    })

    algoLendingContractClient.algorand.setSignerFromAccount(borrower)
    const xusdState = await xUSDLendingContractClient.state.global.getAll()
    const cxusd = xusdState.lstTokenId as bigint
    await algoLendingContractClient.algorand.send.assetOptIn({
      sender: borrower.addr,
      assetId: cxusd,
      note: 'Opting borrower into cxUSD',
    })

    // Manager funds borrower with xUSD; borrower mints cxUSD via depositAsa
    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: borrower.addr,
      assetId: xUSDAssetId,
      amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
      note: 'Funding borrower with xUSD to mint cxUSD collateral',
    })
    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    const depositTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: borrower.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
      note: 'Depositing xUSD to mint cxUSD',
    })
    const mbrDeposit = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: borrower.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(10_000n),
      note: 'MBR for cxUSD mint',
    })
    await xUSDLendingContractClient.send.depositAsa({
      args: [depositTxn, DEPOSITOR_INITIAL_COLLATERAL_AMOUNT, mbrDeposit],
      assetReferences: [xUSDAssetId],
      sender: borrower.addr,
    })

    // Borrow against collateral
    algoLendingContractClient.algorand.setSignerFromAccount(borrower)
    const boxValue = await getCollateralBoxValue(cxusd, algoLendingContractClient, algoLendingContractClient.appId)
    const borrowMbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: borrower.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(4000n),
      note: 'Borrow MBR',
    })
    await algoLendingContractClient
      .newGroup()
      .gas()
      .borrow({
        args: [
          algoLendingContractClient.algorand.createTransaction.assetTransfer({
            sender: borrower.addr,
            receiver: algoLendingContractClient.appClient.appAddress,
            assetId: cxusd,
            amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
            note: 'Depositing cxUSD collateral',
          }),
          DEPOSITOR_INITIAL_BORROW_AMOUNT,
          DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
          xUSDLendingContractClient.appId,
          cxusd,
          borrowMbrTxn,
        ],
        assetReferences: [cxusd],
        appReferences: [xUSDLendingContractClient.appId, oracleAppClient.appId],
        boxReferences: [{ appId: boxValue.boxRef.appIndex as bigint, name: boxValue.boxRef.name }],
        sender: borrower.addr,
      })
      .send()

    const loanRecord = await getLoanRecordBoxValue(
      borrower.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    const algoState = await algoLendingContractClient.state.global.getAll()
    const xusdPrice = await oracleAppClient.send.getTokenPrice({ args: [xUSDAssetId], assetReferences: [xUSDAssetId] })
    const algoPrice = await oracleAppClient.send.getTokenPrice({ args: [0n], assetReferences: [0n] })

    const terms = computeBuyoutTerms({
      collateralLSTAmount: loanRecord.collateralAmount,
      totalDepositsLST: xusdState.totalDeposits ?? 0n,
      circulatingLST: xusdState.circulatingLst ?? 0n,
      underlyingBasePrice: xusdPrice.return?.price || 0n,
      baseTokenPrice: algoPrice.return?.price || 0n,
      buyoutTokenPrice: xusdPrice.return?.price || 0n,
      principal: loanRecord.principal,
      userIndexWad: loanRecord.userIndexWad,
      borrowIndexWad: algoState.borrowIndexWad as bigint,
      liq_threshold_bps: algoState.liqThresholdBps as bigint,
    })

    // Fund buyer with buffers

    // Fund ALGO for repay + fees
    const repayBuffer = 10_000n
    algoLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await algoLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: buyer.addr,
      amount: microAlgo(terms.debtRepayAmountBase + repayBuffer + 2_000_000n),
      note: 'Funding buyer with ALGO for overpay buyout',
    })

    algoLendingContractClient.algorand.setSignerFromAccount(buyer)
    await algoLendingContractClient.algorand.send.assetOptIn({
      sender: buyer.addr,
      assetId: xUSDAssetId,
      note: 'Opt buyer into xUSD',
    })
    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: buyer.addr,
      assetId: xUSDAssetId,
      amount: terms.premiumTokens + terms.debtRepayAmountBase + 1_000_000n,
      note: 'Funding buyer for overpay buyout',
    })

    algoLendingContractClient.algorand.setSignerFromAccount(buyer)
    await algoLendingContractClient.algorand.send.assetOptIn({
      sender: buyer.addr,
      assetId: cxusd,
      note: 'Opt buyer into cxUSD',
    })

    const premiumPaymentAmount = terms.premiumTokens + 10n

    const repayPayTxn = await algoLendingContractClient.algorand.createTransaction.payment({
      sender: buyer.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(terms.debtRepayAmountBase + repayBuffer),
      note: 'Overpaying buyout repay',
    })
    const premiumAxferTxn = await algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: buyer.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: premiumPaymentAmount,
      note: 'Overpaying premium',
    })

    const buyerXusdBefore =
      (await algoLendingContractClient.algorand.client.algod.accountAssetInformation(buyer.addr, xUSDAssetId).do())
        .assetHolding?.amount || 0n
    const contractXusdBefore =
      (
        await algoLendingContractClient.algorand.client.algod
          .accountAssetInformation(algoLendingContractClient.appClient.appAddress, xUSDAssetId)
          .do()
      ).assetHolding?.amount || 0n

    await algoLendingContractClient
      .newGroup()
      .gas()
      .buyoutSplitAlgo({
        args: {
          buyer: buyer.addr.toString(),
          debtor: borrower.addr.toString(),
          premiumAxferTxn,
          repayPayTxn,
          lstAppId: xUSDLendingContractClient.appId,
          mbrTxn: algoLendingContractClient.algorand.createTransaction.payment({
            sender: buyer.addr,
            receiver: algoLendingContractClient.appClient.appAddress,
            amount: microAlgo(10_000n),
            note: 'Buyout MBR',
          }),
        },
        assetReferences: [xUSDAssetId, cxusd],
        appReferences: [algoLendingContractClient.appId, xUSDLendingContractClient.appId, oracleAppClient.appId],
        boxReferences: [{ appId: boxValue.boxRef.appIndex as bigint, name: boxValue.boxRef.name }],
        sender: buyer.addr,
      })
      .send()

    const buyerXusdAfter =
      (await algoLendingContractClient.algorand.client.algod.accountAssetInformation(buyer.addr, xUSDAssetId).do())
        .assetHolding?.amount || 0n
    const contractXusdAfter =
      (
        await algoLendingContractClient.algorand.client.algod
          .accountAssetInformation(algoLendingContractClient.appClient.appAddress, xUSDAssetId)
          .do()
      ).assetHolding?.amount || 0n

    const netRepayPaid = contractXusdAfter - contractXusdBefore
    const actualPremiumPaid = buyerXusdBefore - buyerXusdAfter - netRepayPaid
    const expectedPremiumRefund = premiumPaymentAmount - terms.premiumTokens
    const actualPremiumRefund = premiumPaymentAmount - actualPremiumPaid
    const borrowDelta =
      (algoState.totalBorrows ?? 0n) - ((await algoLendingContractClient.state.global.getAll()).totalBorrows ?? 0n)

    expect(actualPremiumPaid).toEqual(terms.premiumTokens)
    expect(actualPremiumRefund).toEqual(expectedPremiumRefund)
    expect(borrowDelta).toBeLessThanOrEqual(terms.debtRepayAmountBase)
  })

  test('buyout fails when repay is below live debt', async () => {
    const { generateAccount } = localnet.context
    const borrower = await generateAccount({ initialFunds: microAlgo(8_000_000) })
    const buyer = await generateAccount({ initialFunds: microAlgo(8_000_000) })

    // minimal setup: opt in and borrow
    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: borrower.addr,
      assetId: xUSDAssetId,
      note: 'Opt borrower into xUSD for fail buyout',
    })
    algoLendingContractClient.algorand.setSignerFromAccount(borrower)
    const xusdState = await xUSDLendingContractClient.state.global.getAll()
    const cxusd = xusdState.lstTokenId as bigint
    await algoLendingContractClient.algorand.send.assetOptIn({
      sender: borrower.addr,
      assetId: cxusd,
      note: 'Opt borrower into cxUSD for fail buyout',
    })
    // Manager funds borrower with xUSD; borrower mints cxUSD via deposit
    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: borrower.addr,
      assetId: xUSDAssetId,
      amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
      note: 'Funding borrower xUSD for cxUSD mint',
    })
    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    const depositTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: borrower.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
      note: 'Depositing xUSD to mint cxUSD',
    })
    const depositMbr = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: borrower.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(10_000n),
      note: 'MBR for cxUSD mint',
    })
    await xUSDLendingContractClient.send.depositAsa({
      args: [depositTxn, DEPOSITOR_INITIAL_COLLATERAL_AMOUNT, depositMbr],
      assetReferences: [xUSDAssetId],
      sender: borrower.addr,
    })
    algoLendingContractClient.algorand.setSignerFromAccount(borrower)
    const boxValue = await getCollateralBoxValue(cxusd, algoLendingContractClient, algoLendingContractClient.appId)
    const borrowMbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: borrower.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(4000n),
      note: 'Borrow MBR',
    })
    await algoLendingContractClient
      .newGroup()
      .gas()
      .borrow({
        args: [
          algoLendingContractClient.algorand.createTransaction.assetTransfer({
            sender: borrower.addr,
            receiver: algoLendingContractClient.appClient.appAddress,
            assetId: cxusd,
            amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
            note: 'Depositing cxUSD collateral',
          }),
          DEPOSITOR_INITIAL_BORROW_AMOUNT,
          DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
          xUSDLendingContractClient.appId,
          cxusd,
          borrowMbrTxn,
        ],
        assetReferences: [cxusd],
        appReferences: [xUSDLendingContractClient.appId, oracleAppClient.appId],
        boxReferences: [{ appId: boxValue.boxRef.appIndex as bigint, name: boxValue.boxRef.name }],
        sender: borrower.addr,
      })
      .send()

    // Compute terms
    const loanRecord = await getLoanRecordBoxValue(
      borrower.addr.toString(),
      algoLendingContractClient,
      algoLendingContractClient.appId,
    )
    const algoState = await algoLendingContractClient.state.global.getAll()
    const xusdPrice = await oracleAppClient.send.getTokenPrice({ args: [xUSDAssetId], assetReferences: [xUSDAssetId] })
    const algoPrice = await oracleAppClient.send.getTokenPrice({ args: [0n], assetReferences: [0n] })
    const terms = computeBuyoutTerms({
      collateralLSTAmount: loanRecord.collateralAmount,
      totalDepositsLST: xusdState.totalDeposits ?? 0n,
      circulatingLST: xusdState.circulatingLst ?? 0n,
      underlyingBasePrice: xusdPrice.return?.price || 0n,
      baseTokenPrice: algoPrice.return?.price || 0n,
      buyoutTokenPrice: xusdPrice.return?.price || 0n,
      principal: loanRecord.principal,
      userIndexWad: loanRecord.userIndexWad,
      borrowIndexWad: algoState.borrowIndexWad as bigint,
      liq_threshold_bps: algoState.liqThresholdBps as bigint,
    })

    // Buyer underpays repay leg
    algoLendingContractClient.algorand.setSignerFromAccount(buyer)
    await algoLendingContractClient.algorand.send.assetOptIn({
      sender: buyer.addr,
      assetId: xUSDAssetId,
      note: 'Opt buyer into xUSD for fail buyout',
    })
    await algoLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: buyer.addr,
      assetId: xUSDAssetId,
      amount: terms.debtRepayAmountBase - 1000n,
      note: 'Underfund repay',
    })
    const premiumAxferTxn = await algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: buyer.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: terms.premiumTokens,
      note: 'Premium transfer',
    })
    const repayPayTxn = await algoLendingContractClient.algorand.createTransaction.payment({
      sender: buyer.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgos(terms.debtRepayAmountBase - 1000n),
      note: 'Underpay repay',
    })

    await expect(
      algoLendingContractClient
        .newGroup()
        .gas()
        .buyoutSplitAlgo({
          args: {
            buyer: buyer.addr.publicKey,
            debtor: borrower.addr.publicKey,
            premiumAxferTxn,
            repayPayTxn,
            lstAppId: xUSDLendingContractClient.appId,
            mbrTxn: algoLendingContractClient.algorand.createTransaction.payment({
              sender: buyer.addr,
              receiver: algoLendingContractClient.appClient.appAddress,
              amount: microAlgo(10_000n),
              note: 'Buyout MBR fail',
            }),
          },
          assetReferences: [xUSDAssetId, cxusd],
          appReferences: [algoLendingContractClient.appId, xUSDLendingContractClient.appId, oracleAppClient.appId],
          boxReferences: [{ appId: boxValue.boxRef.appIndex as bigint, name: boxValue.boxRef.name }],
        })
        .send(),
    ).rejects.toThrow()
  })
})
