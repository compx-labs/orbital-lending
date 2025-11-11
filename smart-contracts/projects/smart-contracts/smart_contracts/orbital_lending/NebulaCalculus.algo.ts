/* eslint-disable @typescript-eslint/no-unused-vars */
import { abimethod, contract, Contract } from '@algorandfoundation/algorand-typescript'
import { uint64 } from '@algorandfoundation/algorand-typescript'

/**
 * NebulaCalculus is intended to encapsulate all heavy math and rate logic so the
 * primary lending apps can stay focused on state/box management.
 * The methods are currently stubs; real implementations will move over from
 * `OrbitalLending*.algo.ts` once validated.
 */
@contract({ name: 'nebula-calculus', avmVersion: 11 })
export class NebulaCalculus extends Contract {
  @abimethod({ allowActions: 'NoOp' })
  public utilNormBps(totalDeposits: uint64, totalBorrows: uint64, utilCapBps: uint64): uint64 {
    void totalDeposits
    void totalBorrows
    void utilCapBps
    return 0
  }

  @abimethod({ allowActions: 'NoOp' })
  public aprBpsKinked(
    uNormBps: uint64,
    baseBps: uint64,
    kinkNormBps: uint64,
    slope1Bps: uint64,
    slope2Bps: uint64,
    maxAprBps: uint64,
  ): uint64 {
    void uNormBps
    void baseBps
    void kinkNormBps
    void slope1Bps
    void slope2Bps
    void maxAprBps
    return 0
  }

  @abimethod({ allowActions: 'NoOp' })
  public sliceFactorWad(deltaT: uint64, lastAprBps: uint64, indexScale: uint64, secondsPerYear: uint64): uint64 {
    void deltaT
    void lastAprBps
    void indexScale
    void secondsPerYear
    return 0
  }

  @abimethod({ allowActions: 'NoOp' })
  public currentDebtFromSnapshot(principal: uint64, borrowIndexWad: uint64, userIndexWad: uint64): uint64 {
    void principal
    void borrowIndexWad
    void userIndexWad
    return 0
  }

  @abimethod({ allowActions: 'NoOp' })
  public lstDue(amount: uint64, circulatingLst: uint64, totalDeposits: uint64): uint64 {
    void amount
    void circulatingLst
    void totalDeposits
    return 0
  }

  @abimethod({ allowActions: 'NoOp' })
  public aprSplit(
    interest: uint64,
    protocolShareBps: uint64,
    basisPoints: uint64,
  ): { depositorInterest: uint64; protocolInterest: uint64 } {
    void interest
    void protocolShareBps
    void basisPoints
    return { depositorInterest: 0, protocolInterest: 0 }
  }
}
