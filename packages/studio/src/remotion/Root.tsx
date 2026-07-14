import type { ComponentType, FC } from 'react'
import { Composition } from 'remotion'
import type { FlashProps, StoryProps } from '../props'
import { Flash } from './Flash'
import { Story } from './Story'

const defaultFlashProps: FlashProps = { painTitle: '还在用老办法？', sellingPoint: '一套系统扛住3个人的活', cta: '想要同款？评论区扣1', brandName: 'forgecast' }
const defaultStoryProps: StoryProps = { bubbles: [{ who: 'them', text: '能做个这个吗？' }, { who: 'me', text: '可以，等我一天' }], sellingPoint: '一套系统扛三人份', cta: '想要同款？评论区扣1', brandName: 'forgecast' }

// Remotion v4 无 zod schema 时 Composition 泛型推断需 cast（同 Flash 既有做法）
const asComp = (c: FC<any>) => c as unknown as ComponentType<Record<string, unknown>>

export const RemotionRoot: FC = () => {
  return (
    <>
      <Composition id="Flash" component={asComp(Flash)} durationInFrames={450} fps={30} width={1080} height={1920} defaultProps={defaultFlashProps as unknown as Record<string, unknown>} />
      <Composition id="Story" component={asComp(Story)} durationInFrames={600} fps={30} width={1080} height={1920} defaultProps={defaultStoryProps as unknown as Record<string, unknown>} />
    </>
  )
}
