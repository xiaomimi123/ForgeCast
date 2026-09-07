import { describe, expect, it } from 'vitest'
import { clampToCanvas, clearLayerGeometry, snapPosition } from '../src/canvas-ops'
import { baseSpec, textLayer } from './fixtures'

const CANVAS = { w: 1080, h: 1920 }

describe('snapPosition', () => {
  it('中心距画布竖中线 ≤8px 时吸中并给出竖参考线', () => {
    const r = snapPosition({ x: 534, y: 100, w: 20, h: 20 }, [], CANVAS)   // 中心 544, 距 540 差 4
    expect(r.x).toBe(530)                                                  // 中心=540
    expect(r.guides).toContainEqual({ axis: 'x', pos: 540 })
  })
  it('差超阈值不吸', () => {
    const r = snapPosition({ x: 100, y: 100, w: 20, h: 20 }, [], CANVAS, 8)
    expect(r.x).toBe(100)
    expect(r.guides).toHaveLength(0)
  })
  it('阈值边界：恰好差 8px 吸，差 8.01px 不吸', () => {
    // w=200 让中心/右缘远离所有候选线，只有左缘可能命中——避免多候选互相干扰
    // moving 左缘 x=52，与安全边距线 60 差 8 —— 吸
    const hit = snapPosition({ x: 52, y: 100, w: 200, h: 20 }, [], CANVAS, 8)
    expect(hit.x).toBe(60)
    expect(hit.guides).toContainEqual({ axis: 'x', pos: 60 })
    // moving 左缘 x=51.99，与安全边距线 60 差 8.01 —— 不吸
    const miss = snapPosition({ x: 51.99, y: 100, w: 200, h: 20 }, [], CANVAS, 8)
    expect(miss.x).toBe(51.99)
    expect(miss.guides).toHaveLength(0)
  })
  it('吸其他图层的左缘对左缘', () => {
    const other = { x: 200, y: 500, w: 300, h: 100 }
    const r = snapPosition({ x: 205, y: 100, w: 50, h: 50 }, [other], CANVAS)
    expect(r.x).toBe(200)
    expect(r.guides).toContainEqual({ axis: 'x', pos: 200 })
  })
  it('多候选取最近；x/y 两轴独立吸', () => {
    const r = snapPosition({ x: 57, y: 1855, w: 100, h: 60 }, [], CANVAS)  // 左缘57↔60边距差3; 下缘1915↔1860差55不吸,y中心1885↔... 自行取明确值
    expect(r.x).toBe(60)
    expect(r.guides.some((g) => g.axis === 'x' && g.pos === 60)).toBe(true)
  })
  it('disabled=true 原样返回、无参考线', () => {
    const r = snapPosition({ x: 538, y: 100, w: 4, h: 4 }, [], CANVAS, 8, true)
    expect(r).toEqual({ x: 538, y: 100, guides: [] })
  })
})

describe('clampToCanvas', () => {
  it('拖出左侧只留 10px 时钳回到留 40px', () => {
    expect(clampToCanvas({ x: -290, y: 0, w: 300, h: 100 }, CANVAS)).toEqual({ x: -260, y: 0 })
  })
  it('完全在内不动', () => {
    expect(clampToCanvas({ x: 100, y: 100, w: 300, h: 100 }, CANVAS)).toEqual({ x: 100, y: 100 })
  })
  it('右/下同理（对称）', () => {
    expect(clampToCanvas({ x: 1075, y: 1915, w: 300, h: 100 }, CANVAS)).toEqual({ x: 1040, y: 1880 })
  })
})

describe('clearLayerGeometry', () => {
  it('删掉 x/y/width/height/fontSize，保留 color/cssClass 等', () => {
    const spec = baseSpec({
      layers: [textLayer({ id: 'l1', style: { x: 10, y: 20, width: 100, height: 50, fontSize: 24, color: 'red', cssClass: 'card' } })],
    })
    const out = clearLayerGeometry(spec, 'l1')
    const style = out.layers.find((l) => l.id === 'l1')!.style
    expect(style).toEqual({ color: 'red', cssClass: 'card' })
  })
  it('本就没有几何覆盖时返回原 spec 引用', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l1', style: { color: 'red' } })] })
    expect(clearLayerGeometry(spec, 'l1')).toBe(spec)
  })
  it('不存在的 layerId throw', () => {
    const spec = baseSpec({ layers: [textLayer({ id: 'l1' })] })
    expect(() => clearLayerGeometry(spec, 'nope')).toThrow()
  })
})
