/** 可商用协议白名单（SPDX id）；其余一律不通过（一票否决） */
export const ALLOWED_LICENSES = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0',
])

export function isLicenseOk(spdx: string | null | undefined): boolean {
  return !!spdx && ALLOWED_LICENSES.has(spdx)
}
