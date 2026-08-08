// 方向 C 「锻造车间」— 浅色大胆版：暖纸底、粗墨线、炉火橙，呼应 Forge（锻造）的品牌隐喻
function VcCard({ c }) {
  return (
    <div className="vc-card">
      {c.isNew && <div className="vc-newtag">今日入炉</div>}
      <div className="vc-cardtop">
        <div className="vc-names">
          <div className="vc-owner">{c.owner} /</div>
          <div className="vc-name">{c.name}</div>
        </div>
        <div className="vc-stamp">{c.catShort}</div>
      </div>
      <div className="vc-desc">{c.desc}</div>
      <div className="vc-scorebar">
        <span className="vc-scorenum">{c.score}</span>
        <span className="vc-scorelabel">变现分</span>
        <span className="vc-metas">⭐{c.stars} · {c.license} · {c.days}天前</span>
      </div>
      <div className="vc-insight">
        <div><em>谁掏钱</em>{c.buyer}</div>
        <div><em>为何掏</em>{c.pain}</div>
      </div>
      <div className="vc-foot">
        <button className={'vc-fav' + (c.fav ? ' on' : '')}>{c.fav ? '★ 已收' : '☆ 收藏'}</button>
        <button className="vc-detail">看详情</button>
        <button className="vc-gh">GitHub ↗</button>
      </div>
    </div>
  )
}

function DirectionC() {
  return (
    <div className="vc" lang="zh">
      <header className="vc-nav">
        <div className="vc-logo">Forge<span>Cast</span><i>开源变现内容工厂</i></div>
        <nav>{FC_NAV.map((n, i) => <a key={n} className={i === 0 ? 'on' : ''}>{n}</a>)}</nav>
        <div className="vc-auto">每日 08:00 进料 · 昨日 +3</div>
      </header>
      <main className="vc-main">
        <div className="vc-toprow">
          <h1>找项目<span className="vc-h1sub">从 GitHub 矿脉里挑能换钱的坯料</span></h1>
          <div className="vc-topacts">
            <button className="vc-primary">抓取候选</button>
            <button className="vc-ghost">全部重新评分</button>
          </div>
        </div>
        <div className="vc-tabrow">
          <div className="vc-tabs">
            {FC_TABS.map((t, i) => <button key={t} className={i === 0 ? 'on' : ''}>{t}{i === 1 ? ' 2' : ''}</button>)}
          </div>
          <span className="vc-count">46 个候选</span>
        </div>
        <div className="vc-chips">
          {FC_CATS.map((t, i) => <button key={t} className={i === 0 ? 'on' : ''}>{t}</button>)}
        </div>
        <div className="vc-grid">
          {FC_CANDS.map((c) => <VcCard key={c.name} c={c} />)}
        </div>
      </main>
    </div>
  )
}
Object.assign(window, { DirectionC })
