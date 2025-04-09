import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { describe, expect, it } from 'vitest'
import { WeLend } from './contract.algo'

describe('WeLend contract', () => {
  const ctx = new TestExecutionContext()
  it('Logs the returned value when sayHello is called', () => {
    const contract = ctx.contract.create(WeLend)

    const result = contract.hello('Sally')

    expect(result).toBe('Hello, Sally')
  })
})
