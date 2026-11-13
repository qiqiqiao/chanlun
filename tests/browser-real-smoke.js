#!/usr/bin/env node
/*
 * Real-browser smoke test for the HTML/script/CSS path.
 * Install the optional runner with: npm install --no-save --package-lock=false playwright@1.65.0
 */
'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')

const root = path.resolve(__dirname, '..')
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch (e) {
      res.writeHead(400).end('Bad URL')
      return
    }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const filename = path.resolve(root, relative)
    if (filename !== root && !filename.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden')
      return
    }
    fs.readFile(filename, (err, body) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500).end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filename)] || 'application/octet-stream' })
      res.end(body)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, url: 'http://127.0.0.1:' + address.port + '/' })
    })
  })
}

function sampleKlines(interval) {
  const step = interval === '5m' ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000
  const end = Math.floor(Date.now() / step) * step
  return Array.from({ length: 120 }, (_, i) => {
    const open = 100 + i * 0.1
    return [end - (119 - i) * step, open.toFixed(2), (open + 1).toFixed(2), (open - 1).toFixed(2), (open + 0.2).toFixed(2), '10']
  })
}

async function installNetworkStubs(page, intervalCalls) {
  await page.addInitScript(() => {
    window.__smokeWebSockets = []
    class SmokeWebSocket {
      constructor(url) {
        this.url = url
        this.readyState = 0
        window.__smokeWebSockets.push(url)
        queueMicrotask(() => {
          this.readyState = 1
          if (this.onopen) this.onopen()
        })
      }
      send() {}
      close() {
        this.readyState = 3
        if (this.onclose) this.onclose()
      }
    }
    window.WebSocket = SmokeWebSocket
  })
  await page.route('https://api.binance.com/api/v3/klines**', async (route) => {
    const url = new URL(route.request().url())
    const interval = url.searchParams.get('interval') || '1d'
    intervalCalls.push(interval)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sampleKlines(interval))
    })
  })
}

async function run() {
  const { server, url } = await startStaticServer()
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const pageErrors = []
    const intervalCalls = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await installNetworkStubs(page, intervalCalls)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('BTCUSDT'), null, { timeout: 20000 })
    if ((await page.locator('#chart canvas').count()) === 0) throw new Error('Chart did not create a canvas')
    await page.waitForFunction(() => window.__smokeWebSockets.length > 0, null, { timeout: 10000 })

    await page.locator('#periods [data-period="5m"]').click()
    const switchDeadline = Date.now() + 20000
    while (!intervalCalls.includes('5m') && Date.now() < switchDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!intervalCalls.includes('5m')) throw new Error('Switching to 5m did not request 5m candles')
    if (pageErrors.length) throw new Error('Browser page errors: ' + pageErrors.join('; '))

    const fallbackPage = await browser.newPage()
    await fallbackPage.route('https://cdn.jsdelivr.net/npm/klinecharts@10.0.2/**', (route) => route.abort())
    await fallbackPage.goto(url, { waitUntil: 'domcontentloaded' })
    await fallbackPage.locator('#chart .cdn-error').waitFor({ state: 'visible', timeout: 10000 })
    const fallbackText = await fallbackPage.locator('#chart .cdn-error').textContent()
    if (!fallbackText.includes('图表库加载失败')) throw new Error('CDN failure message is missing')

    process.stdout.write('Browser smoke passed: chart startup, 5m switch, WebSocket subscription, CDN fallback\n')
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
}

run().catch((error) => {
  process.stderr.write((error && error.stack) || String(error))
  process.stderr.write('\n')
  process.exitCode = 1
})
