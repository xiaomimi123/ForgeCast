import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ImageContent, encodePathForUrl } from '../src/Image'

describe('encodePathForUrl', () => {
  it('编码空格与 # 与 ?，保留子目录分隔符', () => {
    expect(encodePathForUrl('my shot#1.png')).toBe('my%20shot%231.png')
    expect(encodePathForUrl('a?b.png')).toBe('a%3Fb.png')
    expect(encodePathForUrl('screens/a b.png')).toBe('screens/a%20b.png')
  })
})

describe('ImageContent', () => {
  it('phoneWrap 套手机外框', () => {
    const { container } = render(<ImageContent src="a.png" cssClass="phoneWrap" />)
    expect(container.querySelector('.phoneWrap .phone img')).not.toBeNull()
  })
  it('wideWrap 同时有虚化背景与前景图', () => {
    const { container } = render(<ImageContent src="a.png" cssClass="wideWrap" />)
    expect(container.querySelector('.wideBg')).not.toBeNull()
    expect(container.querySelector('.wideFg img')).not.toBeNull()
  })
  it('未知 cssClass 退化为裸 img', () => {
    const { container } = render(<ImageContent src="a.png" cssClass={undefined} />)
    expect(container.querySelector('img')).not.toBeNull()
    expect(container.querySelector('.phoneWrap')).toBeNull()
  })
  it('两处发射点都编码（img src 与 background-image）', () => {
    const { container } = render(<ImageContent src="my shot#1.png" cssClass="wideWrap" />)
    const bg = container.querySelector('.wideBg') as HTMLElement
    expect(bg.style.backgroundImage).toContain('my%20shot%231.png')
    expect(bg.style.backgroundImage).not.toContain('my shot#1.png')
    const img = container.querySelector('.wideFg img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('my%20shot%231.png')
  })
})
