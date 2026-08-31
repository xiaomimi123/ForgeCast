// Remotion bundle 的入口：webpack 从这里开始打包，registerRoot 之后 selectComposition/Player
// 才能按 id 找到合成。经 ./index 进来是为了带上 styles/*.css 的副作用导入（base + 五模板）。
import { registerRoot } from 'remotion'
import { RemotionRoot } from './index'

registerRoot(RemotionRoot)
