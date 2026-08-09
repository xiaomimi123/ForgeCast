import type { IntroDetail } from '../../api'

/** 产品说明书五节渲染：产品简介/核心功能/目标用户/行业痛点/换皮卖点。
 *  CandidateDrawer（候选期）与 ProjectDetailPage（立项后未分析时的回退展示）共用，避免两份平行 JSX。 */
export default function IntroSections({ intro }: { intro: IntroDetail }) {
  return (
    <div className="space-y-4 text-sm">
      <section>
        <h3 className="mb-1 font-medium text-ink">产品简介</h3>
        <p className="text-sub">{intro.summary}</p>
      </section>
      <section>
        <h3 className="mb-1 font-medium text-ink">核心功能</h3>
        <ul className="list-disc space-y-0.5 pl-5 text-sub">
          {intro.features.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      </section>
      <section>
        <h3 className="mb-1 font-medium text-ink">目标用户</h3>
        <p className="text-sub">{intro.targetUser}</p>
      </section>
      <section>
        <h3 className="mb-1 font-medium text-ink">行业痛点</h3>
        <p className="text-sub">{intro.painPoint}</p>
      </section>
      <section>
        <h3 className="mb-1 font-medium text-ink">换皮卖点</h3>
        <p className="text-sub">{intro.rebrandIdea}</p>
      </section>
    </div>
  )
}
