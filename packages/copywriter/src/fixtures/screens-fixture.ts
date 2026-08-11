export type ScreenType = 'dashboard' | 'list' | 'detail'

/** 离线 mock 演示页：三种固定 HTML 套品牌名，不调 LLM（每个 LLM 能力必须自带 mock 的既有规矩） */
export function mockScreenHtml(type: ScreenType, brandName: string): string {
  if (type === 'dashboard') {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${brandName} 仪表盘</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "PingFang SC", sans-serif; }
  body { width: 1600px; height: 1000px; background: #f5f6fa; color: #1f2430; display: flex; }
  .nav { width: 220px; background: #1f2430; color: #fff; padding: 24px 16px; }
  .nav .brand { font-size: 18px; font-weight: 700; margin-bottom: 24px; }
  .nav .item { padding: 10px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 4px; opacity: .75; }
  .nav .item.on { background: #3b5bfd; opacity: 1; }
  .main { flex: 1; padding: 28px; }
  .topbar { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
  .stat { background: #fff; border-radius: 10px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .stat .n { font-size: 28px; font-weight: 700; color: #3b5bfd; }
  .stat .l { font-size: 13px; color: #6b7280; margin-top: 6px; }
  .chart { background: #fff; border-radius: 10px; height: 480px; box-shadow: 0 1px 3px rgba(0,0,0,.08); display: flex; align-items: flex-end; padding: 24px; gap: 12px; }
  .bar { flex: 1; background: linear-gradient(180deg,#3b5bfd,#8aa0ff); border-radius: 6px 6px 0 0; }
</style></head>
<body>
  <div class="nav"><div class="brand">${brandName}</div>
    <div class="item on">数据概览</div><div class="item">客户管理</div><div class="item">订单</div><div class="item">设置</div>
  </div>
  <div class="main">
    <div class="topbar">数据概览</div>
    <div class="grid">
      <div class="stat"><div class="n">1,284</div><div class="l">今日活跃用户</div></div>
      <div class="stat"><div class="n">¥86,420</div><div class="l">本月收入</div></div>
      <div class="stat"><div class="n">342</div><div class="l">待处理工单</div></div>
      <div class="stat"><div class="n">98.6%</div><div class="l">系统可用率</div></div>
    </div>
    <div class="chart">
      <div class="bar" style="height:40%"></div><div class="bar" style="height:65%"></div><div class="bar" style="height:50%"></div>
      <div class="bar" style="height:80%"></div><div class="bar" style="height:60%"></div><div class="bar" style="height:90%"></div>
      <div class="bar" style="height:70%"></div><div class="bar" style="height:55%"></div>
    </div>
  </div>
</body></html>`
  }
  if (type === 'list') {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${brandName} 列表</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "PingFang SC", sans-serif; }
  body { width: 1600px; height: 1000px; background: #f5f6fa; color: #1f2430; display: flex; }
  .nav { width: 220px; background: #1f2430; color: #fff; padding: 24px 16px; }
  .nav .brand { font-size: 18px; font-weight: 700; margin-bottom: 24px; }
  .nav .item { padding: 10px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 4px; opacity: .75; }
  .nav .item.on { background: #3b5bfd; opacity: 1; }
  .main { flex: 1; padding: 28px; }
  .topbar { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { text-align: left; padding: 14px 18px; font-size: 14px; border-bottom: 1px solid #eef0f4; }
  th { background: #fafbfc; color: #6b7280; font-weight: 600; }
  .tag { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; background: #e8f5e9; color: #2e7d32; }
</style></head>
<body>
  <div class="nav"><div class="brand">${brandName}</div>
    <div class="item">数据概览</div><div class="item on">客户管理</div><div class="item">订单</div><div class="item">设置</div>
  </div>
  <div class="main">
    <div class="topbar">客户列表</div>
    <table>
      <tr><th>客户名称</th><th>联系人</th><th>套餐</th><th>状态</th><th>到期时间</th></tr>
      <tr><td>杭州速达电商</td><td>王经理</td><td>专业版</td><td><span class="tag">正常</span></td><td>2026-12-01</td></tr>
      <tr><td>深圳美好家居</td><td>李总</td><td>标准版</td><td><span class="tag">正常</span></td><td>2026-09-15</td></tr>
      <tr><td>成都优品汇</td><td>张经理</td><td>专业版</td><td><span class="tag">正常</span></td><td>2027-01-20</td></tr>
      <tr><td>广州鑫源贸易</td><td>陈总</td><td>标准版</td><td><span class="tag">正常</span></td><td>2026-10-08</td></tr>
      <tr><td>武汉万家便利</td><td>刘经理</td><td>基础版</td><td><span class="tag">正常</span></td><td>2026-11-30</td></tr>
    </table>
  </div>
</body></html>`
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${brandName} 设置</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "PingFang SC", sans-serif; }
  body { width: 1600px; height: 1000px; background: #f5f6fa; color: #1f2430; display: flex; }
  .nav { width: 220px; background: #1f2430; color: #fff; padding: 24px 16px; }
  .nav .brand { font-size: 18px; font-weight: 700; margin-bottom: 24px; }
  .nav .item { padding: 10px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 4px; opacity: .75; }
  .nav .item.on { background: #3b5bfd; opacity: 1; }
  .main { flex: 1; padding: 28px; max-width: 720px; }
  .topbar { font-size: 20px; font-weight: 700; margin-bottom: 20px; }
  .card { background: #fff; border-radius: 10px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid #eef0f4; }
  .row:last-child { border-bottom: none; }
  .row .l { font-size: 14px; color: #374151; }
  .row .v { font-size: 14px; color: #6b7280; }
  .btn { background: #3b5bfd; color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font-size: 13px; }
</style></head>
<body>
  <div class="nav"><div class="brand">${brandName}</div>
    <div class="item">数据概览</div><div class="item">客户管理</div><div class="item">订单</div><div class="item on">设置</div>
  </div>
  <div class="main">
    <div class="topbar">账户设置</div>
    <div class="card">
      <div class="row"><span class="l">企业名称</span><span class="v">${brandName} 企业版</span></div>
      <div class="row"><span class="l">当前套餐</span><span class="v">专业版 · 20 席位</span></div>
      <div class="row"><span class="l">到期时间</span><span class="v">2026-12-31</span></div>
      <div class="row"><span class="l">数据备份</span><span class="v">每日自动备份</span></div>
      <div class="row"><span class="l">操作</span><button class="btn">升级套餐</button></div>
    </div>
  </div>
</body></html>`
}
