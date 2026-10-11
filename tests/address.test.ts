import { describe, expect, test } from 'claude-code/testing'
import { bareAddressCount, pronounOf, addressReminder } from '../hooks/address'

describe('address', () => {
  test('the pronoun is watched only when the form starts with one and has a name', () => {
    expect(pronounOf('anh Minh')).toBe('anh')
    expect(pronounOf('Chị Lan')).toBe('chị')
    expect(pronounOf('Chủ dự án')).toBeNull()
    expect(pronounOf('anh')).toBeNull()
    expect(pronounOf('')).toBeNull()
  })

  test('a bare pronoun is counted; the full form, the language and code are not', () => {
    const a = 'anh Minh'
    expect(bareAddressCount('Em đã xong, anh Minh xem giúp em nhé.', a)).toBe(0)
    expect(bareAddressCount('Anh Minh ơi, hoặc anh tự chạy lệnh đó.', a)).toBe(1)
    expect(bareAddressCount('Anh muốn em làm gì tiếp? Anh chọn đi.', a)).toBe(2)
    expect(bareAddressCount('File viết bằng tiếng Anh, theo kiểu Anh Quốc, cho người Anh.', a)).toBe(0)
    expect(bareAddressCount('Chạy `echo anh` rồi xem:\n```\nanh = 1\n```\nanh Minh kiểm tra giúp.', a)).toBe(0)
    expect(bareAddressCount('nhanh lên, thanh toán xong', a)).toBe(0) // "anh" inside other words
    expect(bareAddressCount('Anh có muốn không?', 'Chủ dự án')).toBe(0) // no pronoun to watch
  })

  test('the reminder names the form and the slip count', () => {
    const r = addressReminder('anh Minh', 2)
    expect(r).toContain('"anh Minh" every time')
    expect(r).toContain('"anh" on its own 2 times')
  })
})
