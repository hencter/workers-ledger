#!/usr/bin/env node
/**
 * source-stub-server.mjs —— 自测用的本地桩服务（零外部依赖）
 *
 * 用途：让 tools/check-sources.mjs 的每一档判定都能在离线可控环境下真实触发，
 *       不必依赖 gov.cn 能不能连上。所有法规名称与链接均为虚构。
 *
 * 用法：
 *   node tools/selftest-fixtures/source-stub-server.mjs 18321
 *
 * 路由：
 *   /ok-page       200，页面版本与注册表一致            → 正常
 *   /newer-page    200，页面出现更新的修正日期           → 版本不一致（硬）
 *   /maybe-page    200，更新的日期离法规名称很远         → 疑似版本不一致（软）
 *   /deleted       404                                  → 确定失效（硬）
 *   /gone          410                                  → 确定失效（硬）
 *   /boom          500                                  → 没连上（软）
 *   /forbidden     403                                  → 待人工确认（软）
 *   /stall         永不响应，触发超时                    → 没连上（软）
 *   /api/handles/10.9999/ok      200 {responseCode:100} → DOI 已登记
 *   /api/handles/10.9999/missing 404 {responseCode:200} → DOI 查无此号（硬）
 *
 * 握手不兼容一档：把 /ok-page 的地址写成 https:// 指向本服务的明文端口即可触发。
 */

import http from 'node:http'

const PORT = Number(process.argv[2] || 18321)
const LAW = '中华人民共和国测试劳动合同法'

const HTML_HEAD = { 'Content-Type': 'text/html; charset=utf-8' }
const JSON_HEAD = { 'Content-Type': 'application/json; charset=utf-8' }

function page(law, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${law}</title></head><body><h1>${law}</h1>${body}</body></html>`
}

function json(res, status, obj) {
  res.writeHead(status, JSON_HEAD)
  res.end(JSON.stringify(obj))
}

const routes = {
  '/ok-page': (res) => {
    res.writeHead(200, HTML_HEAD)
    res.end(page(LAW, '<p>（2012年12月28日修正，2013年7月1日施行）</p>'))
  },
  '/newer-page': (res) => {
    res.writeHead(200, HTML_HEAD)
    res.end(page('测试新版法规', '<p>（2018年12月29日修正，2013年7月1日施行）</p>'))
  },
  '/maybe-page': (res) => {
    res.writeHead(200, HTML_HEAD)
    // 法规名称出现后隔开很远才出现更新的修正日期，用来触发「疑似」档
    res.end(page('测试疑似新版法规', '<p>' + '与版本无关的填充文字。'.repeat(60) + '2018年12月29日修正</p>'))
  },
  '/deleted': (res) => {
    res.writeHead(404, HTML_HEAD)
    res.end('404 页面不存在')
  },
  '/gone': (res) => {
    res.writeHead(410, HTML_HEAD)
    res.end('410 页面已下线')
  },
  '/boom': (res) => {
    res.writeHead(500, HTML_HEAD)
    res.end('500 服务端错误')
  },
  '/forbidden': (res) => {
    res.writeHead(403, HTML_HEAD)
    res.end('403 拒绝访问')
  },
  '/stall': () => {
    // 故意不响应，用来触发超时（连接挂着直到客户端放弃）
  },
  '/api/handles/10.9999/ok': (res) => json(res, 200, { responseCode: 100, handle: '10.9999/ok' }),
  '/api/handles/10.9999/missing': (res) => json(res, 404, { responseCode: 200, handle: '10.9999/missing', values: [] }),
}

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0]
  const handler = routes[path]
  if (handler) {
    handler(res)
    return
  }
  res.writeHead(404, HTML_HEAD)
  res.end('404 桩服务没有这个路由：' + path)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`桩服务已启动：http://127.0.0.1:${PORT}`)
  console.log('按 Ctrl+C 或结束进程即可停止。')
})
