import {createServer} from '../../frontend/node_modules/vite/dist/node/index.js'
import {chromium} from '../../frontend/node_modules/playwright-core/index.mjs'
import {readFile,writeFile} from 'node:fs/promises'
const server=await createServer({root:'E:/qoder/frontend',configFile:'E:/qoder/frontend/vite.config.js',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:{port:0}}})
let browser
try{
  await server.listen()
  browser=await chromium.launch({headless:true,executablePath:'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'})
  const context=await browser.newContext()
  await context.route(url=>url.pathname.startsWith('/api/'),r=>r.fulfill({status:503,body:'{}',contentType:'application/json'}))
  const page=await context.newPage()
  const errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/today`)
  await page.getByRole('button',{name:'安排工作',exact:true}).waitFor()
  const src=await readFile(new URL('./probes.mjs',import.meta.url),'utf8')
  const start=src.indexOf('  const db=')
  const end=src.indexOf('  await writeFile')
  const body=src.slice(start,end).replaceAll('await server.ssrLoadModule(','await import(').replaceAll("await import('../../frontend/node_modules/vue/index.mjs')", "await import(performance.getEntriesByType('resource').map(r=>r.name).find(n=>n.includes('/vue.js')))")
  const results=await page.evaluate(`(async()=>{const results=[];let svc;try{${body}\nreturn results}finally{svc?.stop()}})()`)
  await writeFile(new URL('./browser-results.json',import.meta.url),JSON.stringify({results,errors,clock:'controlled wallNow, real Chromium IndexedDB'},null,2))
  console.log(JSON.stringify({results,errors},null,2))
}finally{if(browser)await browser.close();await server.close()}
