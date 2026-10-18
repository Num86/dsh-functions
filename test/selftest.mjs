/**
 * dsh-functions 自检 —— 只需要真 cordis，不需要别的插件，也不需要 DSH 在跑。
 *
 *   node test/selftest.mjs
 *
 * 覆盖：插件形状 / 三条路由 / 注册表与冻结顺序 / 确认窗归一化 / 分级确认 /
 *       二级菜单与置顶字段 / 内置的「加载功能」（发指令进会话那条路）。
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const require = createRequire(join(ROOT, 'package.json'));

let failures = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log('  ok  ' + name);
  else {
    failures += 1;
    console.log('  XX  ' + name + (extra === '' ? '' : ' -- ' + extra));
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 真 cordis：装过就从依赖解析；跑在 DSH 里就从应用包解析（asar 只有 CJS 层认）。 */
const cordisCandidates = [
  '@deepseek-ai/cordis',
  'cordis',
  join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'cordis'),
];
let cordis = null;
let cordisError = '';
for (const candidate of cordisCandidates) {
  try {
    const isPath = candidate.includes(':') || candidate.includes('\\') || candidate.includes('/');
    const mod = require(isPath ? candidate : require.resolve(candidate));
    const value = mod && typeof mod.Context === 'function' ? mod : (mod && mod.default ? mod.default : mod);
    if (typeof value.Context !== 'function') throw new Error('这个包里没有 Context');
    cordis = value;
    break;
  } catch (error) {
    cordisError = String((error && error.message) || error);
  }
}
if (cordis === null) {
  console.log('  XX  拿不到真 cordis（试试 npm i -D @deepseek-ai/cordis）：' + cordisError);
  process.exit(1);
}

const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href);

/** 一个带假 connection 的 Context：路由注册进 Map，测试自己发 Request。 */
function newContext() {
  const routes = new Map();
  const ctx = new cordis.Context();
  ctx.provide('connection', {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  });
  return { ctx, routes };
}
const post = (path, body) =>
  new Request('http://127.0.0.1' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const jsonOf = async (response) => await response.json();

console.log('dsh-functions 自检\n');

console.log('0 插件形状');
check('导出 apply / name / inject', typeof plugin.apply === 'function' && typeof plugin.name === 'string' && Array.isArray(plugin.inject));
check('没有 export default（有的话 cordis 会丢掉 inject）', plugin.default === undefined);

console.log('1 三条路由');
const app = newContext();
await app.ctx.plugin(plugin, {});
await sleep(200);
check('/list 在', app.routes.has('/api/dshFunctions/list'));
check('/prepare 在', app.routes.has('/api/dshFunctions/prepare'));
check('/run 在', app.routes.has('/api/dshFunctions/run'));

const listOf = async (routes) => (await jsonOf(await routes.get('/api/dshFunctions/list').fetch(new Request('http://127.0.0.1/api/dshFunctions/list')))).entries ?? [];

console.log('2 注册表与排序');
const functions = app.ctx.get('functions');
check('functions 服务已 provide', typeof functions?.register === 'function');
// 历史上这里翻过车：normalizeEntry 先冻结、register 再补 seq -> TypeError -> 整条功能注册不上。
const later = functions.register({ id: 'z.later', title: '后来的', order: 5, run: async () => ({ message: 'ok' }) });
functions.register({ id: 'a.first', title: '先来的', order: 99, run: async () => ({ message: 'ok' }) });
functions.register({ id: 'p.top', title: '置顶的', pinned: true, order: 999, run: async () => ({ message: 'ok' }) });
const ids = (await listOf(app.routes)).map((entry) => entry.id);
check('三条都注册上了（冻结顺序没翻车）', ids.includes('z.later') && ids.includes('a.first') && ids.includes('p.top'), JSON.stringify(ids));
check('置顶的在最前面', ids[0] === 'p.top' || ids.indexOf('functions.load') === 0, JSON.stringify(ids));
later();
const afterUnregister = (await listOf(app.routes)).map((entry) => entry.id);
check('注销函数真的把它撤了', !afterUnregister.includes('z.later'), JSON.stringify(afterUnregister));

console.log('3 确认窗归一化');
const shapes = newContext();
await shapes.ctx.plugin(plugin, {});
await sleep(150);
const sFn = shapes.ctx.get('functions');
sFn.register({ id: 'c.array', title: 'A', confirms: [{ title: 'T1', message: 'M1' }], run: async () => ({ message: 'ok' }) });
sFn.register({ id: 'c.object', title: 'B', confirm: { title: 'T2', message: 'M2' }, run: async () => ({ message: 'ok' }) });
sFn.register({ id: 'c.bare', title: 'C', confirm: { message: '只有消息' }, run: async () => ({ message: 'ok' }) });
sFn.register({ id: 'c.none', title: 'D', run: async () => ({ message: 'ok' }) });
const prepare = async (id, stage) => await jsonOf(await shapes.routes.get('/api/dshFunctions/prepare').fetch(post('/api/dshFunctions/prepare', { id, stage })));
check('confirms[] 认', (await prepare('c.array', 0)).confirms?.[0]?.title === 'T1');
check('confirm{} 认', (await prepare('c.object', 0)).confirms?.[0]?.title === 'T2');
check('裸 {message} 也认（历史上这条挂过）', (await prepare('c.bare', 0)).confirms?.[0]?.message === '只有消息');
check('没有确认窗就是空数组', (await prepare('c.none', 0)).confirms?.length === 0);
check('不存在的 id 报 404', (await shapes.routes.get('/api/dshFunctions/prepare').fetch(post('/api/dshFunctions/prepare', { id: 'nope', stage: 0 }))).status === 404);

console.log('4 分级确认（第 N 级在第 N-1 级点掉之后才算）');
const staged = newContext();
await staged.ctx.plugin(plugin, {});
await sleep(150);
let asked = 0;
staged.ctx.get('functions').register({
  id: 's.staged', title: '分级', prepare: (stage) => {
    asked += 1;
    return stage === 0 ? [{ title: '第一级', message: '一级' }] : stage === 1 ? [{ title: '第二级', message: '二级' }] : null;
  },
  run: async () => ({ message: 'ok' }),
});
const stagedPrepare = async (stage) => await jsonOf(await staged.routes.get('/api/dshFunctions/prepare').fetch(post('/api/dshFunctions/prepare', { id: 's.staged', stage })));
check('第 0 级', (await stagedPrepare(0)).confirms?.[0]?.title === '第一级');
check('第 1 级', (await stagedPrepare(1)).confirms?.[0]?.title === '第二级');
check('第 2 级 = 没有更多', (await stagedPrepare(2)).confirms?.length === 0);
check('宿主是按需算的（每次 prepare 都调一次）', asked >= 3, String(asked));

console.log('5 二级菜单与置顶字段');
const shape = newContext();
await shape.ctx.plugin(plugin, {});
await sleep(150);
const shapeList = await listOf(shape.routes);
const loader = shapeList.find((entry) => entry.id === 'functions.load');
check('内置「加载功能」在清单里', loader !== undefined, JSON.stringify(shapeList.map((e) => e.id)));
check('它是置顶的（pinned）', loader?.pinned === true, JSON.stringify(loader));
check('标题是「加载功能」', loader?.title === '加载功能', String(loader?.title));
shape.ctx.get('functions').register({ id: 'm.parent', title: '家族', submenu: true });
shape.ctx.get('functions').register({ id: 'm.child', title: '子项', parent: 'm.parent', run: async () => ({ message: 'ok' }) });
const shapeIds = (await listOf(shape.routes));
check('父项带 submenu 标记', shapeIds.find((e) => e.id === 'm.parent')?.submenu === true);
check('子项带 parent 标记', shapeIds.find((e) => e.id === 'm.child')?.parent === 'm.parent');
let threw = false;
try { shape.ctx.get('functions').register({ id: 'm.bad', title: '空壳' }); } catch (error) { threw = true; }
check('既没 run 也没 shell 也不是 submenu -> 报错', threw);

console.log('6 内置「加载功能」：把指令发进会话');
const sent = [];
const load = newContext();
load.ctx.provide('agents', { list: () => [], get: (id) => ({ agent: { followup: (payload) => sent.push({ id, payload }) } }) });
await load.ctx.plugin(plugin, {});
await sleep(150);
const runLoad = async (body) => await jsonOf(await load.routes.get('/api/dshFunctions/run').fetch(post('/api/dshFunctions/run', body)));
const noSession = await runLoad({ id: 'functions.load', confirm: 'yes' });
check('没有会话可发 -> 拒，且一个字节都没发', noSession.ok === false && sent.length === 0, JSON.stringify(noSession));
check('缺少 confirm=yes -> 拒', (await runLoad({ id: 'functions.load' })).ok === false);
const ok = await runLoad({ id: 'functions.load', confirm: 'yes', sessionId: 'session-demo' });
check('报了会话 -> 发送成功', ok.ok === true, JSON.stringify(ok));
check('恰好一条、发给目标会话', sent.length === 1 && sent[0].id === 'session-demo', JSON.stringify(sent.map((s) => s.id)));
check('role/source 都是 user（不然进不去）', sent[0]?.payload?.role === 'user' && sent[0]?.payload?.source?.kind === 'user');
const instruction = sent[0]?.payload?.content?.[0]?.text ?? '';
check('指令里有「非官方插件」', instruction.includes('非官方'));
check('指令里要求列编号并等用户回', instruction.includes('编号') && instruction.includes('等'));
check('指令里点名了「严谨猜测插件接口形式」', instruction.includes('严谨猜测插件接口形式'));
check('指令里写了两种加法（宿主 / 客户端）', instruction.includes('宿主半边') && instruction.includes('客户端半边'));
check('指令里说明了 profile 目录怎么找（DSH_PROFILE_DIR / %USERPROFILE%）', instruction.includes('DSH_PROFILE_DIR') && instruction.includes('%USERPROFILE%'));
check('指令里没有本机绝对路径 / 房间路径', !/D:[\/]Documents/i.test(instruction) && !instruction.includes('Chinese_room'));
check('指令里给了两种安装入口（plugin_manager / 插件页添加插件）', instruction.includes('plugin_manager') && instruction.includes('添加插件'));
check('指令里提醒装完宿主半边要重启 DSH', instruction.includes('重启 DSH'));
check('没有非官方插件时要求照实说', instruction.includes('没有可加载的'));

await app.ctx.stop?.();
console.log('\n' + (failures === 0 ? '全部通过' : '失败 ' + String(failures) + ' 项'));
process.exitCode = failures === 0 ? 0 : 1;
