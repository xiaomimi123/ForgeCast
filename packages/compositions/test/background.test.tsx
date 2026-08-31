import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Background, Camera } from '../src/Background'

describe('Background', () => {
  it.each(['grid', 'aurora', 'matrix', 'synth', 'mesh'])('变体 %s 渲出 #techbg', (v) => {
    const { container } = render(<Background variant={v} timeSec={1} durationSec={12} />)
    expect(container.querySelector('#techbg')).not.toBeNull()
  })

  it('变体缺省/none 时不渲背景（story 聊天场不加科技背景）', () => {
    const { container } = render(<Background variant={undefined} timeSec={1} durationSec={12} />)
    expect(container.querySelector('#techbg')).toBeNull()
  })

  it('背景随时间推进（不是静止帧）', () => {
    const at = (t: number) => (render(<Background variant="matrix" timeSec={t} durationSec={12} />)
      .container.querySelector('#techbg .mv') as HTMLElement).style.transform
    expect(at(0)).not.toBe(at(6))
  })
})

describe('Camera', () => {
  it('全片缓慢推移：起点 scale 1，中途已放大', () => {
    const at = (t: number) => (render(<Camera timeSec={t} durationSec={12}><i /></Camera>)
      .container.querySelector('#cam') as HTMLElement).style.transform
    expect(at(0)).toContain('scale(1)')
    expect(at(6)).not.toContain('scale(1)')
  })

  it('末键落在片长之外（×1.15），故片尾仍在移动', () => {
    const at = (t: number) => (render(<Camera timeSec={t} durationSec={12}><i /></Camera>)
      .container.querySelector('#cam') as HTMLElement).style.transform
    expect(at(11.0)).not.toBe(at(12.0))
  })
})
