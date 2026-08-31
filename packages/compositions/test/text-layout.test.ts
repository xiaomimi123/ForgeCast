import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import React from 'react'
import { TextContent } from '../src/Text'
import type { Layer } from '../src/videospec-types'

const L = (): Layer => ({
  id: 'x', kind: 'text', from: null, overridden: false, start: 0, duration: 5, track: 1,
  content: { kind: 'text', text: 'a' }, style: {}, effects: [{ type: 'decode' }],
})

describe('TextContent 解码期布局稳定', () => {
  it('鬼影阶段真字仍挂载（仅透明度为 0），不会被替换掉——否则字符宽度不同会导致抖动', () => {
    // step = min(0.055, 1.1/1) = 0.055；t0 = 0；鬼影窗口 [0, 0.225)
    const { container } = render(
      React.createElement(TextContent, { layer: L(), text: 'a', timeSec: 0.01, elemIndexBase: 0 }),
    )
    const fin = container.querySelector('.fin')
    expect(fin).not.toBeNull()
    expect(fin?.textContent).toBe('a')
    const finStyle = (fin as HTMLElement).style
    expect(finStyle.opacity).toBe('0')
    // 鬼影覆盖层作为同级的绝对定位元素存在，不参与文档流宽度
    const gh = container.querySelector('.gh')
    expect(gh).not.toBeNull()
  })
})
