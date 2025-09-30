/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { algo, Config, ensureFunded, microAlgo } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { OrbitalLendingClient, OrbitalLendingFactory } from '../artifacts/orbital_lending/orbital-lendingClient'
import algosdk, { Account, Address, generateAccount } from 'algosdk'
import { exp, len } from '@algorandfoundation/algorand-typescript/op'
import { calculateDisbursement, currentAprBps, getCollateralBoxValue, getLoanRecordBoxValue } from './testing-utils'
import { OracleClient, OracleFactory } from '../artifacts/Oracle/oracleClient'
import { deploy } from './orbital-deploy'
import { createToken } from './token-create'
import { deployOracle } from '../Oracle/oracle-deploy'
import { BoxRef } from '@algorandfoundation/algorand-typescript'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'
import { OrbitalLendingAsaClient } from '../artifacts/orbital_lending/orbital-lending-asaClient'
import { deploy as deployAsa } from './orbital-deploy-asa'
let xUSDLendingContractClient: OrbitalLendingAsaClient
let algoLendingContractClient: OrbitalLendingClient
let oracleAppClient: OracleClient
let managerAccount: Account

let xUSDAssetId = 0n
let cAlgoAssetId = 0n
const INIT_CONTRACT_AMOUNT = 400000n
const ltv_bps = 2500n
const liq_threshold_bps = 1000000n
const liq_bonus_bps = 500n
const origination_fee_bps = 1000n
const protocol_interest_fee_bps = 1000n
const borrow_gate_enabled = 1n // 0 = false, 1 = true
const additional_rewards_commission_percentage = 8n

const NUM_DEPOSITORS = 1
const DEPOSITOR_XUSD_INITIAL_BALANCE = 50_000_000_000n
const DEPOSITOR_INITIAL_DEPOSIT_AMOUNT = 20_000_000_000n
const DEPOSITOR_INITIAL_WITHDRAW_AMOUNT = 5n
const DEPOSITOR_INITIAL_BORROW_AMOUNT = 10_000_000_000n
const DEPOSITOR_INITIAL_COLLATERAL_AMOUNT = 19_000_000_000n
const DEPOSITOR_SECONDARY_BORROW_AMOUNT = 5_000_000_000n

const ALGO_DEPOSIT_AMOUNT = 50_000_000_000n

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
    managerAccount = await generateAccount({ initialFunds: microAlgo(90_000_000_000) })
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
        liq_bonus_bps,
        origination_fee_bps,
        protocol_interest_fee_bps,
        oracleAppClient.appId,
        xUSDAssetId,
        additional_rewards_commission_percentage,
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
    expect(globalState.originationFeeBps).toEqual(origination_fee_bps)
    expect(globalState.protocolShareBps).toEqual(protocol_interest_fee_bps)
    expect(globalState.baseTokenId).toEqual(xUSDAssetId)
    expect(globalState.lstTokenId).toBeDefined()
    expect(globalState.lstTokenId).not.toEqual(99n)

    await xUSDLendingContractClient.send.setContractState({ args: { state: 1n } })
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
        oracleAppClient.appId,
        xUSDAssetId,
        additional_rewards_commission_percentage,
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
    await algoLendingContractClient.send.setContractState({ args: { state: 1n } })
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
      args: [cAlgoAssetId, 0, mbrTxn, algoLendingContractClient.appId],
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
          amount: microAlgo(1000n),
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
    const { amount: contractAlgoBalanceBeforeDeposit } = await algod
      .accountInformation(algoLendingContractClient.appClient.appAddress)
      .do()
    const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(1000n),
      note: 'Funding algo contract',
    })
    feeTracker += 1000n

    const managerBalance = await algod.accountInformation(managerAccount.addr).do()
    console.log('Manager balance before algo deposit:', managerBalance.amount)
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

    const accountInfo = await algod.accountInformation(algoLendingContractClient.appAddress).do()
    expect(accountInfo).toBeDefined()
    //LST will be 1:1 with the deposit at this stage
    expect(accountInfo?.amount).toEqual(ALGO_DEPOSIT_AMOUNT + contractAlgoBalanceBeforeDeposit)
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
        args: [lstTokenId, baseTokenId, mbrTxn, xUSDLendingContractClient.appId],
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

  test('Borrow fails when request exceeds LTV', async () => {
    const borrower = depositors[0]
    algoLendingContractClient.algorand.setSignerFromAccount(borrower)
    localnet.algorand.setSignerFromAccount(borrower)

    const xusdState = await xUSDLendingContractClient.state.global.getAll()
    const cxusdId = xusdState.lstTokenId as bigint
    expect(cxusdId).toBeGreaterThan(0n)

    const boxValue = await getCollateralBoxValue(cxusdId, algoLendingContractClient, algoLendingContractClient.appId)
    expect(boxValue).toBeDefined()

    const algoPrice = await oracleAppClient.send.getTokenPrice({ args: [0n], assetReferences: [0n] })
    const xusdPrice = await oracleAppClient.send.getTokenPrice({
      args: [xUSDAssetId],
      assetReferences: [xUSDAssetId],
    })
    expect(algoPrice.return?.price).toBeDefined()
    expect(xusdPrice.return?.price).toBeDefined()

    const excessiveBorrowAmount = DEPOSITOR_INITIAL_BORROW_AMOUNT * 50n
    const collateralAmount = DEPOSITOR_INITIAL_COLLATERAL_AMOUNT

    const collateralTransfer = algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: borrower.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: cxusdId,
      amount: collateralAmount,
      note: 'Collateral for failing borrow',
    })

    const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: borrower.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(4000n),
      note: 'MBR for borrow attempt',
    })

    await expect(
      algoLendingContractClient
        .newGroup()
        .gas()
        .borrow({
          args: [
            collateralTransfer,
            excessiveBorrowAmount,
            collateralAmount,
            xUSDLendingContractClient.appId,
            cxusdId,
            mbrTxn,
          ],
          assetReferences: [cxusdId],
          appReferences: [xUSDLendingContractClient.appId, oracleAppClient.appId],
          boxReferences: [
            {
              appId: boxValue.boxRef.appIndex as bigint,
              name: boxValue.boxRef.name,
            },
          ],
          sender: borrower.addr,
        })
        .send(),
    ).rejects.toThrowError()

    await expect(
      getLoanRecordBoxValue(borrower.addr.toString(), algoLendingContractClient, algoLendingContractClient.appId),
    ).rejects.toThrowError()
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

        const feePoolBefore = globalsStateAlgo.feePool ?? 0n
        const { amount: adminBalanceBefore } = await algoLendingContractClient.algorand.client.algod
          .accountInformation(managerAccount.addr)
          .do()

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

        const { amount: algoContractBalanceBefore } = await algoLendingContractClient.algorand.client.algod
          .accountInformation(algoLendingContractClient.appClient.appAddress)
          .do()
        console.log('Algo contract balance before borrow:', algoContractBalanceBefore)

        const borrowerLSTBalanceInfo = await algoLendingContractClient.algorand.client.algod
          .accountAssetInformation(borrowerAccount.addr, cxusd)
          .do()
        console.log('Borrower cxusd balance before borrow:', borrowerLSTBalanceInfo.assetHolding?.amount)

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
        const globalStateAlgo = await algoLendingContractClient.state.global.getAll()
        const maxBorrow = globalStateAlgo.lastMaxBorrow
        console.log('Max borrow amount:', maxBorrow)
        const lastRequestedLoan = globalStateAlgo.lastRequestedLoan
        console.log('Last requested loan amount:', lastRequestedLoan)
        const theDiff = globalStateAlgo.debugDiff
        console.log('Debug diff:', theDiff)

        const globalState = await algoLendingContractClient.state.global.getAll()
        console.log('last scaled disbursed amount:', globalState.lastScaledDownDisbursement)

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

        /* const { amount: adminBalanceAfter } = await algoLendingContractClient.algorand.client.algod
          .accountInformation(managerAccount.addr)
          .do()
        const expectedOriginationFee = (borrowAmount * origination_fee_bps) / 10_000n
        //expect(BigInt(adminBalanceAfter) - BigInt(adminBalanceBefore)).toEqual(expectedOriginationFee - 1000n)

        const globalStateAfter = await algoLendingContractClient.state.global.getAll()
        const coount_loanRecords = globalStateAfter.activeLoanRecords
        console.log('Active loan records count:', coount_loanRecords)
        const feePoolAfter = globalStateAfter.feePool ?? 0n
        expect(feePoolAfter).toEqual(feePoolBefore + expectedOriginationFee)

        //check loan record box
        const loanRecordBoxValue = await getLoanRecordBoxValue(
          borrowerAccount.addr.toString(),
          algoLendingContractClient,
          algoLendingContractClient.appId,
        )

        console.log('Loan record box value:', loanRecordBoxValue)
        expect(loanRecordBoxValue).toBeDefined()

        // ----- Simulate time passing to accrue interest -----
        algoLendingContractClient.algorand.setSignerFromAccount(managerAccount)
        await algoLendingContractClient.send.setRateParams({
          args: {
            baseBps: 5000n,
            utilCapBps: 9000n,
            kinkNormBps: 5000n,
            slope1Bps: 2500n,
            slope2Bps: 4000n,
            maxAprBps: 8000n,
            emaAlphaBps: 0n,
            maxAprStepBps: 0n,
            rateModelType: 0n,
            powerGammaQ16: 0n,
            scarcityKBps: 0n,
            liqBonusBps: 500n,
          },
        })

        algoLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)
        const lastAccrualTimestamp = globalStateAfter.lastAccrualTs
        console.log('Last accrual timestamp:', lastAccrualTimestamp)
        const algodClient = algoLendingContractClient.algorand.client.algod
        /*         const status = await algodClient.status().do()
        await algodClient.statusAfterBlock(Number(status.lastRound) + 500).do() 

        await algoLendingContractClient.send.accrueLoanInterest({
          args: [borrowerAccount.addr.toString(), managerAccount.addr.toString()],
          sender: borrowerAccount.addr,
        })

        const globalsPostAccrual = await algoLendingContractClient.state.global.getAll()
        const loanPostAccrual = await getLoanRecordBoxValue(
          borrowerAccount.addr.toString(),
          algoLendingContractClient,
          algoLendingContractClient.appId,
        )
        console.log('Loan record after accrual:', loanPostAccrual)
        const lastDelta = globalsPostAccrual.deltaDebug
        console.log('Last delta:', lastDelta)
        const calcualtedWAD = globalsPostAccrual.calculateledSimpleWad!
        console.log('Calculated WAD:', calcualtedWAD)
        expect(globalsPostAccrual.totalBorrows).toBeGreaterThan(globalStateAfter.totalBorrows as bigint)

        expect(loanPostAccrual.principal).toBeGreaterThan(loanRecordBoxValue.principal)
        console.log(`Loan principal increased from ${loanRecordBoxValue.principal} to ${loanPostAccrual.principal}`)
        const feePoolPostAccrual = globalsPostAccrual.feePool ?? 0n
        expect(feePoolPostAccrual).toBeGreaterThan(feePoolAfter) */
      }
    }
  })

  test('withdraw platform fees - algo Lending Contract', async () => {
    algoLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    const { amount: adminBalanceBefore } = await algoLendingContractClient.algorand.client.algod
      .accountInformation(managerAccount.addr)
      .do()
    const globalState = await algoLendingContractClient.state.global.getAll()
    const feePool = globalState.feePool ?? 0n
    console.log('Fee pool before withdrawal:', feePool)
    expect(feePool).toBeGreaterThan(0n)

    const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(1000n),
      note: 'Funding fee withdrawal',
    })
    await algoLendingContractClient.send.withdrawPlatformFees({
      args: [managerAccount.addr.toString(), mbrTxn],
      sender: managerAccount.addr,
    })

    const globalStateAfter = await algoLendingContractClient.state.global.getAll()
    const feePoolAfter = globalStateAfter.feePool ?? 0n
    console.log('Fee pool after withdrawal:', feePoolAfter)
    expect(feePoolAfter).toEqual(0n)

    const { amount: adminBalanceAfter } = await algoLendingContractClient.algorand.client.algod
      .accountInformation(managerAccount.addr)
      .do()
    console.log('Admin balance before fee withdrawal:', adminBalanceBefore)
    console.log('Admin balance after fee withdrawal:', adminBalanceAfter)
    expect(adminBalanceAfter).toBeGreaterThan(adminBalanceBefore)
    expect(adminBalanceAfter).toEqual(adminBalanceBefore + feePool - 3000n) //subtract mbr
  })

  test('create new borrower and try to borrow more than ltv - algo Lending Contract', async () => {
    const borrowerAccount = await localnet.context.generateAccount({ initialFunds: microAlgo(10_000_000) })
    algoLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)

    const xusdContractGlobalState = await xUSDLendingContractClient.state.global.getAll()
    const cxusd: bigint = xusdContractGlobalState.lstTokenId as bigint
    const collateralAmount = 20_000_000n
    const depositAmount = 20_000_000n
    const borrowAmount = 24_000_000n // This is more than the LTV limit
    const lstAppId = xUSDLendingContractClient.appId
    const arc19String = 'this-is-a-test-arc19-metadata-string'
    const boxValue = await getCollateralBoxValue(cxusd, algoLendingContractClient, algoLendingContractClient.appId)
    localnet.algorand.setSignerFromAccount(borrowerAccount)
    algoLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)
    xUSDLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)

    //opt in to xusd and cxusd
    await algoLendingContractClient.algorand.send.assetOptIn({
      sender: borrowerAccount.addr,
      assetId: xUSDAssetId,
      note: 'Opting in to xUSD asset',
    })
    await algoLendingContractClient.algorand.send.assetOptIn({
      sender: borrowerAccount.addr,
      assetId: cxusd,
      note: 'Opting in to cxUSD asset',
    })

    //transfer small amount of xUSD
    await localnet.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: borrowerAccount.addr,
      assetId: xUSDAssetId,
      amount: 20_000_000n,
      note: 'Funding borrower with xUSD',
    })

    //deposit xUSD
    const globalState = await xUSDLendingContractClient.state.global.getAll()
    const lstTokenId = globalState.lstTokenId
    expect(lstTokenId).toBeDefined()

    if (lstTokenId) {
      await xUSDLendingContractClient.algorand.send.assetOptIn({
        sender: borrowerAccount.addr,
        assetId: lstTokenId,
        note: 'Opting in to cxUSD asset',
      })

      const depositTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
        sender: borrowerAccount.addr,
        receiver: xUSDLendingContractClient.appClient.appAddress,
        assetId: xUSDAssetId,
        amount: depositAmount,
        note: 'Depositing xUSD',
      })

      const mbrTxn2 = xUSDLendingContractClient.algorand.createTransaction.payment({
        sender: borrowerAccount.addr,
        receiver: xUSDLendingContractClient.appClient.appAddress,
        amount: microAlgo(1000n),
        note: 'Funding deposit',
      })

      await xUSDLendingContractClient.send.depositAsa({
        args: [depositTxn, depositAmount, mbrTxn2],
        assetReferences: [xUSDAssetId],
        sender: borrowerAccount.addr,
      })
    }

    const axferTxn = algoLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: borrowerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      assetId: cxusd,
      amount: collateralAmount,
      note: 'Depositing cxUSD collateral for borrowing',
    })
    const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
      sender: borrowerAccount.addr,
      receiver: algoLendingContractClient.appClient.appAddress,
      amount: microAlgo(4000n),
      note: 'Funding borrow',
    })
    const reserve = await localnet.context.generateAccount({ initialFunds: microAlgo(100000n) })

    await expect(
      algoLendingContractClient
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
        .send(),
    ).rejects.toThrow()

    const globalStateAfter = await algoLendingContractClient.state.global.getAll()
    const xusdGlobalState = await xUSDLendingContractClient.state.global.getAll()
    const maxBorrow = globalStateAfter.lastMaxBorrow
    console.log('Max borrow amount:', maxBorrow)
    const lastRequestedLoan = globalStateAfter.lastRequestedLoan
    console.log('Last requested loan amount:', lastRequestedLoan)

    const totalDeposits = xusdGlobalState.totalDeposits
    const circulatingcXUSD = xusdGlobalState.circulatingLst
    console.log('Total deposits:', totalDeposits)
    console.log('Circulating cXUSD:', circulatingcXUSD)
  })

  test.skip('top up existing loans - algo Lending Contract (index model assertions)', async () => {
    const borrowAmount = DEPOSITOR_SECONDARY_BORROW_AMOUNT

    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const borrowerAccount = depositors[i]
      algoLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)
      let feeTracker = 0n

      // ── Read xUSD LST (collateral) setup ──────────────────────────────────
      const globalStateXUSDContract = await xUSDLendingContractClient.state.global.getAll()
      const cxusd: bigint = globalStateXUSDContract.lstTokenId as bigint
      const lstAppId = xUSDLendingContractClient.appId
      expect(cxusd).toBeDefined()
      expect(cxusd).toBeGreaterThan(0n)

      // ── Prices ────────────────────────────────────────────────────────────
      const algoPrice = await oracleAppClient.send.getTokenPrice({ args: [0n], assetReferences: [0n] })
      const xUSDPrice = await oracleAppClient.send.getTokenPrice({
        args: [xUSDAssetId],
        assetReferences: [xUSDAssetId],
      })
      expect(algoPrice.return?.price).toBeDefined()
      expect(xUSDPrice.return?.price).toBeDefined()

      // ── Collateral box sanity ─────────────────────────────────────────────
      const boxValue = await getCollateralBoxValue(cxusd, algoLendingContractClient, algoLendingContractClient.appId)
      expect(boxValue).toBeDefined()
      expect(boxValue.assetId).toEqual(cxusd)
      expect(boxValue.baseAssetId).toEqual(xUSDAssetId)

      // ── Txns for borrow (collateral axfer is 0 for top-up) ────────────────
      const axferTxn = algoLendingContractClient.algorand.createTransaction.assetTransfer({
        sender: borrowerAccount.addr,
        receiver: algoLendingContractClient.appClient.appAddress,
        assetId: cxusd,
        amount: 0n,
        note: 'Top-up: 0 collateral',
      })
      feeTracker += 1000n

      const mbrTxn = algoLendingContractClient.algorand.createTransaction.payment({
        sender: borrowerAccount.addr,
        receiver: algoLendingContractClient.appClient.appAddress,
        amount: microAlgo(4000n),
        note: 'Funding borrow fees',
      })
      feeTracker += 5000n

      const lrBefore = await getLoanRecordBoxValue(
        borrowerAccount.addr.toString(),
        algoLendingContractClient,
        algoLendingContractClient.appId,
      )
      console.log('lrBefore:', lrBefore)
      const priorPrincipal = lrBefore.principal
      const priorUserIdx = lrBefore.userIndexWad
      const priorCollateral = lrBefore.collateralAmount

      const globalBefore = await algoLendingContractClient.state.global.getAll()
      console.log('globalBefore:', globalBefore)
      const borrowIndexBefore = globalBefore.borrowIndexWad as bigint // new global you added
      const totalBorrowsBefore = globalBefore.totalBorrows as bigint

      const totalDepositsBefore = globalBefore.totalDeposits as bigint

      // Compute borrower live debt BEFORE (using index model)
      const INDEX_SCALE = 1_000_000_000_000n
      const liveDebtFromSnapshot = (principal: bigint, userIndexWad: bigint, borrowIndexWad: bigint) =>
        principal === 0n ? 0n : (principal * borrowIndexWad) / userIndexWad
      const liveDebtBefore = liveDebtFromSnapshot(priorPrincipal, priorUserIdx, borrowIndexBefore)

      const feePoolBefore = globalBefore.feePool ?? 0n
      const { amount: adminBalanceBefore } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(managerAccount.addr)
        .do()

      const collateralPriceReturn = await algoLendingContractClient.send.calculateCollateralValueUsd({
        args: [cxusd, priorCollateral, lstAppId],
        sender: borrowerAccount.addr,
      })
      const cxusdPrice =
        collateralPriceReturn?.returns && collateralPriceReturn.returns.length > 0
          ? (collateralPriceReturn.returns[0].returnValue as bigint)
          : 0

      // Also pre-compute expected disbursement (fee-inclusive)
      const preCalculated = calculateDisbursement({
        collateralAmount: priorCollateral,
        collateralPrice: cxusdPrice || 0n, // cxUSD price
        ltvBps: ltv_bps,
        baseTokenPrice: algoPrice.return?.price || 0n, // ALGO price
        requestedLoanAmount: borrowAmount,
        originationFeeBps: origination_fee_bps,
      })
      console.log('preCalculated top-up disbursement:', preCalculated)
      expect(preCalculated.allowed).toBe(true)

      const { amount: algoBalanceBefore } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(borrowerAccount.addr)
        .do()

      // ── TOUCH: perform the top-up borrow (contract will accrue market first) ─
      await algoLendingContractClient
        .newGroup()
        .gas()
        .borrow({
          args: [axferTxn, borrowAmount, 0n, lstAppId, cxusd, mbrTxn],
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

      // ── Post-borrow checks ────────────────────────────────────────────────
      const { amount: algoBalanceAfter } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(borrowerAccount.addr)
        .do()
      const diff = algoBalanceAfter - algoBalanceBefore + feeTracker
      expect(diff).toEqual(preCalculated.disbursement)

      const globalAfter = await algoLendingContractClient.state.global.getAll()
      console.log('globalAfter:', globalAfter)
      const borrowIndexAfter = globalAfter.borrowIndexWad as bigint
      const totalBorrowsAfter = globalAfter.totalBorrows as bigint
      const feePoolAfter = globalAfter.feePool ?? 0n

      // 1) Market-level assertions
      // Borrow index should be >= (it advances if Δt>0; equal if Δt==0 within same block/second)
      expect(borrowIndexAfter).toBeGreaterThanOrEqual(borrowIndexBefore)

      // totalBorrows should increase by the *disbursement* (principal added)
      expect(totalBorrowsAfter - totalBorrowsBefore).toEqual(preCalculated.disbursement)

      const expectedOriginationFee = (borrowAmount * origination_fee_bps) / 10_000n
      expect(feePoolAfter).toEqual(feePoolBefore + expectedOriginationFee)

      const { amount: adminBalanceAfter } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(managerAccount.addr)
        .do()
      expect(BigInt(adminBalanceAfter) - BigInt(adminBalanceBefore)).toEqual(expectedOriginationFee - 1000n)

      // 2) Borrower snapshot assertions
      const lrAfter = await getLoanRecordBoxValue(
        borrowerAccount.addr.toString(),
        algoLendingContractClient,
        algoLendingContractClient.appId,
      )

      // New principal should be: liveDebtBefore + disbursement
      const expectedNewPrincipal = liveDebtBefore + preCalculated.disbursement
      expect(lrAfter.principal).toEqual(expectedNewPrincipal)

      // userIndexWad should resnapshot to the *current* market index
      expect(lrAfter.userIndexWad).toEqual(borrowIndexAfter)

      // Optional: sanity log
      console.log({
        borrowIndexBefore,
        borrowIndexAfter,
        totalBorrowsBefore,
        totalBorrowsAfter,
        priorPrincipal,
        priorUserIdx,
        liveDebtBefore,
        disbursement: preCalculated.disbursement,
        newPrincipal: lrAfter.principal,
        newUserIdx: lrAfter.userIndexWad,
      })
    }
  })

  test('repay 25% of loan', async () => {
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const borrowerAccount = depositors[i]
      algoLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)

      const loanRecord = await getLoanRecordBoxValue(
        borrowerAccount.addr.toString(),
        algoLendingContractClient,
        algoLendingContractClient.appId,
      )

      const amountToRepay = loanRecord.principal / 4n
      console.log('amountToRepay:', amountToRepay)
      console.log('principal:', loanRecord.principal)

      const repayTxn = algoLendingContractClient.algorand.createTransaction.payment({
        receiver: algoLendingContractClient.appAddress,
        amount: AlgoAmount.MicroAlgo(amountToRepay),
        sender: borrowerAccount.addr,
      })

      // check borrowers current algo balance
      const { amount: algoBalanceBefore } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(borrowerAccount.addr)
        .do()
      console.log('algoBalanceBefore:', algoBalanceBefore)

      // check borrowers lst balance before
      const lstBalanceBeforeRequest = await algoLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, loanRecord.collateralTokenId)
        .do()
      const lstBalanceBefore = lstBalanceBeforeRequest.assetHolding?.amount || BigInt(0)

      const result = await algoLendingContractClient
        .newGroup()
        .repayLoanAlgo({
          args: [repayTxn, amountToRepay],
          sender: borrowerAccount.addr,
        })
        .send({ populateAppCallResources: true })

      const totalFeesPaid = result.transactions.reduce((acc, tx) => acc + Number(tx.fee), 0)
      console.log('totalFeesPaid:', totalFeesPaid)

      const { amount: algoBalanceAfter } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(borrowerAccount.addr)
        .do()
      console.log('algoBalanceAfter:', algoBalanceAfter)
      expect(algoBalanceAfter).toBe(algoBalanceBefore - amountToRepay - BigInt(totalFeesPaid))

      const lstBalanceAfterRequest = await algoLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, loanRecord.collateralTokenId)
        .do()
      const lstBalanceAfter = lstBalanceAfterRequest.assetHolding?.amount || BigInt(0)
      expect(lstBalanceAfter).toBe(lstBalanceBefore) // no collateral removal automatically unless loan closed out
    }
  })

  test('withdraw max safe collateral', async () => {
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const borrowerAccount = depositors[i]
      const loanRecord = await getLoanRecordBoxValue(
        borrowerAccount.addr.toString(),
        algoLendingContractClient,
        algoLendingContractClient.appId,
      )

      // get the max removable collateral
      const maxSafeCollateralResult = await algoLendingContractClient.send.maxWithdrawableCollateralLst({
        args: [xUSDLendingContractClient.appId],
        sender: borrowerAccount.addr,
      })
      const maxSafeCollateral = maxSafeCollateralResult.return as bigint

      console.log('maxSafeCollateral:', maxSafeCollateral)
      expect(maxSafeCollateral).toBeLessThanOrEqual(loanRecord.collateralAmount)
      const collateralBoxValue = await getCollateralBoxValue(
        loanRecord.collateralTokenId,
        algoLendingContractClient,
        algoLendingContractClient.appId,
      )

      console.log('collateralBoxValue:', collateralBoxValue)
      expect(collateralBoxValue.totalCollateral).toBeGreaterThanOrEqual(maxSafeCollateral)
      const lstBalanceBeforeRequest = await algoLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, loanRecord.collateralTokenId)
        .do()
      const lstBalanceBefore = lstBalanceBeforeRequest.assetHolding?.amount || BigInt(0)

      await algoLendingContractClient
        .newGroup()
        .gas()
        .withdrawCollateral({
          args: [maxSafeCollateral, loanRecord.collateralTokenId, xUSDLendingContractClient.appId],
          sender: borrowerAccount.addr,
        })
        .send()

      const lstBalanceAfterRequest = await algoLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, loanRecord.collateralTokenId)
        .do()
      const lstBalanceAfter = lstBalanceAfterRequest.assetHolding?.amount || BigInt(0)

      expect(lstBalanceAfter).toBe(lstBalanceBefore + maxSafeCollateral)
    }
  })

  test('repay and close loan', async () => {
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const borrowerAccount = depositors[i]
      const loanRecord = await getLoanRecordBoxValue(
        borrowerAccount.addr.toString(),
        algoLendingContractClient,
        algoLendingContractClient.appId,
      )
      const currentDebt = loanRecord.principal
      const { amount: algoBalanceBefore } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(borrowerAccount.addr)
        .do()
      const lstBalanceBeforeRequest = await algoLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, loanRecord.collateralTokenId)
        .do()
      const lstBalanceBefore = lstBalanceBeforeRequest.assetHolding?.amount || BigInt(0)

      const payTxn = algoLendingContractClient.algorand.createTransaction.payment({
        receiver: algoLendingContractClient.appAddress,
        amount: AlgoAmount.MicroAlgos(currentDebt),
        sender: borrowerAccount.addr,
      })
      const result = await algoLendingContractClient.send.repayLoanAlgo({
        args: [payTxn, currentDebt],
        sender: borrowerAccount.addr,
      })

      const totalFees = result.transactions.reduce((sum, txn) => sum + Number(txn.fee), 0)

      const { amount: algoBalanceAfter } = await algoLendingContractClient.algorand.client.algod
        .accountInformation(borrowerAccount.addr)
        .do()
      expect(algoBalanceAfter).toBeLessThan(algoBalanceBefore)
      expect(algoBalanceAfter).toBe(algoBalanceBefore - currentDebt - BigInt(totalFees))
      const lstBalanceAfterRequest = await algoLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, loanRecord.collateralTokenId)
        .do()
      const lstBalanceAfter = lstBalanceAfterRequest.assetHolding?.amount || BigInt(0)
      expect(lstBalanceAfter).toBeGreaterThan(lstBalanceBefore) // collateral returned on loan closure
      expect(lstBalanceAfter).toBe(lstBalanceBefore + loanRecord.collateralAmount)
    }
  })
})
