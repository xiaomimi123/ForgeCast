import { describe, expect, it } from 'vitest'
import { isLicenseOk } from '../src/license'

describe('isLicenseOk', () => {
  it('允许 MIT/Apache-2.0/BSD/ISC/MPL', () => {
    for (const l of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0']) {
      expect(isLicenseOk(l), l).toBe(true)
    }
  })
  it('拒绝 GPL 系、SSPL、null、未知', () => {
    for (const l of ['GPL-3.0', 'AGPL-3.0', 'LGPL-3.0', 'SSPL-1.0', 'NOASSERTION', null, undefined, '']) {
      expect(isLicenseOk(l as any), String(l)).toBe(false)
    }
  })
})
