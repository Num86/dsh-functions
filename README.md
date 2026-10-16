# dsh-functions

给 **DeepSeek Harness** 客户端顶端加一个可扩展的 **「功能」** 标签：
插件注册进来的一键功能都在这儿，用户不用再记着「去哪儿点 / 输入什么口令」。

    [▢]  应用   编辑   功能 3 ▾
                      ┌──────────────────────────────────────┐
                      │ 功能                                  │
                      │ 插件在这里挂上自己的一键功能            │
                      │ 加载功能        让会话去找非官方插件…   │
                      │ 读取中文房间    让当前窗口的会话读一次… │
                      │ 换会话      >   真交接或演练，展开选一条│
                      │ 插件市场        逛社区插件、一键装      │
                      │ 重启 DSH        重启 DSH，让设置生效    │
                      └──────────────────────────────────────┘

**不 patch DSH 本体，不 require React，不引任何 Harness 客户端包** ——
它就是一个普通插件：一行 Loader 条目 + 宿主半边 + 一个自带样式的客户端 bundle。

## 装

DSH → 插件 → 添加插件，填这个包的路径（tarball 或解包目录都行），然后**重启 DSH**
（服务端不热更新；客户端那半边刷新页面就有）。

手动装也行：profile 的 `package.json` 里加一条依赖 + `dsh.profile.bundles` 一行，
再在 `node_modules` 里放一个指向它的 Junction/软链。

## 五行加一条功能（宿主半边，推荐）

    // 你自己的插件 index.js
    export const inject = ['functions'];

    export function apply(ctx) {
      ctx.functions.register({
        id: 'my.tool',
        title: '干点什么',
        description: '一句话说明\n它调用的插件名',   // 第二行惯例：写它依赖的插件
        group: '我的',
        order: 10,
        confirm: { title: '干点什么', message: '现在跑？' },
        async run() { return { message: '干完了' }; },
      });
    }

`run()` 返回的 `message` 会弹在界面上；返回 `{ warnAfterMs, warnMessage }` 的话，
到点还活着就再弹一条（给「重启这种会把自己关掉的功能」兜底）。

## 字段表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | **必填**，唯一。 |
| `title` | string | **必填**，菜单显示名。 |
| `description` | string | 说明。可以带换行：**第一行讲做什么，第二行写它调用的插件**（面板渲染两行，右对齐）。 |
| `group` | string | 分组，默认「通用」。只参与排序，标签默认不画。 |
| `order` | number | 组内排序，小在前，默认 100。 |
| `pinned` | boolean | **置顶**：永远排最上面（不受分组与 order 影响）。 |
| `parent` | string | 挂到某个父项的子菜单里（二级菜单）。写了它就不出现在顶层。 |
| `submenu` | boolean | 标记这一条是**二级菜单的父项**（容器）：自己没有动作，`run` 可以不写。 |
| `icon` | string | 预留（2026-10 之后面板不再显示单字图标，写了不报错）。 |
| `confirm` | object | 一级确认窗：`{ title, message, detail, confirmText, cancelText }`。 |
| `confirms` | array | 多级确认（静态）。只有第 0 级用得到。 |
| `prepare(stage, context)` | function | **动态**确认：第 N 级的文案在第 N-1 级点掉之后才算（「有没有任务在跑」这种话隔一次就会过期）。返回 `null` = 没有更多确认。 |
| `run(job)` | function | 执行。`job = { id, ctx, log, session, confirm, alert, toast, get, post }`。**不写 run 就必须写 `shell` 或 `submenu: true`。** |
| `shell` | object | 只想跑命令：`{ command, args, cwd }`，结果整理成一句话显示。 |
| `hidden` | boolean | 不进菜单（仍可用 API 调）。 |

二级菜单长这样（照 Windows 右键菜单的逻辑：悬停 120ms 展开、离开 180ms 收起，点父项也能展开）：

    ctx.functions.register({ id: 'family', title: '换会话', submenu: true, group: '会话' });
    ctx.functions.register({ id: 'family.go', title: '真交接', parent: 'family', run() {...} });

## 三条路由（自己写客户端时才用）

    GET  /api/dshFunctions/list                 列宿主注册的功能
    POST /api/dshFunctions/prepare              { id, stage, sessionId } -> 确认窗
    POST /api/dshFunctions/run                  { id, confirm: 'yes', sessionId }

`sessionId` 是「用户正在看哪个会话」，浏览器那半边会自动带上（读客户端服务 `uiSession`）。
需要往会话里送东西的功能用它 —— **拿不到就拒，别猜**（指令发错窗口代价太大）。

## 客户端半边

功能本质上是「打开某个界面」时（打开设置里某一节、打开某个面板）才用客户端注册：

    window.__ModuleLoader__.load({
      id: 'my-plugin',
      factory(require) {
        return {
          inject: ['functions'],
          apply(ctx) {
            ctx.functions.register({
              id: 'my.open', title: '打开某面板',
              run: async (job) => { /* job.post / job.confirm / job.toast */ },
            });
          },
        };
      },
    });

面板是纯 DOM（shadow root 隔离），升级后最坏是外观退化，不会白屏。

## 内置的「加载功能」

这个插件自己内置了一条置顶功能 **加载功能**：dsh 没有「在工作区新开会话」的能力，
所以它走「把一段指令当成**用户消息**送进当前会话」这条路 ——
让会话里的 dsh 去插件库里找非官方插件、列出数字编号给用户挑，再读 README 把它们接进「功能」栏。

指令里点名了下面这一节。

## 严谨猜测插件接口形式

插件自己多半没为「功能」写接口。接它的时候，最常遇到的不是「接不上」，而是**对方没写文档**。
纪律一句话：

> **推断可以，但必须留下证据链；证据不够就照实说「没找到」，不要编。**

**找接口的优先级**（从上往下，找到就停）：

1. 作者写的 README / README.zh.md / TESTING.md —— 最权威
2. 类型定义与注释（`*.d.ts`、JSDoc）
3. **注册现场源码**：`slots.inject` / `slots.register` / `ctx.provide` / `ctx.layout.selectPanel` /
   `commands` / `shortcuts` / `settings.section` / `connection.fetch.register`
4. **运行时事实**：`ctx.registry` 里有没有它的 fiber、`ctx.get('服务名')` 拿不拿得到、
   `ctx.slots.entries('槽位')` 里有没有它注册的条目
5. 它导出的东西（`exports.*`）—— 导出即承诺
6. 界面结构（DOM / 截图）—— **最后手段**，只能写成「只能点界面」

**三条禁令**：不许按名字猜、不许按别的插件套、不许按截图猜。

**每条推断写全四样**：接口形式 / 证据（文件:行）/ 反证检查（有没有更官方的路）/ 拿不到时怎么办。

**验证方式**：先写只读探针（列服务、列 slot 账本、列 DOM），别改代码试；改完留下可复现的自检；
推错了别删，把错的痕迹写下来 —— 错的痕迹比正确的结论值钱。

## 自检

    node test/selftest.mjs

用真 cordis 起一个 Context，把插件挂上去，验：注册表 / 确认窗归一化 / 分级确认 /
三条路由 / 冻结顺序（历史上「注册完菜单是空的」就是这个）/ 内置加载功能的行为。
不需要别的插件，也不需要 DSH 在跑。

## License

MIT
