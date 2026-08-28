import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { killByPort } from '../src/kill-port'

describe('killByPort', () => {
  it('杀掉真实监听某端口的子进程，该子进程随后退出', async () => {
    // 子进程绑定随机端口(0)并把实际分配到的端口打印到 stdout，避免固定端口号冲突
    const child = spawn('node', ['-e', `
      const s = require('http').createServer().listen(0, () => { console.log(s.address().port) })
    `])
    const port = await new Promise<number>((resolve) => {
      child.stdout.once('data', (d) => resolve(Number(d.toString().trim())))
    })
    await killByPort(port)
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.on('exit', () => resolve())
    })
    // 进程被 kill -9（SIGKILL）终止时，Node 只设置 signalCode，exitCode 永远为 null——
    // 这是 Node 的既定行为（见 child_process 文档），因此断言退出方式而非 exitCode。
    expect(child.exitCode === null ? child.signalCode : child.exitCode).not.toBeNull()
  }, 10000)

  it('端口没有占用者 → 不抛错，直接返回', async () => {
    await expect(killByPort(58733)).resolves.toBeUndefined()
  })
})
