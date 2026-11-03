/*!
 * tests/fetch-timeout.test.js —— fetch 超时回归测试
 *
 * 背景：main.js fetchJson 用的裸 fetch(url) 无超时。连接 hung 住时 getBars
 * 永远不 settle → finally 不执行 → 加载蒙层永久不消失（“切换周期后一直
 * 加载中”）。修复：AbortController 单次超时（默认 15s），超时按可重试错误
 * 走指数退避，最坏 3 次尝试后必定报错、loading 必定清除。
 */
'use strict'
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const t = (name, fn) => global.__registerTest('fetch-timeout: ' + name, fn)

const CORE = ['src/config.js', 'src/merge.js', 'src/fractal.js', 'src/stroke.js', 'src/segment.js',
  'src/center.js', 'src/divergence.js', 'src/analyzer.js', 'chanlun.js', 'data-layer.js',
  'realtime.js', 'main.js']

// vm 沙箱：hang 住的 fetch + 真实定时器/AbortController + 最小 DOM（init 延迟不执行）
function loadApp(fetchImpl) {
  const sb = {
    console,
    __CHANLUN_TEST__: true,
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout
  }
  sb.window = sb
  sb.globalThis = sb
  sb.WebSocket = class { constructor() { throw new Error('no real WS in test') } }
  const fakeEl = { addEventListener() {}, classList: { toggle() {} }, textContent: '', value: '', querySelectorAll: () => [] }
  sb.document = { readyState: 'loading', addEventListener() {}, querySelector: () => fakeEl, querySelectorAll: () => [], createElement: () => ({}) }
  vm.createContext(sb)
  for (const f of CORE) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb, { filename: f })
  return sb
}

t('hung 住的请求必定超时失败（而不是永远等待）', async () => {
  let calls = 0
  // stub 像真 fetch 一样响应 abort（否则连测试自己都会静默 hang 住）
  const hangingFetch = (url, opts) => {
    calls++
    return new Promise((_, rej) => {
      const sig = opts && opts.signal
      if (sig) {
        if (sig.aborted) rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        else sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }
    })
  }
  const sb = loadApp(hangingFetch)
  const t0 = Date.now()
  let err = null
  try {
    await sb.__chanlunChart.fetchJson('https://example.com/hang', { timeout: 60 })
  } catch (e) {
    err = e
  }
  const elapsed = Date.now() - t0
  assert(err, '必须抛错')
  assert(/超时/.test(err.message), '应为超时错误，实际: ' + err.message)
  // 3 次尝试（60ms 超时 + 800/1600ms 退避抖动）：远小于无限等待，且有明确上界
  assert(elapsed < 15000, '必须在有界时间内失败，实际 ' + elapsed + 'ms')
  assert.strictEqual(calls, 3, '超时可重试，共 3 次尝试')
})

t('正常响应不受超时影响', async () => {
  const sb = loadApp(async () => ({ ok: true, text: async () => '{"a":1}' }))
  const r = await sb.__chanlunChart.fetchJson('https://example.com/ok', { timeout: 1000 })
  assert.strictEqual(JSON.stringify(r), '{"a":1}', '跨 vm 上下文用 JSON 比较')
})
