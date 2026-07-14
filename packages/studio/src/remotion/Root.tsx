import type { ComponentType, FC } from 'react'
import type { CalculateMetadataFunction } from 'remotion'
import { Composition } from 'remotion'
import type { DemoProps, FlashProps, StoryProps } from '../props'
import { Demo } from './Demo'
import { Flash } from './Flash'
import { Story } from './Story'

const defaultFlashProps: FlashProps = { painTitle: '还在用老办法？', sellingPoint: '一套系统扛住3个人的活', cta: '想要同款？评论区扣1', brandName: 'forgecast' }
const defaultStoryProps: StoryProps = { bubbles: [{ who: 'them', text: '能做个这个吗？' }, { who: 'me', text: '可以，等我一天' }], sellingPoint: '一套系统扛三人份', cta: '想要同款？评论区扣1', brandName: 'forgecast' }
const defaultDemoProps: DemoProps = { painTitle: '还在用老办法？', painPoints: ['现状很低效', '每天多花好几小时'], priceAnchor: '外面几万，我这一顿火锅钱', cta: '评论区扣1', brandName: 'forgecast' }

// Remotion v4 无 zod schema 时 Composition 泛型推断需 cast（同 Flash 既有做法）
const asComp = (c: FC<any>) => c as unknown as ComponentType<Record<string, unknown>>

const FPS = 30

/** 据 props.cues 末尾时刻对齐时长：Math.max(默认帧数, ceil(lastCue.end*fps))；无 cues 时保持默认（flash 不受影响） */
const calcMetadataFromCues = (defaultDurationInFrames: number): CalculateMetadataFunction<Record<string, unknown>> => ({ props }) => {
  const cues = props.cues as Array<{ start: number; end: number; text: string }> | undefined
  if (!cues || cues.length === 0) return {}
  const lastEnd = cues[cues.length - 1].end
  return { durationInFrames: Math.max(defaultDurationInFrames, Math.ceil(lastEnd * FPS)) }
}

export const RemotionRoot: FC = () => {
  return (
    <>
      <Composition id="Flash" component={asComp(Flash)} durationInFrames={450} fps={30} width={1080} height={1920} defaultProps={defaultFlashProps as unknown as Record<string, unknown>} />
      <Composition id="Story" component={asComp(Story)} durationInFrames={600} fps={30} width={1080} height={1920} defaultProps={defaultStoryProps as unknown as Record<string, unknown>} calculateMetadata={calcMetadataFromCues(600)} />
      <Composition id="Demo" component={asComp(Demo)} durationInFrames={1800} fps={30} width={1080} height={1920} defaultProps={defaultDemoProps as unknown as Record<string, unknown>} calculateMetadata={calcMetadataFromCues(1800)} />
    </>
  )
}
