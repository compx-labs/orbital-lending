/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { Account } from 'algosdk'
import { calculateDisbursement, getCollateralBoxValue, getLoanRecordBoxValue, getLoanRecordBoxValueASA } from './testing-utils'
import { OracleClient } from '../artifacts/Oracle/oracleClient'
import { createToken } from './token-create'
import { deployOracle } from '../Oracle/oracle-deploy'
import { OrbitalLendingAsaClient } from '../artifacts/orbital_lending/orbital-lending-asaClient'
import { deploy as deployAsa } from './orbital-deploy-asa'
let xUSDLendingContractClient: OrbitalLendingAsaClient
let collateralLendingContractClient: OrbitalLendingAsaClient
let oracleAppClient: OracleClient
let managerAccount: Account

let xUSDAssetId = 0n
let collateralAssetId = 0n
let collateralLstAssetId = 0n
const INIT_CONTRACT_AMOUNT = 400000n
const ltv_bps = 2500n
const liq_threshold_bps = 1000000n
const liq_bonus_bps = 500n
const origination_fee_bps = 1000n
const protocol_interest_fee_bps = 1000n
const additional_rewards_commission_percentage = 8n

const NUM_DEPOSITORS = 1
const DEPOSITOR_XUSD_INITIAL_BALANCE = 50_000_000_000n
const DEPOSITOR_INITIAL_DEPOSIT_AMOUNT = 20_000_000_000n
const DEPOSITOR_INITIAL_WITHDRAW_AMOUNT = 5n
const DEPOSITOR_INITIAL_BORROW_AMOUNT = 10_000_000_000n
const DEPOSITOR_INITIAL_COLLATERAL_AMOUNT = 19_000_000_000n

const COLLATERAL_DEPOSIT_AMOUNT = 50_000_000_000n

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
    collateralAssetId = await createToken(managerAccount, 'xCOL', 6)

    xUSDLendingContractClient = await deployAsa(xUSDAssetId, managerAccount)
    collateralLendingContractClient = await deployAsa(collateralAssetId, managerAccount)
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

  test('orbital initialization - collateral ASA client', async () => {
    expect(collateralLendingContractClient).toBeDefined()

    const payTxn = collateralLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: collateralLendingContractClient.appClient.appAddress,
      amount: microAlgo(INIT_CONTRACT_AMOUNT),
      note: 'Funding collateral contract',
    })

    await collateralLendingContractClient.send.initApplication({
      args: [
        payTxn,
        ltv_bps,
        liq_threshold_bps,
        liq_bonus_bps,
        origination_fee_bps,
        protocol_interest_fee_bps,
        oracleAppClient.appId,
        collateralAssetId,
        additional_rewards_commission_percentage,
      ],
    })

    const mbrTxn = collateralLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: collateralLendingContractClient.appClient.appAddress,
      amount: microAlgo(102000n),
      note: 'Funding collateral contract',
    })

    await collateralLendingContractClient.send.generateLstToken({
      args: [mbrTxn],
    })

    const globalState = await collateralLendingContractClient.state.global.getAll()
    expect(globalState).toBeDefined()
    expect(globalState.baseTokenId).toEqual(collateralAssetId)
    expect(globalState.ltvBps).toEqual(ltv_bps)
    expect(globalState.liqThresholdBps).toEqual(liq_threshold_bps)
    expect(globalState.originationFeeBps).toEqual(origination_fee_bps)
    expect(globalState.protocolShareBps).toEqual(protocol_interest_fee_bps)
    expect(globalState.lstTokenId).toBeDefined()
    collateralLstAssetId = globalState.lstTokenId ?? 0n
    expect(collateralLstAssetId).toBeGreaterThan(0n)

    await collateralLendingContractClient.send.setContractState({ args: { state: 1n } })
  })

  test('add new collateral - xUSD Lending Contract - collateral ASA', async () => {
    const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(101000n),
      note: 'Funding collateral addition',
    })

    const boxNames = await xUSDLendingContractClient.appClient.getBoxNames()
    console.log('Box names before:', boxNames)

    await xUSDLendingContractClient.send.addNewCollateralType({
      args: [collateralLstAssetId, collateralAssetId, mbrTxn, collateralLendingContractClient.appId],
      assetReferences: [collateralLstAssetId],
    })

    const boxValue = await getCollateralBoxValue(
      collateralLstAssetId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )
    expect(boxValue).toBeDefined()
    expect(boxValue.assetId).toEqual(collateralLstAssetId)
    expect(boxValue.marketBaseAssetId).toEqual(xUSDAssetId)
    expect(boxValue.baseAssetId).toEqual(collateralAssetId)
    expect(boxValue.totalCollateral).toEqual(0n)
  })

  test('Add collateral token price to oracle', async () => {
    const price = 215000n // Example price for collateral ASA
    await oracleAppClient.send.addTokenListing({
      args: [collateralAssetId, price],
      assetReferences: [collateralAssetId],
    })
  })
  test('Add xusd price to oracle', async () => {
    const price = 1_000_000n // Example price for xusd
    await oracleAppClient.send.addTokenListing({
      args: [xUSDAssetId, price],
      assetReferences: [xUSDAssetId],
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

  test('manager deposit collateral ASA to contract - collateral Lending Contract', async () => {
    const algod = collateralLendingContractClient.algorand.client.algod

    const globalState = await collateralLendingContractClient.state.global.getAll()
    const lstTokenId = globalState.lstTokenId as bigint
    expect(lstTokenId).toBeGreaterThan(0n)

    await collateralLendingContractClient.algorand.send.assetOptIn({
      sender: managerAccount.addr,
      assetId: lstTokenId,
      note: 'Opting in to collateral LST',
    })

    const managerCollateralBeforeInfo = await algod.accountAssetInformation(managerAccount.addr, collateralAssetId).do()
    const managerCollateralBefore = managerCollateralBeforeInfo.assetHolding?.amount || 0n

    const contractCollateralBeforeInfo = await algod
      .accountAssetInformation(collateralLendingContractClient.appClient.appAddress, collateralAssetId)
      .do()
    const contractCollateralBefore = contractCollateralBeforeInfo.assetHolding?.amount || 0n

    const mbrTxn = collateralLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: collateralLendingContractClient.appClient.appAddress,
      amount: microAlgo(1000n),
      note: 'Funding collateral deposit',
    })

    const depositTxn = collateralLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: managerAccount.addr,
      receiver: collateralLendingContractClient.appClient.appAddress,
      assetId: collateralAssetId,
      amount: COLLATERAL_DEPOSIT_AMOUNT,
      note: 'Depositing collateral ASA',
    })

    await collateralLendingContractClient.send.depositAsa({
      args: [depositTxn, COLLATERAL_DEPOSIT_AMOUNT, mbrTxn],
      assetReferences: [collateralAssetId],
      sender: managerAccount.addr,
    })

    const managerCollateralAfterInfo = await algod.accountAssetInformation(managerAccount.addr, collateralAssetId).do()
    const managerCollateralAfter = managerCollateralAfterInfo.assetHolding?.amount || 0n
    expect(managerCollateralAfter).toEqual(managerCollateralBefore - COLLATERAL_DEPOSIT_AMOUNT)

    const contractCollateralAfterInfo = await algod
      .accountAssetInformation(collateralLendingContractClient.appClient.appAddress, collateralAssetId)
      .do()
    const contractCollateralAfter = contractCollateralAfterInfo.assetHolding?.amount || 0n
    expect(contractCollateralAfter).toEqual(contractCollateralBefore + COLLATERAL_DEPOSIT_AMOUNT)

    const managerLstBalanceInfo = await algod.accountAssetInformation(managerAccount.addr, lstTokenId).do()
    const managerLstBalance = managerLstBalanceInfo.assetHolding?.amount || 0n
    expect(managerLstBalance).toBeGreaterThanOrEqual(DEPOSITOR_INITIAL_COLLATERAL_AMOUNT * BigInt(NUM_DEPOSITORS))

    for (const depositor of depositors) {
      collateralLendingContractClient.algorand.setSignerFromAccount(depositor)
      await collateralLendingContractClient.algorand.send.assetOptIn({
        sender: depositor.addr,
        assetId: lstTokenId,
        note: 'Opting in to collateral LST',
      })

      await collateralLendingContractClient.algorand.send.assetTransfer({
        sender: managerAccount.addr,
        receiver: depositor.addr,
        assetId: lstTokenId,
        amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
        note: 'Funding depositor with collateral LST',
      })
    }
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

  test('Borrow fails when request exceeds LTV on ASA market', async () => {
    const borrower = depositors[0]
    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    localnet.algorand.setSignerFromAccount(borrower)

    const collateralState = await collateralLendingContractClient.state.global.getAll()
    const collateralLstId = collateralState.lstTokenId as bigint
    expect(collateralLstId).toBeGreaterThan(0n)

    const boxValue = await getCollateralBoxValue(
      collateralLstId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )
    expect(boxValue).toBeDefined()

    const collateralPrice = await oracleAppClient.send.getTokenPrice({
      args: [collateralAssetId],
      assetReferences: [collateralAssetId],
    })
    const xusdPrice = await oracleAppClient.send.getTokenPrice({
      args: [xUSDAssetId],
      assetReferences: [xUSDAssetId],
    })
    expect(collateralPrice.return?.price).toBeDefined()
    expect(xusdPrice.return?.price).toBeDefined()

    const excessiveBorrowAmount = DEPOSITOR_INITIAL_BORROW_AMOUNT * 50n
    const collateralAmount = DEPOSITOR_INITIAL_COLLATERAL_AMOUNT

    const collateralTransfer = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: borrower.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: collateralLstId,
      amount: collateralAmount,
      note: 'Collateral for failing borrow',
    })

    const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: borrower.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(4000n),
      note: 'MBR for borrow attempt',
    })

    await expect(
      xUSDLendingContractClient
        .newGroup()
        .gas()
        .borrow({
          args: [
            collateralTransfer,
            excessiveBorrowAmount,
            collateralAmount,
            collateralLendingContractClient.appId,
            collateralLstId,
            mbrTxn,
          ],
          assetReferences: [collateralLstId],
          appReferences: [collateralLendingContractClient.appId, oracleAppClient.appId],
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
      getLoanRecordBoxValueASA(borrower.addr.toString(), xUSDLendingContractClient, xUSDLendingContractClient.appId),
    ).rejects.toThrowError()
  })

  test('Borrow xUSD with collateral LST - ASA Lending Contract', async () => {
    const borrowAmount = DEPOSITOR_INITIAL_BORROW_AMOUNT
    const collateralAmount = DEPOSITOR_INITIAL_COLLATERAL_AMOUNT
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const borrowerAccount = depositors[i]
      xUSDLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)

      const collateralState = await collateralLendingContractClient.state.global.getAll()
      const collateralLstId: bigint = collateralState.lstTokenId as bigint
      const lstAppId = collateralLendingContractClient.appId
      expect(collateralLstId).toBeGreaterThan(0n)

      const collateralPrice = await oracleAppClient.send.getTokenPrice({
        args: [collateralAssetId],
        assetReferences: [collateralAssetId],
      })
      expect(collateralPrice.return?.price).toBeDefined()
      const xUSDPrice = await oracleAppClient.send.getTokenPrice({
        args: [xUSDAssetId],
        assetReferences: [xUSDAssetId],
      })

      const borrowerXusdBalanceBeforeInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, xUSDAssetId)
        .do()
      const borrowerXusdBalanceBefore = borrowerXusdBalanceBeforeInfo.assetHolding?.amount || 0n

      const boxValue = await getCollateralBoxValue(
        collateralLstId,
        xUSDLendingContractClient,
        xUSDLendingContractClient.appId,
      )
      expect(boxValue).toBeDefined()

      const collateralTransfer = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
        sender: borrowerAccount.addr,
        receiver: xUSDLendingContractClient.appClient.appAddress,
        assetId: collateralLstId,
        amount: collateralAmount,
        note: 'Depositing collateral LST for borrowing',
      })

      const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
        sender: borrowerAccount.addr,
        receiver: xUSDLendingContractClient.appClient.appAddress,
        amount: microAlgo(4000n),
        note: 'Funding borrow',
      })

      const contractXusdBalanceBeforeInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
        .do()
      const contractXusdBalanceBefore = contractXusdBalanceBeforeInfo.assetHolding?.amount || 0n

      const collateralPriceReturn = await xUSDLendingContractClient.send.calculateCollateralValueUsd({
        args: [collateralLstId, collateralAmount, lstAppId],
        sender: borrowerAccount.addr,
      })
      const collateralValueUsd =
        collateralPriceReturn?.returns && collateralPriceReturn.returns.length > 0
          ? (collateralPriceReturn.returns[0].returnValue as bigint)
          : 0n

      await xUSDLendingContractClient
        .newGroup()
        .gas()
        .borrow({
          args: [collateralTransfer, borrowAmount, collateralAmount, lstAppId, collateralLstId, mbrTxn],
          assetReferences: [collateralLstId],
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

      const borrowerXusdBalanceAfterInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, xUSDAssetId)
        .do()
      const borrowerXusdBalanceAfter = borrowerXusdBalanceAfterInfo.assetHolding?.amount || 0n
      expect(borrowerXusdBalanceAfter).toBeGreaterThan(borrowerXusdBalanceBefore)

      const disbursementCalc = calculateDisbursement({
        collateralAmount,
        collateralPrice: collateralValueUsd,
        ltvBps: ltv_bps,
        baseTokenPrice: xUSDPrice.return?.price || 0n,
        requestedLoanAmount: borrowAmount,
        originationFeeBps: origination_fee_bps,
      })
      expect(borrowerXusdBalanceAfter - borrowerXusdBalanceBefore).toEqual(disbursementCalc.disbursement)

      const contractXusdBalanceAfterInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
        .do()
      const contractXusdBalanceAfter = contractXusdBalanceAfterInfo.assetHolding?.amount || 0n
      expect(contractXusdBalanceBefore - contractXusdBalanceAfter).toEqual(disbursementCalc.disbursement)

      const globalStateAfter = await xUSDLendingContractClient.state.global.getAll()
      expect(globalStateAfter.totalBorrows).toBeGreaterThan(disbursementCalc.disbursement - 1n)

      const loanRecord = await getLoanRecordBoxValueASA(
        borrowerAccount.addr.toString(),
        xUSDLendingContractClient,
        xUSDLendingContractClient.appId,
      )
      expect(loanRecord).toBeDefined()
      expect(loanRecord.principal).toEqual(disbursementCalc.disbursement)
    }
  })

  test('withdraw platform fees - ASA Lending Contract', async () => {
    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    const managerXusdBeforeInfo = await xUSDLendingContractClient.algorand.client.algod
      .accountAssetInformation(managerAccount.addr, xUSDAssetId)
      .do()
    const managerXusdBefore = managerXusdBeforeInfo.assetHolding?.amount || 0n

    const globalState = await xUSDLendingContractClient.state.global.getAll()
    const feePool = globalState.feePool ?? 0n
    console.log('Fee pool before withdrawal:', feePool)
    expect(feePool).toBeGreaterThan(0n)

    const mbrTxn = xUSDLendingContractClient.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(1000n),
      note: 'Funding fee withdrawal',
    })
    await xUSDLendingContractClient.send.withdrawPlatformFees({
      args: [managerAccount.addr.toString(), mbrTxn],
      sender: managerAccount.addr,
    })

    const globalStateAfter = await xUSDLendingContractClient.state.global.getAll()
    const feePoolAfter = globalStateAfter.feePool ?? 0n
    console.log('Fee pool after withdrawal:', feePoolAfter)
    expect(feePoolAfter).toEqual(0n)

    const managerXusdAfterInfo = await xUSDLendingContractClient.algorand.client.algod
      .accountAssetInformation(managerAccount.addr, xUSDAssetId)
      .do()
    const managerXusdAfter = managerXusdAfterInfo.assetHolding?.amount || 0n
    console.log('Manager xUSD before fee withdrawal:', managerXusdBefore)
    console.log('Manager xUSD after fee withdrawal:', managerXusdAfter)
    expect(managerXusdAfter).toEqual(managerXusdBefore + feePool)
  })
})
