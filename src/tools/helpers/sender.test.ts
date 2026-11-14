import { describe, expect, it } from 'vitest'
import type { AccountConfig } from './config.js'
import { EmailMCPError } from './errors.js'
import { parseFrom, replySender, resolveSender, senderAddresses } from './sender.js'

const icloud: AccountConfig = {
  id: 'icloud',
  email: 'me@icloud.com',
  password: 'p',
  imap: { host: 'imap.mail.me.com', port: 993, secure: true },
  smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
  aliases: ['hello@example.com', 'Support@example.com']
}

const gmail: AccountConfig = {
  id: 'gmail',
  email: 'me@gmail.com',
  password: 'p',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(EmailMCPError)
    return (error as EmailMCPError).code
  }
  return undefined
}

describe('senderAddresses', () => {
  it('lists the account address first, then its aliases', () => {
    expect(senderAddresses(icloud)).toEqual(['me@icloud.com', 'hello@example.com', 'Support@example.com'])
    expect(senderAddresses(gmail)).toEqual(['me@gmail.com'])
  })
})

describe('parseFrom', () => {
  it('accepts a bare address', () => {
    expect(parseFrom(' hello@example.com ')).toEqual({ address: 'hello@example.com', header: 'hello@example.com' })
  })

  it('accepts a display name, quoted or not', () => {
    expect(parseFrom('Support Team <support@example.com>')).toEqual({
      address: 'support@example.com',
      header: '"Support Team" <support@example.com>'
    })
    expect(parseFrom('"Support" <support@example.com>').header).toBe('"Support" <support@example.com>')
    expect(parseFrom('<support@example.com>').header).toBe('support@example.com')
  })

  it('drops quotes and backslashes inside a display name', () => {
    expect(parseFrom('A "B" \\C <a@example.com>').header).toBe('"A B C" <a@example.com>')
  })

  it('rejects text that is not an address', () => {
    expect(codeOf(() => parseFrom('nobody'))).toBe('VALIDATION_ERROR')
    expect(codeOf(() => parseFrom('a@example.com, b@example.com'))).toBe('VALIDATION_ERROR')
    expect(codeOf(() => parseFrom('Name <not an address>'))).toBe('VALIDATION_ERROR')
  })
})

describe('resolveSender', () => {
  it('sends as the account itself without from', () => {
    const { account, sender } = resolveSender([icloud], undefined, undefined)
    expect(account).toBe(icloud)
    expect(sender).toEqual({ address: 'me@icloud.com', header: 'me@icloud.com' })
  })

  it('keeps the multi-account rule without from', () => {
    expect(codeOf(() => resolveSender([icloud, gmail]))).toBe('AMBIGUOUS_ACCOUNT')
  })

  it('accepts an alias of the named account, case-insensitively', () => {
    const { account, sender } = resolveSender([icloud, gmail], 'icloud', 'SUPPORT@example.com')
    expect(account).toBe(icloud)
    expect(sender.address).toBe('SUPPORT@example.com')
  })

  it('accepts the account address itself as from', () => {
    expect(resolveSender([icloud, gmail], 'me@gmail.com', 'Me <me@gmail.com>').sender.header).toBe(
      '"Me" <me@gmail.com>'
    )
  })

  it('rejects an address the named account cannot send as, listing the allowed ones', () => {
    try {
      resolveSender([icloud, gmail], 'gmail', 'hello@example.com')
      throw new Error('expected a rejection')
    } catch (error) {
      expect((error as EmailMCPError).code).toBe('SENDER_NOT_ALLOWED')
      expect((error as EmailMCPError).suggestion).toContain('me@gmail.com')
    }
  })

  it('picks the owning account from the alias alone', () => {
    expect(resolveSender([gmail, icloud], undefined, 'hello@example.com').account).toBe(icloud)
    expect(resolveSender([gmail, icloud], undefined, 'me@gmail.com').account).toBe(gmail)
  })

  it('ignores a disabled owner', () => {
    const disabled = { ...icloud, enabled: false }
    expect(codeOf(() => resolveSender([gmail, disabled], undefined, 'hello@example.com'))).toBe('SENDER_NOT_ALLOWED')
  })

  it('rejects an unknown address in single and multi mode', () => {
    expect(codeOf(() => resolveSender([icloud], undefined, 'stranger@example.com'))).toBe('SENDER_NOT_ALLOWED')
    expect(codeOf(() => resolveSender([icloud, gmail], undefined, 'stranger@example.com'))).toBe('SENDER_NOT_ALLOWED')
  })

  it('reports an address two accounts claim as ambiguous', () => {
    const other = { ...gmail, aliases: ['hello@example.com'] }
    expect(codeOf(() => resolveSender([icloud, other], undefined, 'hello@example.com'))).toBe('AMBIGUOUS_ACCOUNT')
  })
})

describe('replySender', () => {
  it('answers from the alias the original was addressed to', () => {
    expect(replySender(icloud, { to: 'Hello <HELLO@example.com>' }).address).toBe('hello@example.com')
  })

  it('looks at Cc when To has no alias', () => {
    expect(replySender(icloud, { to: 'someone@else.org', cc: 'support@example.com' }).address).toBe(
      'Support@example.com'
    )
  })

  it('prefers whichever own address comes first', () => {
    expect(replySender(icloud, { to: 'me@icloud.com, hello@example.com' }).address).toBe('me@icloud.com')
  })

  it('falls back to the account address', () => {
    expect(replySender(icloud, { to: 'list@lists.example.org' }).address).toBe('me@icloud.com')
    expect(replySender(icloud, {}).address).toBe('me@icloud.com')
    expect(replySender(gmail, { to: 'hello@example.com' }).address).toBe('me@gmail.com')
  })
})
