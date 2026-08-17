#!/usr/bin/env node
/*!
 * tests/run.js —— 轻量测试 runner（零依赖，node 运行）
 *
 * 用法：node tests/run.js [test-file.js ...]
 *   （默认运行 tests/ 下所有 *.test.js）
 */
'use strict'

const fs = require('fs')
const path = require('path')

const tests = []
global.__registerTest = (name, fn) => tests.push({ name, fn })

const args = process.argv.slice(2)
const files = args.length
  ? args.map((f) => path.resolve(process.cwd(), f))
  : fs.readdirSync(__dirname)
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => path.join(__dirname, f))

for (const f of files) {
  require(f)
}

let pass = 0
let fail = 0
for (const t of tests) {
  try {
    t.fn()
    console.log('  \u2713 ' + t.name)
    pass++
  } catch (e) {
    console.error('  \u2717 ' + t.name)
    console.error('    ' + String(e && e.message).split('\n').join('\n    '))
    if (e && e.stack) {
      const lines = e.stack.split('\n').filter((l) => l.includes('.test.js') || l.includes('tests/'))
      for (const l of lines.slice(0, 4)) console.error('    ' + l.trim())
    }
    fail++
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (files.length ? '  [' + files.map((f) => path.basename(f)).join(', ') + ']' : ''))
process.exit(fail ? 1 : 0)
