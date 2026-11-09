const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const {execFileSync} = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const files = [{path:'中文笔记-test.md',content:'# 中文笔记\n\n> 引用测试\n\n![图片](images/test.png)\n'}, {path:'images/test.png',encoding:'base64',content:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='}]
const live = process.argv.includes('--live')
const token = live ? execFileSync('gh', ['auth','token'], {encoding:'utf8'}).trim() : 'test-token'
let state = { githubConfig: {repo:'CCCCOOH/yejian-backup-test',folder:'test-snapshots',token} }
let requests = [], status = 200
const fakeFetch = async (url, options) => {
 requests.push({url,options})
 const body = options.body ? JSON.parse(options.body) : {}
 const result = url.endsWith('/git/trees') ? {sha:'new-tree'} : url.endsWith('/git/commits') ? {sha:'new-commit'} : url.includes('/git/commits/') ? {tree:{sha:'base-tree'}} : url.includes('/git/ref/') ? {object:{sha:'parent'}} : url.endsWith('/git/blobs') ? {sha:'image-blob'} : {default_branch:'main',size:1}
 return {ok:status === 200,status,json:async()=>result}
}
const context = vm.createContext({console,fetch:live?fetch:fakeFetch,AbortSignal,crypto:globalThis.crypto,btoa,
 chrome:{permissions:{contains:async()=>true},storage:{local:{get:async()=>state,set:async data=>Object.assign(state,data)}}}})
vm.runInContext(fs.readFileSync(path.join(root,'image-storage.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'github-backup.js'),'utf8'),context)
;(async()=>{
 const result = await context.backupToGitHub(files)
 assert.equal(result.count,1)
 assert.match(result.url,/test-snapshots/)
 if(live){
  const relative = decodeURIComponent(result.url.split('/tree/')[1].split('/').slice(1).join('/'))
  const actual = execFileSync('gh',['api',`repos/CCCCOOH/yejian-backup-test/contents/${relative}/中文笔记-test.md`],{encoding:'utf8'})
  assert.equal(Buffer.from(JSON.parse(actual).content,'base64').toString('utf8'),files[0].content)
  console.log('PASS: live private-repository backup, Unicode Markdown and image uploaded:',result.url)
 } else {
  const tree = JSON.parse(requests.find(r=>r.url.endsWith('/git/trees')).options.body)
  assert.equal(tree.base_tree,'base-tree')
  assert.equal(tree.tree.length,2)
  const update = requests.find(r=>r.options.method==='PATCH')
  assert.equal(JSON.parse(update.options.body).force,false)
  for(const failure of [401,403,404,409,422,500]){
   status=failure
   await assert.rejects(()=>context.backupToGitHub(files))
  }
  status=200
  const job=context.backupToGitHub(files)
  assert.throws(()=>context.backupToGitHub(files),/已有备份/)
  await job
  assert.throws(()=>context.validateGitHubConfig({repo:'https://evil.test/x',token}),/仓库/)
  console.log('PASS: snapshots preserve existing tree; no force push; error and concurrency handling')
 }
})().catch(error=>{console.error(error.message);process.exitCode=1})
