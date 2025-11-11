import { abimethod, contract, Contract } from '@algorandfoundation/algorand-typescript'
import { uint64 } from '@algorandfoundation/algorand-typescript'
import { UintN64 } from '@algorandfoundation/algorand-typescript/arc4'
import { divw, mulw } from '@algorandfoundation/algorand-typescript/op'
import { BASIS_POINTS, INDEX_SCALE, SECONDS_PER_YEAR, USD_MICRO_UNITS } from './config.algo'

/**
 * NebulaCalculus is intended to encapsulate all heavy math and rate logic so the
 * primary lending apps can stay focused on state/box management.
 * The methods are currently stubs; real implementations will move over from
 * `OrbitalLending*.algo.ts` once validated.
 */
@contract({ name: 'nebula-calculus', avmVersion: 11 })
export class NebulaCalculus extends Contract {
  @abimethod({ allowActions: 'NoOp', onCreate: 'require' })
  public createApplication(): void {
    // No state to initialize
  }

  @abimethod({ allowActions: 'NoOp' })
  public utilNormBps(totalDeposits: UintN64, totalBorrows: UintN64, utilCapBps: UintN64): UintN64 {
    const D: uint64 = totalDeposits.native
    const B: uint64 = totalBorrows.native
    const cap_bps: uint64 = utilCapBps.native
    if (D === 0) return new UintN64(0)

    const [hiCap, loCap] = mulw(D, cap_bps)
    const capBorrow = divw(hiCap, loCap, BASIS_POINTS)
    if (capBorrow === 0) return new UintN64(0)

    const cappedB = B <= capBorrow ? B : capBorrow
    const [hiN, loN] = mulw(cappedB, BASIS_POINTS)
    return new UintN64(divw(hiN, loN, capBorrow))
  }

  @abimethod({ allowActions: 'NoOp' })
  public aprBpsKinked(
    uNormBps: UintN64,
    baseBps: UintN64,
    kinkNormBps: UintN64,
    slope1Bps: UintN64,
    slope2Bps: UintN64,
    maxAprBps: UintN64,
  ): UintN64 {
    const U: uint64 = uNormBps.native
    const base: uint64 = baseBps.native
    const kink: uint64 = kinkNormBps.native
    const slope1: uint64 = slope1Bps.native
    const slope2: uint64 = slope2Bps.native
    const maxApr: uint64 = maxAprBps.native
    let apr: uint64

    if (U <= kink) {
      const [hi1, lo1] = mulw(slope1, U)
      apr = base + divw(hi1, lo1, kink)
    } else {
      const over: uint64 = U - kink
      const denom: uint64 = BASIS_POINTS - kink
      const [hi2, lo2] = mulw(slope2, over)
      apr = base + slope1 + divw(hi2, lo2, denom)
    }

    if (maxApr > 0 && apr > maxApr) apr = maxApr
    return new UintN64(apr)
  }

  @abimethod({ allowActions: 'NoOp' })
  public sliceFactorWad(deltaT: UintN64, lastAprBps: UintN64): UintN64 {
    const dt: uint64 = deltaT.native
    if (dt === 0) return new UintN64(0)

    const [hRate, lRate] = mulw(INDEX_SCALE, lastAprBps.native)
    const ratePerYearWad: uint64 = divw(hRate, lRate, BASIS_POINTS)
    const [hSlice, lSlice] = mulw(ratePerYearWad, dt)
    return new UintN64(divw(hSlice, lSlice, SECONDS_PER_YEAR))
  }

  @abimethod({ allowActions: 'NoOp' })
  public currentDebtFromSnapshot(principal: UintN64, borrowIndexWad: UintN64, userIndexWad: UintN64): UintN64 {
    const p: uint64 = principal.native
    if (p === 0) return new UintN64(0)
    const [hi, lo] = mulw(p, borrowIndexWad.native)
    return new UintN64(divw(hi, lo, userIndexWad.native))
  }

  @abimethod({ allowActions: 'NoOp' })
  public lstDue(amount: UintN64, circulatingLst: UintN64, totalDeposits: UintN64): UintN64 {
    const circ: uint64 = circulatingLst.native
    const total: uint64 = totalDeposits.native
    if (circ === 0) return new UintN64(0)
    const [hi, lo] = mulw(total, amount.native)
    return new UintN64(divw(hi, lo, circ))
  }

  @abimethod({ allowActions: 'NoOp' })
  public aprSplit(
    interest: UintN64,
    protocolShareBps: UintN64,
  ): { depositorInterest: UintN64; protocolInterest: UintN64 } {
    const interestValue: uint64 = interest.native
    const protoBps: uint64 = protocolShareBps.native
    const deposBps: uint64 = BASIS_POINTS - protoBps

    const [hiD, loD] = mulw(interestValue, deposBps)
    const depositorInterest: uint64 = divw(hiD, loD, BASIS_POINTS)
    const protocolInterest: uint64 = interestValue - depositorInterest

    return {
      depositorInterest: new UintN64(depositorInterest),
      protocolInterest: new UintN64(protocolInterest),
    }
  }

  @abimethod({ allowActions: 'NoOp' })
  public collateralValueUSD(
    collateralAmount: UintN64,
    totalDeposits: UintN64,
    circulatingLst: UintN64,
    baseTokenPrice: UintN64,
  ): UintN64 {
    const circ: uint64 = circulatingLst.native
    if (circ === 0) return new UintN64(0)
    const [hC, lC] = mulw(totalDeposits.native, collateralAmount.native)
    const underlying: uint64 = divw(hC, lC, circ)
    const [hU, lU] = mulw(underlying, baseTokenPrice.native)
    return new UintN64(divw(hU, lU, USD_MICRO_UNITS))
  }

  @abimethod({ allowActions: 'NoOp' })
  public baseValueUSD(baseAmount: UintN64, baseTokenPrice: UintN64): UintN64 {
    const [h, l] = mulw(baseAmount.native, baseTokenPrice.native)
    return new UintN64(divw(h, l, USD_MICRO_UNITS))
  }

  @abimethod({ allowActions: 'NoOp' })
  public ltvBps(debtUsd: UintN64, collateralUsd: UintN64): UintN64 {
    const coll: uint64 = collateralUsd.native
    if (coll === 0) return new UintN64(0)
    const [h, l] = mulw(debtUsd.native, BASIS_POINTS)
    return new UintN64(divw(h, l, coll))
  }

  @abimethod({ allowActions: 'NoOp' })
  public buyoutPremium(
    collateralUsd: UintN64,
    debtUsd: UintN64,
    liqThresholdBps: UintN64,
    buyoutTokenPrice: UintN64,
  ): { ltvBps: UintN64; premiumUsd: UintN64; premiumTokens: UintN64 } {
    const collUSD: uint64 = collateralUsd.native
    const debtUSD: uint64 = debtUsd.native
    let ltv: uint64 = 0
    if (collUSD > 0) {
      const [hLTV, lLTV] = mulw(debtUSD, BASIS_POINTS)
      ltv = divw(hLTV, lLTV, collUSD)
    }
    let premiumUsd: uint64 = 0
    let premiumTokens: uint64 = 0
    if (ltv > 0) {
      const [hR, lR] = mulw(liqThresholdBps.native, BASIS_POINTS)
      const ratio = divw(hR, lR, ltv)
      const premiumRateBps: uint64 = ratio > BASIS_POINTS ? ratio - BASIS_POINTS : 0
      const [hP, lP] = mulw(collUSD, premiumRateBps)
      premiumUsd = divw(hP, lP, BASIS_POINTS)
      if (buyoutTokenPrice.native > 0) {
        const [hPT, lPT] = mulw(premiumUsd, USD_MICRO_UNITS)
        premiumTokens = divw(hPT, lPT, buyoutTokenPrice.native)
      }
    }
    return {
      ltvBps: new UintN64(ltv),
      premiumUsd: new UintN64(premiumUsd),
      premiumTokens: new UintN64(premiumTokens),
    }
  }

  @abimethod({ allowActions: 'NoOp' })
  public seizeLSTFromUSD(
    seizeUsd: UintN64,
    underlyingPrice: UintN64,
    circulatingLst: UintN64,
    totalDeposits: UintN64,
    availableLst: UintN64,
  ): UintN64 {
    const price: uint64 = underlyingPrice.native
    if (price === 0) return new UintN64(0)
    const [hUnd, lUnd] = mulw(seizeUsd.native, USD_MICRO_UNITS)
    const seizeUnderlying: uint64 = divw(hUnd, lUnd, price)
    const [hL, lL] = mulw(seizeUnderlying, circulatingLst.native)
    let seizeLst: uint64 = divw(hL, lL, totalDeposits.native)
    if (seizeLst > availableLst.native) seizeLst = availableLst.native
    return new UintN64(seizeLst)
  }

  @abimethod({ allowActions: 'NoOp' })
  public repayBaseFromSeizedLST(
    seizeLst: UintN64,
    totalDeposits: UintN64,
    circulatingLst: UintN64,
    underlyingPrice: UintN64,
    bonusBps: UintN64,
    basePrice: UintN64,
  ): UintN64 {
    if (seizeLst.native === 0 || basePrice.native === 0) return new UintN64(0)
    const [hUnderlying, lUnderlying] = mulw(seizeLst.native, totalDeposits.native)
    const seizedUnderlying: uint64 = divw(hUnderlying, lUnderlying, circulatingLst.native)
    const [hSeizeUSD, lSeizeUSD] = mulw(seizedUnderlying, underlyingPrice.native)
    const seizeUsdActual: uint64 = divw(hSeizeUSD, lSeizeUSD, USD_MICRO_UNITS)
    const [hRepayUSD, lRepayUSD] = mulw(seizeUsdActual, BASIS_POINTS)
    const repayUsd: uint64 = divw(hRepayUSD, lRepayUSD, BASIS_POINTS + bonusBps.native)
    const [hRepayBase, lRepayBase] = mulw(repayUsd, USD_MICRO_UNITS)
    const repayBase: uint64 = divw(hRepayBase, lRepayBase, basePrice.native)
    return new UintN64(repayBase)
  }

  @abimethod({ allowActions: 'NoOp' })
  public lstFromUsd(
    usdAmount: UintN64,
    circulatingLst: UintN64,
    totalDeposits: UintN64,
    baseTokenPrice: UintN64,
  ): UintN64 {
    if (baseTokenPrice.native === 0) return new UintN64(0)
    const [hUnderlying, lUnderlying] = mulw(usdAmount.native, USD_MICRO_UNITS)
    const removableUnderlying: uint64 = divw(hUnderlying, lUnderlying, baseTokenPrice.native)
    const [hL, lL] = mulw(removableUnderlying, circulatingLst.native)
    return new UintN64(divw(hL, lL, totalDeposits.native))
  }

  @abimethod({ allowActions: 'NoOp' })
  public requiredCollateralUsd(debtUsd: UintN64, ltvBps: UintN64): UintN64 {
    const target: uint64 = ltvBps.native
    if (target === 0) return new UintN64(0)
    const [hReq, lReq] = mulw(debtUsd.native, BASIS_POINTS)
    return new UintN64(divw(hReq, lReq, target))
  }
}
