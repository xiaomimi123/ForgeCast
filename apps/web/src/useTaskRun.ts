import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeTask, type TaskEvent } from './api'

export interface TaskRun {
  /** 任务是否在跑 */
  running: boolean
  /** 最新一条进度消息（''=还没有）。任务结束后保留最后一条，直到下次 run() */
  lastMessage: string
  /** 已用秒数：running 期间每秒自增；结束时定格为总耗时 */
  elapsedSec: number
  /** 完整日志（含 error 前缀），给需要日志框的页面用 */
  logs: string[]
  /** 最近一次是否以 error 收尾 */
  failed: boolean
  /** 启动任务。start() 负责发 POST 并返回 taskId。
   *  done/error 时自动收尾并回调 onSettled(ok, lastEvent)；
   *  start() 自身抛错（网络/4xx）也会被兜住，回调 onSettled(false, null)。
   *  running 期间重复调用直接忽略。 */
  run: (
    start: () => Promise<string>,
    onSettled?: (ok: boolean, e: TaskEvent | null) => void,
  ) => Promise<void>
}

/** 长任务统一运行状态：发起 → 订阅 SSE → 累计日志 → 秒表计时 → 收尾。
 *  一个组件里有几个互相独立的任务就调几次（如 ScoutPage 调 5 次）。 */
export function useTaskRun(): TaskRun {
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [lastMessage, setLastMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)
  const startedAtRef = useRef(0)
  // running 的 ref 镜像：run() 里做重入判断不能读闭包里的 state（拿到的是旧值）
  const runningRef = useRef(false)
  // 卸载时关掉 EventSource——原先各处手写的 subscribeTask 没做，抽屉一关连接还挂着
  const closeRef = useRef<(() => void) | null>(null)
  // start() 的 promise 还没 resolve 时组件就卸载：closeRef 此刻还是 null，卸载 effect 关不到东西；
  // 等 subscribeTask 真的建好连接，得知自己已卸载就立刻关掉，不能存进 closeRef（没人会再来关它）
  const unmountedRef = useRef(false)

  useEffect(() => () => { unmountedRef.current = true; closeRef.current?.() }, [])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000)
    return () => clearInterval(t)
  }, [running])

  const run = useCallback(async (
    start: () => Promise<string>,
    onSettled?: (ok: boolean, e: TaskEvent | null) => void,
  ): Promise<void> => {
    if (runningRef.current) return
    runningRef.current = true
    startedAtRef.current = Date.now()
    setRunning(true); setLogs([]); setLastMessage(''); setFailed(false); setElapsedSec(0)

    const settle = (ok: boolean, e: TaskEvent | null) => {
      runningRef.current = false
      closeRef.current = null
      setRunning(false)
      setElapsedSec(Math.round((Date.now() - startedAtRef.current) / 1000))
      if (!ok) setFailed(true)
      onSettled?.(ok, e)
    }

    try {
      const taskId = await start()
      const close = subscribeTask(taskId, (e) => {
        setLogs((l) => [...l, `${e.type === 'error' ? '❌ ' : ''}${e.message}`])
        setLastMessage(e.message)
        if (e.type === 'done' || e.type === 'error') settle(e.type === 'done', e)
      })
      if (unmountedRef.current) close(); else closeRef.current = close
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setLogs((l) => [...l, `❌ ${msg}`])
      setLastMessage(msg)
      settle(false, null)
    }
  }, [])

  return { running, lastMessage, elapsedSec, logs, failed, run }
}
