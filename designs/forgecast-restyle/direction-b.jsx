// 方向 B 「终端指挥台」— 深色终端/编辑器风：墨色底、等宽数字、信号绿点缀
function VbMeter({ v }) {
  const filled = Math.round((v / 100) * 10)
  return <span className="vb-meter">{'▮'.repeat(filled)}{'▯'.repeat(10 - filled)}</span>
}

function VbCard({ c }) {
  return (
    <div className="vb-card">
      <div className="vb-cardtop">
        <div>
          <div className="vb-owner">{c.owner}/ {c.isNew && <span className="vb-new">+NEW</span>}</div>
          <div className="vb-name">{c.name}</div>
        </div>
        <div className="vb-score">{c.score}</div>
      </div>
      <VbMeter v={c.score} />
      <div className="vb-desc">{c.desc}</div>
      <div className="vb-meta">
        <span>★ {c.stars}</span><span>{c.license}</span><span className="vb-cat">{c.catShort}</span>
      </div>
      <div className="vb-insight">
        <div><em>BUYER</em>{c.buyer}</div>
        <div><em>PAIN</em>{c.pain}</div>
      </div>
      <div className="vb-foot">
        <span className="vb-days">updated {c.days}d ago</span>
        <div className="vb-acts">
          <button className={'vb-fav' + (c.fav ? ' on' : '')}>{c.fav ? '★' : '☆'}</button>
          <button className="vb-detail">详情</button>
          <button className="vb-gh">↗</button>
        </div>
      </div>
    </div>
  )
}

function DirectionB() {
  return (
    <div className="vb" lang="zh">
      <header className="vb-nav">
        <div className="vb-logo">⌁ FORGECAST</div>
        <nav>{FC_NAV.map((n, i) => <a key={n} className={i === 0 ? 'on' : ''}>{n}</a>)}</nav>
        <div className="vb-auto"><span className="vb-dot" />cron 08:00 · +3 new</div>
      </header>
      <main className="vb-main">
        <div className="vb-toprow">
          <h1>找项目 <span className="vb-sub">// scout</span></h1>
          <div className="vb-topacts">
            <button className="vb-primary">▸ 抓取候选</button>
            <button className="vb-ghost">全部重新评分</button>
            <span className="vb-count">46 candidates</span>
          </div>
        </div>
        <div className="vb-tabs">
          {FC_TABS.map((t, i) => <button key={t} className={i === 0 ? 'on' : ''}>{t}{i === 1 ? ' 2' : ''}</button>)}
        </div>
        <div className="vb-chips">
          {FC_CATS.map((t, i) => <button key={t} className={i === 0 ? 'on' : ''}>{t}</button>)}
        </div>
        <div className="vb-grid">
          {FC_CANDS.map((c) => <VbCard key={c.name} c={c} />)}
        </div>
      </main>
    </div>
  )
}
Object.assign(window, { DirectionB })
