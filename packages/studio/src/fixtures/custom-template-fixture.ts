/**
 * mock 模式固定模板骨架：纯色背景 + 居中文字，N 段动态数量，满足 generateCustomTemplate
 * 的占位符契约（見 custom-template.ts 的 validateCustomTemplateHtml）。绝不调用 ctx.llm。
 */
export function mockCustomTemplateHtml(segmentCount: number, width: number, height: number): string {
  const segs = Array.from({ length: segmentCount }, (_, i) => (
    `      <div id="s${i}" class="clip fill pad center" data-start="{{seg${i}_start}}" data-duration="{{seg${i}_dur}}" data-track-index="1">
        <div class="segText">{{seg${i}_text}}</div>
      </div>`
  )).join('\n')
  return `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <script src="gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #101018; font-family: "Noto Sans CJK SC", "PingFang SC", sans-serif; }
      .fill { position: absolute; inset: 0; } .pad { padding: 80px; }
      .center { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
      .segText { font-size: 64px; font-weight: 800; color: #fff; line-height: 1.4; }
      .cap { position: absolute; left: 50%; bottom: 100px; transform: translateX(-50%); max-width: 90%; text-align: center; font-size: 36px; color: #fff; background: rgba(0,0,0,.7); padding: 14px 28px; border-radius: 12px; z-index: 5; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{{duration}}" data-width="${width}" data-height="${height}">
${segs}
      <!--HF_CAPTIONS-->
      <!--HF_AUDIO-->
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>`
}
