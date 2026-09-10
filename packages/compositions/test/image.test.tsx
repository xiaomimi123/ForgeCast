import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ImageContent, encodePathForUrl, imgFit } from '../src/Image'

describe('encodePathForUrl', () => {
  it('编码空格与 # 与 ?，保留子目录分隔符', () => {
    expect(encodePathForUrl('my shot#1.png')).toBe('my%20shot%231.png')
    expect(encodePathForUrl('a?b.png')).toBe('a%3Fb.png')
    expect(encodePathForUrl('screens/a b.png')).toBe('screens/a%20b.png')
  })
})

describe('ImageContent', () => {
  it('phoneWrap 套手机外框', () => {
    const { container } = render(<ImageContent src="a.png" cssClass="phoneWrap" style={{}} />)
    expect(container.querySelector('.phoneWrap .phone img')).not.toBeNull()
  })
  it('wideWrap 同时有虚化背景与前景图', () => {
    const { container } = render(<ImageContent src="a.png" cssClass="wideWrap" style={{}} />)
    expect(container.querySelector('.wideBg')).not.toBeNull()
    expect(container.querySelector('.wideFg img')).not.toBeNull()
  })
  it('未知 cssClass 退化为裸 img', () => {
    const { container } = render(<ImageContent src="a.png" cssClass={undefined} style={{}} />)
    expect(container.querySelector('img')).not.toBeNull()
    expect(container.querySelector('.phoneWrap')).toBeNull()
  })
  it('两处发射点都编码（img src 与 background-image）', () => {
    const { container } = render(<ImageContent src="my shot#1.png" cssClass="wideWrap" style={{}} />)
    const bg = container.querySelector('.wideBg') as HTMLElement
    expect(bg.style.backgroundImage).toContain('my%20shot%231.png')
    expect(bg.style.backgroundImage).not.toContain('my shot#1.png')
    const img = container.querySelector('.wideFg img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('my%20shot%231.png')
  })
})

describe('imgFit（素材层图片自适配）', () => {
  it('只设 width → width:100%;height:auto（等比）', () => {
    const { container } = render(<ImageContent src="a.png" cssClass={undefined} style={{ width: 200 }} />)
    const img = container.querySelector('img') as HTMLImageElement
    expect(img.style.width).toBe('100%')
    expect(img.style.height).toBe('auto')
    expect(img.style.objectFit).toBe('contain')
  })

  it('双维都设 → 两个 100% + object-fit:contain（不变形不裁切）', () => {
    const { container } = render(<ImageContent src="a.png" cssClass={undefined} style={{ width: 200, height: 200 }} />)
    const img = container.querySelector('img') as HTMLImageElement
    expect(img.style.width).toBe('100%')
    expect(img.style.height).toBe('100%')
    expect(img.style.objectFit).toBe('contain')
    expect(img.style.display).toBe('block')
  })

  it('两维都没设 → 不写任何内联样式（自然尺寸，旧行为）', () => {
    expect(imgFit({})).toBeUndefined()
    const { container } = render(<ImageContent src="a.png" cssClass={undefined} style={{}} />)
    expect(container.querySelector('img')!.getAttribute('style')).toBeNull()
  })

  it('门禁：phoneWrap/wideWrap 截图层的 img 零内联样式（模板版式不受影响）', () => {
    for (const cls of ['phoneWrap', 'wideWrap']) {
      const { container } = render(
        <ImageContent src="a.png" cssClass={cls} style={{ width: 200, height: 200 }} />,
      )
      for (const img of Array.from(container.querySelectorAll('img'))) {
        expect(img.getAttribute('style')).toBeNull()
      }
    }
  })
})
