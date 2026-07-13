import type { ComponentType, FC } from 'react'
import { Composition } from 'remotion'
import type { FlashProps } from '../props'
import { Flash } from './Flash'

const defaultFlashProps: FlashProps = {
  painTitle: '还在用老办法？',
  sellingPoint: '一套系统扛住3个人的活',
  cta: '想要同款？评论区扣1',
  brandName: 'forgecast',
}

// Remotion 根：注册 flash Composition（1080×1920 / 30fps / 15s）
export const RemotionRoot: FC = () => {
  return (
    <Composition
      id="Flash"
      // 无 zod schema 时 Composition<Schema,Props> 无法从 component 反推出 FlashProps，
      // 会退化成 Record<string, unknown> 导致类型报错；此处仅类型层面 cast，运行时不受影响
      component={Flash as unknown as ComponentType<Record<string, unknown>>}
      durationInFrames={450}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={defaultFlashProps}
    />
  )
}
