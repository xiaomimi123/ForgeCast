// 方向 A 「晨雾工作台」— 现状蓝白的精修版：更干净的中性底、更强的层次、克制的蓝
function VaCard({ c }) {
  return (
    <div className="va-card">
      <div className="va-cardtop">
        <div className="va-names">
          <div className="va-owner">{c.owner}/{c.isNew && <span className="va-new">NEW</span>}</div>
          <div className="va-name">{c.name}</div>
        </div>
        <div className="va-score"><b>{c.score}</b><i>分</i></div>
      </div>
      <div className="va-desc">{c.desc}</div>
      <div className="va-meta">
        <span>⭐ {c.stars}</span>
        <span className="va-lic">{c.license}</span>
        <span className="va-cat">{c.cat}</span>
      </div>
      <div className="va-insight">
        <div><em>买家</em>{c.buyer}</div>
        <div><em>痛点</em>{c.pain}</div>
      </div>
      <div className="va-foot">
        <span className="va-days">{c.days} 天前更新</span>
        <div className="va-acts">
          <button className={'va-fav' + (c.fav ? ' on' : '')}>{c.fav ? '★' : '☆'}</button>
          <button className="va-detail">详情</button>
          <button className="va-gh">↗</button>
        </div>
      </div>
    </div>
  )
}

function DirectionA() {
  return (
    <div className="va" lang="zh">
      <header className="va-nav">
        <div className="va-logo"><span className="va-logomark" />ForgeCast</div>
        <nav>{FC_NAV.map((n, i) => <a key={n} className={i === 0 ? 'on' : ''}>{n}</a>)}</nav>
        <div className="va-auto">每日 08:00 自动抓取 · 昨日 +3</div>
      </header>
      <main className="va-main">
        <div className="va-toprow">
          <h1>找项目</h1>
          <div className="va-topacts">
            <button className="va-primary">抓取候选</button>
            <button className="va-ghost">全部重新评分</button>
            <span className="va-count">共 46 个候选</span>
          </div>
        </div>
        <div className="va-tabs">
          {FC_TABS.map((t, i) => <button key={t} className={i === 0 ? 'on' : ''}>{t}{i === 1 ? ' (2)' : ''}</button>)}
        </div>
        <div className="va-chips">
          {FC_CATS.map((t, i) => <button key={t} className={i === 0 ? 'on' : ''}>{t}</button>)}
        </div>
        <div className="va-grid">
          {FC_CANDS.map((c) => <VaCard key={c.name} c={c} />)}
        </div>
      </main>
    </div>
  )
}
Object.assign(window, { DirectionA })
