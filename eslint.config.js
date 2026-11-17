/*!
 * eslint.config.js —— 问题导向的 lint 配置（ESLint 9 flat config）
 *
 * 原则：只抓真实缺陷（未定义变量、未使用变量、不可达代码、危险比较等），
 * 不启用风格类规则——项目既有风格（无分号、单引号）保持不变，避免大面积噪音改写。
 *
 * 环境拆分：
 *   - 浏览器脚本（根目录 + src/）：IIFE 包装，同时探测 window 与 module
 *   - tests/：Node CommonJS
 */
'use strict'

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  fetch: 'readonly',
  WebSocket: 'readonly',
  AbortController: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  console: 'readonly',
  klinecharts: 'readonly'
}

const NODE_GLOBALS = {
  module: 'writable',
  require: 'readonly',
  process: 'readonly',
  __dirname: 'readonly',
  Buffer: 'readonly',
  global: 'readonly'
}

const PROBLEM_RULES = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-fallthrough': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-compare-neg-zero': 'error',
  'use-isnan': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-new-wrappers': 'error',
  'no-global-assign': 'error',
  'no-implicit-globals': 'off'
}

module.exports = [
  {
    ignores: ['node_modules/**', 'eslint.config.js']
  },
  {
    // 浏览器脚本：IIFE 内同时探测 typeof module（Node 兼容导出）
    files: ['chanlun.js', 'data-layer.js', 'exchange-adapters.js', 'realtime.js', 'chart-drawing.js', 'main.js', 'src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: Object.assign({}, BROWSER_GLOBALS, {
        // 浏览器脚本用 typeof module 探测 Node 环境并 require src 模块
        module: 'readonly',
        require: 'readonly',
        globalThis: 'readonly'
      })
    },
    rules: PROBLEM_RULES
  },
  {
    // Node 测试与工具脚本（CommonJS）
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: Object.assign({}, NODE_GLOBALS, {
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        URLSearchParams: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        queueMicrotask: 'readonly',
        // browser-real-smoke.js 在 Node 中用 vm 模拟浏览器环境
        window: 'readonly',
        document: 'readonly'
      })
    },
    rules: PROBLEM_RULES
  }
]
