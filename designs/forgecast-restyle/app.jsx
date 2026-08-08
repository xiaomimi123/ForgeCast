// 画布入口：三块 1440 宽画板并排，可拖动/聚焦对比
function App() {
  return (
    <DesignCanvas>
      <DCSection id="restyle" title="ForgeCast 全站视觉体系 · 三个方向" subtitle="以「找项目」页 + 导航壳为样张 · 选定后全站套用">
        <DCArtboard id="dir-a" label="A · 晨雾工作台（现状精修）" width={1440} height={1210}>
          <DirectionA />
        </DCArtboard>
        <DCArtboard id="dir-b" label="B · 终端指挥台（深色）" width={1440} height={1210}>
          <DirectionB />
        </DCArtboard>
        <DCArtboard id="dir-c" label="C · 锻造车间（浅色大胆）" width={1440} height={1210}>
          <DirectionC />
        </DCArtboard>
        <DCPostIt id="note">A 稳：低改造成本，蓝白提纯。B 酷：深色终端感，数字用等宽字。C 有记忆点：炉火橙 + 粗墨线，呼应「锻造」。可混搭：比如 A 的骨架 + C 的橙色点缀。</DCPostIt>
      </DCSection>
    </DesignCanvas>
  )
}
ReactDOM.createRoot(document.getElementById('root')).render(<App />)
