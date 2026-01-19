/* eslint-disable @typescript-eslint/no-unused-vars */
import { Config, microAlgo } from '@algorandfoundation/algokit-utils'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, describe, expect, test } from 'vitest'

import { Account } from 'algosdk'
import {
  calculateDisbursement,
  computeBuyoutTerms,
  getCollateralBoxValue,
  getLoanRecordBoxValue,
  getLoanRecordBoxValueASA,
  liveDebtFromSnapshot,
} from './testing-utils'
import { OracleClient } from '../artifacts/Oracle/oracleClient'
import { createToken } from './token-create'
import { deployOracle } from '../Oracle/oracle-deploy'
import { OrbitalLendingAsaClient } from '../artifacts/orbital_lending/orbital-lending-asaClient'
import { deploy as deployAsa } from './orbital-deploy-asa'
import { FluxGateClient } from '../fluxOracle/flux-gateClient'
import { deploy as deployFluxOracle } from '../fluxOracle/deploy'
let xUSDLendingContractClient: OrbitalLendingAsaClient
let collateralLendingContractClient: OrbitalLendingAsaClient
let fluxOracleAppClient: FluxGateClient
let oracleAppClient: OracleClient
let managerAccount: Account

let xUSDAssetId = 0n
let collateralAssetId = 0n
let collateralLstAssetId = 0n
const INIT_CONTRACT_AMOUNT = 10_000_000n
const MAX_FEE = 250_000n

const ltv_bps = 2500n
const liq_threshold_bps = 1000000n
const liq_bonus_bps = 500n
const origination_fee_bps = 1000n
const protocol_interest_fee_bps = 1000n
const additional_rewards_commission_percentage = 8n
const USER_TIER = 0n

const NUM_DEPOSITORS = 1
const DEPOSITOR_XUSD_INITIAL_BALANCE = 50_000_000_000n
const DEPOSITOR_INITIAL_DEPOSIT_AMOUNT = 20_000_000_000n
const DEPOSITOR_INITIAL_WITHDRAW_AMOUNT = 5n
const DEPOSITOR_INITIAL_BORROW_AMOUNT = 10_000_000_000n
const DEPOSITOR_INITIAL_COLLATERAL_AMOUNT = 19_000_000_000n

const COLLATERAL_DEPOSIT_AMOUNT = 50_000_000_000n
const COLLATERAL_ORACLE_PRICE = 3_500_000n
const COLLATERAL_LIQUIDATION_PRICE = 1_000n

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
    fluxOracleAppClient = await deployFluxOracle({ deployer: managerAccount })

    console.log('fluxOracleAppClient.appAddress', fluxOracleAppClient.appAddress)
    const mbrTxn = await localnet.algorand.createTransaction.payment({
      sender: managerAccount.addr,
      receiver: fluxOracleAppClient.appAddress,
      amount: microAlgo(400_000),
    })

    fluxOracleAppClient.algorand.setSignerFromAccount(managerAccount)

    await fluxOracleAppClient.send.initApplication({
      sender: managerAccount.addr,
      args: {
        mbrTxn,
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
        ltvBps: ltv_bps,
        liqThresholdBps: liq_threshold_bps,
        originationFeeBps: origination_fee_bps,
        protocolShareBps: protocol_interest_fee_bps,
        oracleAppId: oracleAppClient.appId,
        buyoutTokenId: xUSDAssetId,
        additionalRewardsCommissionPercentage: additional_rewards_commission_percentage,
        fluxOracleAppId: fluxOracleAppClient.appId,
      },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    await xUSDLendingContractClient.algorand.send.payment({
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
    expect(globalState.lstTokenId).not.toEqual(99n)

    await xUSDLendingContractClient.send.setContractState({ args: { state: 1n } })
  })

  test('orbital initialization - collateral ASA client', async () => {
    expect(collateralLendingContractClient).toBeDefined()

    await collateralLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: collateralLendingContractClient.appClient.appAddress,
      amount: microAlgo(INIT_CONTRACT_AMOUNT),
      note: 'Funding collateral contract',
    })

    await collateralLendingContractClient.send.initApplication({
      args: {
        ltvBps: ltv_bps,
        liqThresholdBps: liq_threshold_bps,
        originationFeeBps: origination_fee_bps,
        protocolShareBps: protocol_interest_fee_bps,
        oracleAppId: oracleAppClient.appId,
        buyoutTokenId: xUSDAssetId,
        additionalRewardsCommissionPercentage: additional_rewards_commission_percentage,
        fluxOracleAppId: fluxOracleAppClient.appId,
      },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    await collateralLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: collateralLendingContractClient.appClient.appAddress,
      amount: microAlgo(102000n),
      note: 'Funding collateral contract',
    })

    await collateralLendingContractClient.send.generateLstToken({
      args: {},
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
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
    await xUSDLendingContractClient.algorand.send.payment({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      amount: microAlgo(101000n),
      note: 'Funding collateral addition',
    })

    const boxNames = await xUSDLendingContractClient.appClient.getBoxNames()
    console.log('Box names before:', boxNames)

    await xUSDLendingContractClient.send.addNewCollateralType({
      args: [collateralLstAssetId, collateralAssetId, collateralLendingContractClient.appId],
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
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
    await oracleAppClient.send.addTokenListing({
      args: [collateralAssetId, COLLATERAL_ORACLE_PRICE],
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
          maxFee: microAlgo(MAX_FEE),
          coverAppCallInnerTransactionFees: true,
          populateAppCallResources: true,
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
          args: { assetTransferTxn: depositTxn, amount: depositAmount },
          sender: depositorAccount.addr,
          maxFee: microAlgo(MAX_FEE),
          coverAppCallInnerTransactionFees: true,
          populateAppCallResources: true,
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
          args: { amount: withdrawAmount, assetTransferTxn: axferTxn, lstAppId: xUSDLendingContractClient.appId },
          assetReferences: [lstTokenId],
          appReferences: [xUSDLendingContractClient.appId],
          sender: depositorAccount.addr,
          maxFee: microAlgo(MAX_FEE),
          coverAppCallInnerTransactionFees: true,
          populateAppCallResources: true,
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

  test('withdraw more LST than personal deposit record (extra LST acquired externally) - ASA contract', async () => {
    const user = await localnet.context.generateAccount({ initialFunds: microAlgo(6_000_000) })
    const donor = await localnet.context.generateAccount({ initialFunds: microAlgo(6_000_000) })
    const algod = xUSDLendingContractClient.algorand.client.algod

    const globalState = await xUSDLendingContractClient.state.global.getAll()
    const lstTokenId = globalState.lstTokenId as bigint
    expect(lstTokenId).toBeGreaterThan(0n)

    // Opt in user & donor to base asset (xUSD) and LST
    xUSDLendingContractClient.algorand.setSignerFromAccount(user)
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: user.addr,
      assetId: xUSDAssetId,
      note: 'Opt user into xUSD for over-burn test',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: user.addr,
      assetId: lstTokenId,
      note: 'Opt user into LST for over-burn test',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
    xUSDLendingContractClient.algorand.setSignerFromAccount(donor)
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: donor.addr,
      assetId: xUSDAssetId,
      note: 'Opt donor into xUSD for over-burn test',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: donor.addr,
      assetId: lstTokenId,
      note: 'Opt donor into LST for over-burn test',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    // Fund user and donor with xUSD to cover deposits + fees
    const userDeposit = 1_000_000n
    const donorDeposit = 500_000n
    const fundBuffer = 1_000_000n
    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: user.addr,
      assetId: xUSDAssetId,
      amount: userDeposit + fundBuffer,
      note: 'Funding user with xUSD for over-burn test',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: donor.addr,
      assetId: xUSDAssetId,
      amount: donorDeposit + fundBuffer,
      note: 'Funding donor with xUSD for over-burn test',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    // User makes a small deposit to create a deposit record
    xUSDLendingContractClient.algorand.setSignerFromAccount(user)
    const userDepositTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: user.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: userDeposit,
      note: 'User xUSD deposit for LST',
      maxFee: microAlgo(MAX_FEE),
    })

    await xUSDLendingContractClient.send.depositAsa({
      args: { amount: userDeposit, assetTransferTxn: userDepositTxn },
      sender: user.addr,
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    // Donor mints extra LST and transfers to user
    xUSDLendingContractClient.algorand.setSignerFromAccount(donor)
    const donorDepositTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: donor.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: donorDeposit,
      note: 'Donor xUSD deposit for LST',
      maxFee: microAlgo(MAX_FEE),
    })

    await xUSDLendingContractClient.send.depositAsa({
      args: { amount: donorDeposit, assetTransferTxn: donorDepositTxn },
      sender: donor.addr,
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: donor.addr,
      receiver: user.addr,
      assetId: lstTokenId,
      amount: donorDeposit,
      note: 'Transfer extra LST to user',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    // User withdraws more than their deposit record
    const withdrawAmount = userDeposit + donorDeposit
    const userXusdBefore = (await algod.accountAssetInformation(user.addr, xUSDAssetId).do()).assetHolding?.amount || 0n
    const userLstBefore = (await algod.accountAssetInformation(user.addr, lstTokenId).do()).assetHolding?.amount || 0n

    xUSDLendingContractClient.algorand.setSignerFromAccount(user)
    const withdrawAxfer = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: user.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: lstTokenId,
      amount: withdrawAmount,
      note: 'Burning extra LST beyond deposit record',
      maxFee: microAlgo(MAX_FEE),
    })

    await xUSDLendingContractClient.send.withdrawDeposit({
      args: { amount: withdrawAmount, assetTransferTxn: withdrawAxfer, lstAppId: xUSDLendingContractClient.appId },
      sender: user.addr,
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const userXusdAfter = (await algod.accountAssetInformation(user.addr, xUSDAssetId).do()).assetHolding?.amount || 0n
    const userLstAfter = (await algod.accountAssetInformation(user.addr, lstTokenId).do()).assetHolding?.amount || 0n

    expect(userLstAfter).toEqual(userLstBefore - withdrawAmount)
    // Should receive underlying for all burned LST; allow minor fee drift
    expect(userXusdAfter - userXusdBefore).toBeGreaterThan(withdrawAmount - 20_000n)
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
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const managerCollateralBeforeInfo = await algod.accountAssetInformation(managerAccount.addr, collateralAssetId).do()
    const managerCollateralBefore = managerCollateralBeforeInfo.assetHolding?.amount || 0n

    const contractCollateralBeforeInfo = await algod
      .accountAssetInformation(collateralLendingContractClient.appClient.appAddress, collateralAssetId)
      .do()
    const contractCollateralBefore = contractCollateralBeforeInfo.assetHolding?.amount || 0n

    const depositTxn = collateralLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: managerAccount.addr,
      receiver: collateralLendingContractClient.appClient.appAddress,
      assetId: collateralAssetId,
      amount: COLLATERAL_DEPOSIT_AMOUNT,
      note: 'Depositing collateral ASA',
      maxFee: microAlgo(MAX_FEE),
    })

    await collateralLendingContractClient.send.depositAsa({
      args: { amount: COLLATERAL_DEPOSIT_AMOUNT, assetTransferTxn: depositTxn },
      sender: managerAccount.addr,
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
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
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: true,
      })

      await collateralLendingContractClient.algorand.send.assetTransfer({
        sender: managerAccount.addr,
        receiver: depositor.addr,
        assetId: lstTokenId,
        amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
        note: 'Funding depositor with collateral LST',
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: true,
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
      args: { assetId: collateralAssetId },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
    const xusdPrice = await oracleAppClient.send.getTokenPrice({
      args: { assetId: xUSDAssetId },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
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
      maxFee: microAlgo(MAX_FEE),
    })

    await expect(
      xUSDLendingContractClient
        .newGroup()
        .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: borrower.addr })
        .borrow({
          args: {
            assetTransferTxn: collateralTransfer,
            collateralAmount: collateralAmount,
            collateralTokenId: collateralLstId,
            lstApp: collateralLendingContractClient.appId,
            requestedLoanAmount: excessiveBorrowAmount,
          },
          maxFee: microAlgo(MAX_FEE),
          sender: borrower.addr,
        })
        .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true }),
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
        args: { assetId: collateralAssetId },
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: true,
      })
      expect(collateralPrice.return?.price).toBeDefined()
      const xUSDPrice = await oracleAppClient.send.getTokenPrice({
        args: { assetId: xUSDAssetId },
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: true,
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
        maxFee: microAlgo(MAX_FEE),
      })

      const contractXusdBalanceBeforeInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
        .do()
      const contractXusdBalanceBefore = contractXusdBalanceBeforeInfo.assetHolding?.amount || 0n

      const collateralPriceReturn = await xUSDLendingContractClient.send.calculateCollateralValueUsd({
        /* args: [collateralLstId, collateralAmount, lstAppId] */
        args: { collateralAmount, collateralTokenId: collateralLstId, lstApp: lstAppId },
        sender: borrowerAccount.addr,
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: true,
      })

      const collateralValueUsd =
        collateralPriceReturn?.returns && collateralPriceReturn.returns.length > 0
          ? (collateralPriceReturn.returns[0].returnValue as bigint)
          : 0n

      await xUSDLendingContractClient
        .newGroup()
        .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: borrowerAccount.addr })
        .borrow({
          args: {
            assetTransferTxn: collateralTransfer,
            requestedLoanAmount: borrowAmount,
            lstApp: lstAppId,
            collateralAmount,
            collateralTokenId: collateralLstId,
          },
          maxFee: microAlgo(MAX_FEE),
          sender: borrowerAccount.addr,
        })
        .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

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

  test('Flux tier discount reduces origination fee for tiered borrower', async () => {
    const borrowAmount = DEPOSITOR_INITIAL_BORROW_AMOUNT / 2n
    const collateralAmount = DEPOSITOR_INITIAL_COLLATERAL_AMOUNT
    const algod = xUSDLendingContractClient.algorand.client.algod

    const collateralState = await collateralLendingContractClient.state.global.getAll()
    const collateralLstId: bigint = collateralState.lstTokenId as bigint
    const lstAppId = collateralLendingContractClient.appId
    expect(collateralLstId).toBeGreaterThan(0n)

    collateralLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    let managerLstBalanceInfo = await algod.accountAssetInformation(managerAccount.addr, collateralLstId).do()
    let managerLstBalance = managerLstBalanceInfo.assetHolding?.amount || 0n
    if (managerLstBalance < collateralAmount) {
      const topUpDepositTxn = collateralLendingContractClient.algorand.createTransaction.assetTransfer({
        sender: managerAccount.addr,
        receiver: collateralLendingContractClient.appClient.appAddress,
        assetId: collateralAssetId,
        amount: COLLATERAL_DEPOSIT_AMOUNT,
        note: 'Top up collateral supply for flux test',
        maxFee: microAlgo(MAX_FEE),
      })

      await collateralLendingContractClient.send.depositAsa({
        args: { amount: COLLATERAL_DEPOSIT_AMOUNT, assetTransferTxn: topUpDepositTxn },
        sender: managerAccount.addr,
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: true,
      })

      managerLstBalanceInfo = await algod.accountAssetInformation(managerAccount.addr, collateralLstId).do()
      managerLstBalance = managerLstBalanceInfo.assetHolding?.amount || 0n
    }
    expect(managerLstBalance).toBeGreaterThanOrEqual(collateralAmount)

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    localnet.algorand.setSignerFromAccount(managerAccount)

    const collateralPrice = await oracleAppClient.send.getTokenPrice({
      args: { assetId: collateralAssetId },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
    const xUSDPrice = await oracleAppClient.send.getTokenPrice({
      args: { assetId: xUSDAssetId },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const discounted = calculateDisbursement({
      collateralAmount,
      collateralPrice: collateralPrice.return?.price || 0n,
      ltvBps: ltv_bps,
      baseTokenPrice: xUSDPrice.return?.price || 0n,
      requestedLoanAmount: borrowAmount,
      originationFeeBps: origination_fee_bps,
      userTier: USER_TIER,
    })
    const baseline = calculateDisbursement({
      collateralAmount,
      collateralPrice: collateralPrice.return?.price || 0n,
      ltvBps: ltv_bps,
      baseTokenPrice: xUSDPrice.return?.price || 0n,
      requestedLoanAmount: borrowAmount,
      originationFeeBps: origination_fee_bps,
    })
    if (USER_TIER > 0n) {
      expect(discounted.fee).toBeLessThan(baseline.fee)
    } else {
      expect(discounted.fee).toEqual(baseline.fee)
    }

    const managerXusdBalanceBeforeInfo = await algod.accountAssetInformation(managerAccount.addr, xUSDAssetId).do()
    const managerXusdBefore = managerXusdBalanceBeforeInfo.assetHolding?.amount || 0n
    const contractXusdBeforeInfo = await algod
      .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
      .do()
    const contractXusdBefore = contractXusdBeforeInfo.assetHolding?.amount || 0n

    const boxValue = await getCollateralBoxValue(
      collateralLstId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )

    const collateralTransfer = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: collateralLstId,
      amount: collateralAmount,
      note: 'Depositing collateral LST with flux discount',
      maxFee: microAlgo(MAX_FEE),
    })

    await xUSDLendingContractClient
      .newGroup()
      .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: managerAccount.addr })
      .borrow({
        args: {
          assetTransferTxn: collateralTransfer,
          collateralAmount: collateralAmount,
          collateralTokenId: collateralLstId,
          lstApp: lstAppId,
          requestedLoanAmount: borrowAmount,
        },
        maxFee: microAlgo(MAX_FEE),
        sender: managerAccount.addr,
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    const managerXusdAfterInfo = await algod.accountAssetInformation(managerAccount.addr, xUSDAssetId).do()
    const managerXusdAfter = managerXusdAfterInfo.assetHolding?.amount || 0n
    expect(managerXusdAfter - managerXusdBefore).toEqual(discounted.disbursement)

    const contractXusdAfterInfo = await algod
      .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
      .do()
    const contractXusdAfter = contractXusdAfterInfo.assetHolding?.amount || 0n
    expect(contractXusdBefore - contractXusdAfter).toEqual(discounted.disbursement)

    const loanRecord = await getLoanRecordBoxValueASA(
      managerAccount.addr.toString(),
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )
    expect(loanRecord.principal).toEqual(discounted.disbursement)

    const repayTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: managerAccount.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: loanRecord.principal + 1000n,
      note: 'Repaying discounted loan',
      maxFee: microAlgo(MAX_FEE),
    })

    await xUSDLendingContractClient
      .newGroup()
      .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: managerAccount.addr })
      .repayLoanAsa({
        /* args: [repayTxn, loanRecord.principal + 1000n] */
        args: {
          assetTransferTxn: repayTxn,
          repaymentAmount: loanRecord.principal + 1000n,
        },
        sender: managerAccount.addr,
        maxFee: microAlgo(MAX_FEE),
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    await expect(
      getLoanRecordBoxValueASA(
        managerAccount.addr.toString(),
        xUSDLendingContractClient,
        xUSDLendingContractClient.appId,
      ),
    ).rejects.toThrowError()

    const managerXusdFinalInfo = await algod.accountAssetInformation(managerAccount.addr, xUSDAssetId).do()
    const managerXusdFinal = managerXusdFinalInfo.assetHolding?.amount || 0n
    const netPaid = managerXusdAfter - managerXusdFinal
    expect(netPaid).toBeGreaterThanOrEqual(discounted.disbursement)
    expect(netPaid).toBeLessThanOrEqual(loanRecord.principal + 1000n)
    // Final balance should reflect disbursement minus what was actually paid back (overpay may be refunded in-contract).
    expect(managerXusdFinal).toEqual(managerXusdBefore + discounted.disbursement - netPaid)
  })

  test('repay part of an outstanding ASA loan', async () => {
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const borrowerAccount = depositors[i]
      xUSDLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)

      const loanRecordBefore = await getLoanRecordBoxValueASA(
        borrowerAccount.addr.toString(),
        xUSDLendingContractClient,
        xUSDLendingContractClient.appId,
      )
      expect(loanRecordBefore).toBeDefined()

      const principalBefore = loanRecordBefore.principal
      expect(principalBefore).toBeGreaterThan(0n)

      const repayAmount = principalBefore / 4n
      expect(repayAmount).toBeGreaterThan(0n)
      const repayRequested = repayAmount + 1_000n // buffer for drift/overpay, refunded if unused

      const borrowerBalanceInfoBefore = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, xUSDAssetId)
        .do()
      const borrowerXusdBefore = borrowerBalanceInfoBefore.assetHolding?.amount || 0n

      const contractBalanceInfoBefore = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
        .do()
      const contractXusdBefore = contractBalanceInfoBefore.assetHolding?.amount || 0n

      const globalStateBefore = await xUSDLendingContractClient.state.global.getAll()
      const totalBorrowsBefore = globalStateBefore.totalBorrows ?? 0n

      const repayTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
        sender: borrowerAccount.addr,
        receiver: xUSDLendingContractClient.appClient.appAddress,
        assetId: xUSDAssetId,
        amount: repayRequested,
        note: 'Partial loan repayment',
        maxFee: microAlgo(MAX_FEE),
      })

      await xUSDLendingContractClient
        .newGroup()
        .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: borrowerAccount.addr })
        .repayLoanAsa({
          args: { assetTransferTxn: repayTxn, repaymentAmount: repayRequested },
          sender: borrowerAccount.addr,
          maxFee: microAlgo(MAX_FEE),
        })
        .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

      const borrowerBalanceInfoAfter = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, xUSDAssetId)
        .do()
      const borrowerXusdAfter = borrowerBalanceInfoAfter.assetHolding?.amount || 0n
      const netPaid = borrowerXusdBefore - borrowerXusdAfter

      const contractBalanceInfoAfter = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
        .do()
      const contractXusdAfter = contractBalanceInfoAfter.assetHolding?.amount || 0n
      expect(netPaid).toBeGreaterThan(0n)
      expect(netPaid).toBeLessThanOrEqual(repayRequested)
      expect(contractXusdAfter - contractXusdBefore).toEqual(netPaid)

      const loanRecordAfter = await getLoanRecordBoxValueASA(
        borrowerAccount.addr.toString(),
        xUSDLendingContractClient,
        xUSDLendingContractClient.appId,
      )
      const repayUsed = principalBefore - loanRecordAfter.principal
      expect(repayUsed).toBeGreaterThan(0n)
      expect(repayUsed).toBeLessThanOrEqual(netPaid)
      expect(repayUsed).toBeLessThanOrEqual(repayRequested)

      const globalStateAfter = await xUSDLendingContractClient.state.global.getAll()
      const totalBorrowsAfter = globalStateAfter.totalBorrows ?? 0n
      const borrowDelta = totalBorrowsBefore - totalBorrowsAfter
      expect(borrowDelta).toBeGreaterThan(0n)
      expect(borrowDelta).toBeLessThanOrEqual(repayRequested)
      // repayUsed may include interest accrued between snapshots; allow small drift margin
      const driftMargin = 10_000n
      expect(borrowDelta).toBeLessThanOrEqual(repayUsed + driftMargin)
    }
  })

  test('fully repay ASA loan and reclaim collateral', async () => {
    for (let i = 0; i < NUM_DEPOSITORS; i++) {
      const borrowerAccount = depositors[i]
      xUSDLendingContractClient.algorand.setSignerFromAccount(borrowerAccount)

      const loanRecordBefore = await getLoanRecordBoxValueASA(
        borrowerAccount.addr.toString(),
        xUSDLendingContractClient,
        xUSDLendingContractClient.appId,
      )
      expect(loanRecordBefore).toBeDefined()

      const remainingDebt = loanRecordBefore.principal
      expect(remainingDebt).toBeGreaterThan(0n)

      const borrowerXusdBeforeInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, xUSDAssetId)
        .do()
      const borrowerXusdBefore = borrowerXusdBeforeInfo.assetHolding?.amount || 0n

      const contractXusdBeforeInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
        .do()
      const contractXusdBefore = contractXusdBeforeInfo.assetHolding?.amount || 0n

      const collateralState = await collateralLendingContractClient.state.global.getAll()
      const collateralLstId: bigint = collateralState.lstTokenId as bigint
      expect(collateralLstId).toBeGreaterThan(0n)

      const borrowerCollateralBeforeInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, collateralLstId)
        .do()
      const borrowerCollateralBefore = borrowerCollateralBeforeInfo.assetHolding?.amount || 0n

      const globalStateBefore = await xUSDLendingContractClient.state.global.getAll()
      const totalBorrowsBefore = globalStateBefore.totalBorrows ?? 0n
      const activeLoansBefore = globalStateBefore.activeLoanRecords ?? 0n

      const overpayBuffer = 10_000n
      const requestedRepayAmount = remainingDebt + overpayBuffer
      expect(requestedRepayAmount).toBeGreaterThan(remainingDebt)
      const repayTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
        sender: borrowerAccount.addr,
        receiver: xUSDLendingContractClient.appClient.appAddress,
        assetId: xUSDAssetId,
        amount: requestedRepayAmount,
        note: 'Full loan repayment',
        maxFee: microAlgo(MAX_FEE),
      })

      await xUSDLendingContractClient
        .newGroup()
        .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: borrowerAccount.addr })
        .repayLoanAsa({
          args: { assetTransferTxn: repayTxn, repaymentAmount: requestedRepayAmount },
          sender: borrowerAccount.addr,
          maxFee: microAlgo(MAX_FEE),
        })
        .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

      const borrowerXusdAfterInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, xUSDAssetId)
        .do()
      const borrowerXusdAfter = borrowerXusdAfterInfo.assetHolding?.amount || 0n
      const netPaid = borrowerXusdBefore - borrowerXusdAfter

      const contractXusdAfterInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
        .do()
      const contractXusdAfter = contractXusdAfterInfo.assetHolding?.amount || 0n
      expect(netPaid).toBeGreaterThan(0n)
      expect(netPaid).toBeLessThanOrEqual(requestedRepayAmount)
      expect(contractXusdAfter - contractXusdBefore).toEqual(netPaid)

      await expect(
        getLoanRecordBoxValueASA(
          borrowerAccount.addr.toString(),
          xUSDLendingContractClient,
          xUSDLendingContractClient.appId,
        ),
      ).rejects.toThrowError()

      const borrowerCollateralAfterInfo = await xUSDLendingContractClient.algorand.client.algod
        .accountAssetInformation(borrowerAccount.addr, collateralLstId)
        .do()
      const borrowerCollateralAfter = borrowerCollateralAfterInfo.assetHolding?.amount || 0n
      expect(borrowerCollateralAfter - borrowerCollateralBefore).toEqual(loanRecordBefore.collateralAmount)

      const globalStateAfter = await xUSDLendingContractClient.state.global.getAll()
      const totalBorrowsAfter = globalStateAfter.totalBorrows ?? 0n
      const activeLoansAfter = globalStateAfter.activeLoanRecords ?? 0n

      expect(totalBorrowsBefore - totalBorrowsAfter).toEqual(remainingDebt)
      expect(activeLoansBefore - activeLoansAfter).toEqual(1n)
    }
  })

  test('buy out ASA loan using premium split', async () => {
    const { generateAccount } = localnet.context
    const borrowAmount = DEPOSITOR_INITIAL_BORROW_AMOUNT
    const collateralAmount = DEPOSITOR_INITIAL_COLLATERAL_AMOUNT

    const collateralStateInitial = await collateralLendingContractClient.state.global.getAll()
    const collateralLstId: bigint = collateralStateInitial.lstTokenId as bigint
    const lstAppId = collateralLendingContractClient.appId
    expect(collateralLstId).toBeGreaterThan(0n)

    const borrower = await generateAccount({ initialFunds: microAlgo(8_000_000) })

    // Borrower opt-ins
    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    localnet.algorand.setSignerFromAccount(borrower)
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: borrower.addr,
      assetId: xUSDAssetId,
      note: 'Opting borrower into xUSD',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    collateralLendingContractClient.algorand.setSignerFromAccount(borrower)
    await collateralLendingContractClient.algorand.send.assetOptIn({
      sender: borrower.addr,
      assetId: collateralLstId,
      note: 'Opting borrower into collateral LST',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    // Fund borrower with collateral LST from manager
    collateralLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await collateralLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: borrower.addr,
      assetId: collateralLstId,
      amount: collateralAmount,
      note: 'Funding borrower with collateral LST for buyout scenario',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    localnet.algorand.setSignerFromAccount(borrower)

    const collateralBoxBeforeBorrow = await getCollateralBoxValue(
      collateralLstId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )

    const collateralTransfer = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: borrower.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: collateralLstId,
      amount: collateralAmount,
      note: 'Depositing collateral LST for new loan',
      maxFee: microAlgo(MAX_FEE),
    })

    await xUSDLendingContractClient
      .newGroup()
      .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: borrower.addr })
      .borrow({
        args: {
          assetTransferTxn: collateralTransfer,
          requestedLoanAmount: borrowAmount,
          collateralAmount,
          lstApp: lstAppId,
          collateralTokenId: collateralLstId,
        },
        maxFee: microAlgo(MAX_FEE),
        sender: borrower.addr,
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    const loanRecord = await getLoanRecordBoxValueASA(
      borrower.addr.toString(),
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )

    const xusdGlobalStateBeforeBuyout = await xUSDLendingContractClient.state.global.getAll()
    const collateralStateAfterBorrow = await collateralLendingContractClient.state.global.getAll()

    const xUSDPrice = await oracleAppClient.send.getTokenPrice({
      args: { assetId: xUSDAssetId },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })
    const collateralPrice = await oracleAppClient.send.getTokenPrice({
      args: { assetId: collateralAssetId },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const buyoutTerms = computeBuyoutTerms({
      collateralLSTAmount: loanRecord.collateralAmount,
      totalDepositsLST: collateralStateAfterBorrow.totalDeposits ?? 0n,
      circulatingLST: collateralStateAfterBorrow.circulatingLst ?? 0n,
      underlyingBasePrice: collateralPrice.return?.price || 0n,
      baseTokenPrice: xUSDPrice.return?.price || 0n,
      buyoutTokenPrice: xUSDPrice.return?.price || 0n,
      principal: loanRecord.principal,
      userIndexWad: loanRecord.userIndexWad,
      borrowIndexWad: xusdGlobalStateBeforeBuyout.borrowIndexWad ?? 0n,
      liq_threshold_bps: xusdGlobalStateBeforeBuyout.liqThresholdBps ?? 0n,
    })

    expect(buyoutTerms.debtRepayAmountBase).toBeGreaterThan(0n)
    expect(buyoutTerms.premiumTokens).toBeGreaterThan(0n)

    const buyer = await generateAccount({ initialFunds: microAlgo(8_000_000) })

    xUSDLendingContractClient.algorand.setSignerFromAccount(buyer)
    localnet.algorand.setSignerFromAccount(buyer)
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: buyer.addr,
      assetId: xUSDAssetId,
      note: 'Opting buyer into xUSD',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    collateralLendingContractClient.algorand.setSignerFromAccount(buyer)
    await collateralLendingContractClient.algorand.send.assetOptIn({
      sender: buyer.addr,
      assetId: collateralLstId,
      note: 'Opting buyer into collateral LST',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const premiumTokens = buyoutTerms.premiumTokens
    const debtRepayAmountBase = buyoutTerms.debtRepayAmountBase
    const repayBuffer = 10_000n
    const premiumPaymentAmount = premiumTokens + 10n
    const repayPaymentAmount = debtRepayAmountBase + repayBuffer
    const totalFundingNeeded = premiumPaymentAmount + repayPaymentAmount

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: buyer.addr,
      assetId: xUSDAssetId,
      amount: totalFundingNeeded + 1_000_000n,
      note: 'Funding buyer with xUSD for buyout',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    xUSDLendingContractClient.algorand.setSignerFromAccount(buyer)
    collateralLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    localnet.algorand.setSignerFromAccount(buyer)

    const algod = xUSDLendingContractClient.algorand.client.algod

    const managerXusdBeforeInfo = await algod.accountAssetInformation(managerAccount.addr, xUSDAssetId).do()
    const managerXusdBefore = managerXusdBeforeInfo.assetHolding?.amount || 0n

    const borrowerXusdBeforeInfo = await algod.accountAssetInformation(borrower.addr, xUSDAssetId).do()
    const borrowerXusdBefore = borrowerXusdBeforeInfo.assetHolding?.amount || 0n

    const buyerXusdBeforeInfo = await algod.accountAssetInformation(buyer.addr, xUSDAssetId).do()
    const buyerXusdBefore = buyerXusdBeforeInfo.assetHolding?.amount || 0n

    const buyerCollateralBeforeInfo = await algod.accountAssetInformation(buyer.addr, collateralLstId).do()
    const buyerCollateralBefore = buyerCollateralBeforeInfo.assetHolding?.amount || 0n

    const contractXusdBeforeInfo = await algod
      .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
      .do()
    const contractXusdBefore = contractXusdBeforeInfo.assetHolding?.amount || 0n

    const activeLoansBefore = xusdGlobalStateBeforeBuyout.activeLoanRecords ?? 0n
    const totalBorrowsBefore = xusdGlobalStateBeforeBuyout.totalBorrows ?? 0n

    const premiumAxferTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: buyer.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: premiumPaymentAmount,
      note: 'Paying buyout premium',
      maxFee: microAlgo(MAX_FEE),
    })

    const repayAxferTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: buyer.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: repayPaymentAmount,
      note: 'Repaying borrower debt',
      maxFee: microAlgo(MAX_FEE),
    })

    const collateralBoxForBuyout = await getCollateralBoxValue(
      collateralLstId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )

    await xUSDLendingContractClient
      .newGroup()
      .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: buyer.addr })
      .buyoutSplitAsa({
        args: {
          buyer: buyer.addr.publicKey,
          debtor: borrower.addr.publicKey,
          premiumAxferTxn,
          repayAxferTxn,
          lstAppId,
        },
        maxFee: microAlgo(MAX_FEE),
        sender: buyer.addr,
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    await expect(
      getLoanRecordBoxValueASA(borrower.addr.toString(), xUSDLendingContractClient, xUSDLendingContractClient.appId),
    ).rejects.toThrowError()

    const managerXusdAfterInfo = await algod.accountAssetInformation(managerAccount.addr, xUSDAssetId).do()
    const managerXusdAfter = managerXusdAfterInfo.assetHolding?.amount || 0n

    const borrowerXusdAfterInfo = await algod.accountAssetInformation(borrower.addr, xUSDAssetId).do()
    const borrowerXusdAfter = borrowerXusdAfterInfo.assetHolding?.amount || 0n

    const buyerXusdAfterInfo = await algod.accountAssetInformation(buyer.addr, xUSDAssetId).do()
    const buyerXusdAfter = buyerXusdAfterInfo.assetHolding?.amount || 0n

    const buyerCollateralAfterInfo = await algod.accountAssetInformation(buyer.addr, collateralLstId).do()
    const buyerCollateralAfter = buyerCollateralAfterInfo.assetHolding?.amount || 0n

    const contractXusdAfterInfo = await algod
      .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
      .do()
    const contractXusdAfter = contractXusdAfterInfo.assetHolding?.amount || 0n

    const xusdGlobalStateAfterBuyout = await xUSDLendingContractClient.state.global.getAll()
    const activeLoansAfter = xusdGlobalStateAfterBuyout.activeLoanRecords ?? 0n
    const totalBorrowsAfter = xusdGlobalStateAfterBuyout.totalBorrows ?? 0n

    const collateralBoxAfterBuyout = await getCollateralBoxValue(
      collateralLstId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )

    const protocolShare = premiumTokens / 2n
    const borrowerShare = premiumTokens - protocolShare
    const netRepayPaid = contractXusdAfter - contractXusdBefore
    const borrowDelta = totalBorrowsBefore - totalBorrowsAfter
    const actualPremiumPaid = buyerXusdBefore - buyerXusdAfter - netRepayPaid
    const expectedPremiumRefund = premiumPaymentAmount - premiumTokens
    const actualPremiumRefund = premiumPaymentAmount - actualPremiumPaid

    expect(managerXusdAfter - managerXusdBefore).toEqual(protocolShare)
    expect(borrowerXusdAfter - borrowerXusdBefore).toEqual(borrowerShare)
    expect(actualPremiumPaid).toEqual(premiumTokens)
    expect(actualPremiumRefund).toEqual(expectedPremiumRefund)
    expect(netRepayPaid).toBeGreaterThan(0n)
    expect(netRepayPaid).toBeLessThanOrEqual(repayPaymentAmount)
    expect(buyerCollateralAfter - buyerCollateralBefore).toEqual(loanRecord.collateralAmount)
    expect(collateralBoxAfterBuyout.totalCollateral).toEqual(collateralBoxBeforeBorrow.totalCollateral)
    expect(activeLoansBefore - activeLoansAfter).toEqual(1n)
    expect(borrowDelta).toBeGreaterThan(0n)
    expect(borrowDelta).toBeLessThanOrEqual(debtRepayAmountBase)

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    collateralLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    localnet.algorand.setSignerFromAccount(managerAccount)
  })

  test('liquidate undercollateralized ASA loan', async () => {
    const { generateAccount } = localnet.context
    const algod = xUSDLendingContractClient.algorand.client.algod

    const collateralStateInitial = await collateralLendingContractClient.state.global.getAll()
    const collateralLstId: bigint = collateralStateInitial.lstTokenId as bigint
    const lstAppId = collateralLendingContractClient.appId
    expect(collateralLstId).toBeGreaterThan(0n)

    const borrower = await generateAccount({ initialFunds: microAlgo(8_000_000) })

    // Borrower opt-ins
    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    localnet.algorand.setSignerFromAccount(borrower)
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: borrower.addr,
      assetId: xUSDAssetId,
      note: 'Opting borrower into xUSD',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    collateralLendingContractClient.algorand.setSignerFromAccount(borrower)
    await collateralLendingContractClient.algorand.send.assetOptIn({
      sender: borrower.addr,
      assetId: collateralLstId,
      note: 'Opting borrower into collateral LST',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    // Ensure manager holds enough LST to fund borrower
    collateralLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    const managerLstBalanceInfo = await algod.accountAssetInformation(managerAccount.addr, collateralLstId).do()
    let managerLstBalance = managerLstBalanceInfo.assetHolding?.amount || 0n
    if (managerLstBalance < DEPOSITOR_INITIAL_COLLATERAL_AMOUNT) {
      const topUpDepositTxn = collateralLendingContractClient.algorand.createTransaction.assetTransfer({
        sender: managerAccount.addr,
        receiver: collateralLendingContractClient.appClient.appAddress,
        assetId: collateralAssetId,
        amount: COLLATERAL_DEPOSIT_AMOUNT,
        note: 'Topping up collateral pool for liquidation scenario',
        maxFee: microAlgo(MAX_FEE),
      })

      await collateralLendingContractClient.send.depositAsa({
        args: { amount: COLLATERAL_DEPOSIT_AMOUNT, assetTransferTxn: topUpDepositTxn },
        sender: managerAccount.addr,
        maxFee: microAlgo(MAX_FEE),
        coverAppCallInnerTransactionFees: true,
        populateAppCallResources: true,
      })

      const refreshedManagerLstInfo = await algod.accountAssetInformation(managerAccount.addr, collateralLstId).do()
      managerLstBalance = refreshedManagerLstInfo.assetHolding?.amount || 0n
    }
    expect(managerLstBalance).toBeGreaterThanOrEqual(DEPOSITOR_INITIAL_COLLATERAL_AMOUNT)

    // Transfer collateral LST to borrower for loan
    await collateralLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: borrower.addr,
      assetId: collateralLstId,
      amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
      note: 'Funding borrower collateral for liquidation scenario',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const collateralBoxBaseline = await getCollateralBoxValue(
      collateralLstId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )

    // Execute borrow for borrower
    xUSDLendingContractClient.algorand.setSignerFromAccount(borrower)
    localnet.algorand.setSignerFromAccount(borrower)

    const collateralTransfer = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: borrower.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: collateralLstId,
      amount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
      note: 'Depositing collateral for liquidation scenario',
      maxFee: microAlgo(MAX_FEE),
    })

    await xUSDLendingContractClient
      .newGroup()
      .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: borrower.addr })
      .borrow({
        args: {
          assetTransferTxn: collateralTransfer,
          requestedLoanAmount: DEPOSITOR_INITIAL_BORROW_AMOUNT,
          collateralAmount: DEPOSITOR_INITIAL_COLLATERAL_AMOUNT,
          collateralTokenId: collateralLstId,
          lstApp: lstAppId,
        },
        maxFee: microAlgo(MAX_FEE),
        sender: borrower.addr,
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    const loanRecord = await getLoanRecordBoxValueASA(
      borrower.addr.toString(),
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )
    expect(loanRecord.principal).toBeGreaterThan(0n)

    // Sharply devalue collateral to trigger liquidation eligibility
    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.addTokenListing({
      args: { assetId: collateralAssetId, initialPrice: COLLATERAL_LIQUIDATION_PRICE },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const globalState = await xUSDLendingContractClient.state.global.getAll()
    const borrowIndexWad = globalState.borrowIndexWad as bigint

    // Prepare liquidator
    const liquidator = await generateAccount({ initialFunds: microAlgo(8_000_000) })
    xUSDLendingContractClient.algorand.setSignerFromAccount(liquidator)
    localnet.algorand.setSignerFromAccount(liquidator)
    await xUSDLendingContractClient.algorand.send.assetOptIn({
      sender: liquidator.addr,
      assetId: xUSDAssetId,
      note: 'Opting liquidator into xUSD',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    collateralLendingContractClient.algorand.setSignerFromAccount(liquidator)
    await collateralLendingContractClient.algorand.send.assetOptIn({
      sender: liquidator.addr,
      assetId: collateralLstId,
      note: 'Opting liquidator into collateral LST',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    const liveDebt = liveDebtFromSnapshot(loanRecord.principal, loanRecord.userIndexWad, borrowIndexWad)
    const repayAmount = liveDebt + 10_000n

    // Fund liquidator with xUSD for repayment
    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    await xUSDLendingContractClient.algorand.send.assetTransfer({
      sender: managerAccount.addr,
      receiver: liquidator.addr,
      assetId: xUSDAssetId,
      amount: repayAmount + 1_000_000n,
      note: 'Funding liquidator with xUSD for liquidation',
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    xUSDLendingContractClient.algorand.setSignerFromAccount(liquidator)
    localnet.algorand.setSignerFromAccount(liquidator)

    const borrowerCollateralBeforeInfo = await algod.accountAssetInformation(borrower.addr, collateralLstId).do()
    const borrowerCollateralBefore = borrowerCollateralBeforeInfo.assetHolding?.amount || 0n
    expect(borrowerCollateralBefore).toEqual(0n)

    const liquidatorXusdBeforeInfo = await algod.accountAssetInformation(liquidator.addr, xUSDAssetId).do()
    const liquidatorXusdBefore = liquidatorXusdBeforeInfo.assetHolding?.amount || 0n

    const liquidatorCollateralBeforeInfo = await algod.accountAssetInformation(liquidator.addr, collateralLstId).do()
    const liquidatorCollateralBefore = liquidatorCollateralBeforeInfo.assetHolding?.amount || 0n

    const contractXusdBeforeInfo = await algod
      .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
      .do()
    const contractXusdBefore = contractXusdBeforeInfo.assetHolding?.amount || 0n

    const globalBefore = await xUSDLendingContractClient.state.global.getAll()
    const totalBorrowsBefore = globalBefore.totalBorrows ?? 0n
    const activeLoansBefore = globalBefore.activeLoanRecords ?? 0n

    const repayTxn = xUSDLendingContractClient.algorand.createTransaction.assetTransfer({
      sender: liquidator.addr,
      receiver: xUSDLendingContractClient.appClient.appAddress,
      assetId: xUSDAssetId,
      amount: repayAmount,
      note: 'Repaying debt for liquidation',
      maxFee: microAlgo(MAX_FEE),
    })

    const collateralBoxForLiquidation = await getCollateralBoxValue(
      collateralLstId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )

    await xUSDLendingContractClient
      .newGroup()
      .gas({ args: {}, maxFee: microAlgo(MAX_FEE), sender: liquidator.addr })
      .liquidatePartialAsa({
        args: {
          debtor: borrower.addr.publicKey,
          repayAxfer: repayTxn,
          repayBaseAmount: repayAmount,
          lstAppId,
        },
        maxFee: microAlgo(MAX_FEE),
        sender: liquidator.addr,
      })
      .send({ populateAppCallResources: true, coverAppCallInnerTransactionFees: true })

    await expect(
      getLoanRecordBoxValueASA(borrower.addr.toString(), xUSDLendingContractClient, xUSDLendingContractClient.appId),
    ).rejects.toThrowError()

    const borrowerCollateralAfterInfo = await algod.accountAssetInformation(borrower.addr, collateralLstId).do()
    const borrowerCollateralAfter = borrowerCollateralAfterInfo.assetHolding?.amount || 0n
    expect(borrowerCollateralAfter).toEqual(0n)

    const liquidatorXusdAfterInfo = await algod.accountAssetInformation(liquidator.addr, xUSDAssetId).do()
    const liquidatorXusdAfter = liquidatorXusdAfterInfo.assetHolding?.amount || 0n
    const netPaid = liquidatorXusdBefore - liquidatorXusdAfter

    const liquidatorCollateralAfterInfo = await algod.accountAssetInformation(liquidator.addr, collateralLstId).do()
    const liquidatorCollateralAfter = liquidatorCollateralAfterInfo.assetHolding?.amount || 0n
    expect(liquidatorCollateralAfter - liquidatorCollateralBefore).toEqual(DEPOSITOR_INITIAL_COLLATERAL_AMOUNT)

    const contractXusdAfterInfo = await algod
      .accountAssetInformation(xUSDLendingContractClient.appClient.appAddress, xUSDAssetId)
      .do()
    const contractXusdAfter = contractXusdAfterInfo.assetHolding?.amount || 0n
    expect(netPaid).toBeGreaterThan(0n)
    expect(netPaid).toBeLessThanOrEqual(repayAmount)
    expect(contractXusdAfter - contractXusdBefore).toEqual(netPaid)

    const globalAfter = await xUSDLendingContractClient.state.global.getAll()
    const totalBorrowsAfter = globalAfter.totalBorrows ?? 0n
    const activeLoansAfter = globalAfter.activeLoanRecords ?? 0n
    const borrowDelta = totalBorrowsBefore - totalBorrowsAfter
    expect(borrowDelta).toBeGreaterThan(0n)
    // Borrow delta should be capped to the pre-liquidation debt; overpay is refunded.
    expect(borrowDelta).toBeLessThanOrEqual(loanRecord.principal + 10_000n)
    expect(activeLoansBefore - activeLoansAfter).toEqual(1n)

    const collateralBoxAfter = await getCollateralBoxValue(
      collateralLstId,
      xUSDLendingContractClient,
      xUSDLendingContractClient.appId,
    )
    expect(collateralBoxAfter.totalCollateral).toEqual(collateralBoxBaseline.totalCollateral)

    // Restore collateral oracle price for subsequent tests
    oracleAppClient.algorand.setSignerFromAccount(managerAccount)
    await oracleAppClient.send.addTokenListing({
      args: { assetId: collateralAssetId, initialPrice: COLLATERAL_ORACLE_PRICE },
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
    })

    xUSDLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    collateralLendingContractClient.algorand.setSignerFromAccount(managerAccount)
    localnet.algorand.setSignerFromAccount(managerAccount)
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

    await xUSDLendingContractClient.send.withdrawPlatformFees({
      args: { paymentReceiver: managerAccount.addr.toString() },
      sender: managerAccount.addr,
      maxFee: microAlgo(MAX_FEE),
      coverAppCallInnerTransactionFees: true,
      populateAppCallResources: true,
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
