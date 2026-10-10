<!--
 * @Coding: utf-8
 * @Author: vector-wlc
 * @Date: 2021-08-17 22:07:28
 * @Description: 
-->
# Change Log

## [0.6.3] 2026/10/11

* 修正面板模式下滚动位置被继承的问题：同一个词再按 F1 画面毫无变化，
  打开新词后仍停在旧的滚动位置。根因是 VS Code webview 宿主页在更新
  html 时会保存旧滚动位置、并在新文档 load 时主动恢复（与浏览器自身的
  `history.scrollRestoration` 无关）；而无锚点页面（如类名文档）此前的
  归零动作在宿主页恢复发生前就已结束，恢复之后再无人纠正
* 现在所有页面统一等 load 且布局稳定后再定位：有锚点滚动到锚点，
  无锚点滚回页面顶部，定位动作恒晚于宿主页的恢复
* 实测：无锚点页面重新加载后回到顶部；带锚点页面重新加载后回到锚点位置

## [0.6.2] 2026/10/11

* 修正点击「同页且无锚点」的链接没有反应的问题。
  这类链接形如正文里的 `qlist.html`（不带 `#锚点`），此前被识别为同页链接后
  直接返回、不做任何事；实测原始 HTML 的行为是重新加载该页并停在顶部，
  现在等价地滚回页面顶部
* 带锚点的同页链接（如签名框里的 `qlist.html#QList`）行为不变，仍精确跳转

## [0.6.1] 2026/10/11

* 返回/前进的默认键位改为 <kbd>Ctrl+Left</kbd> / <kbd>Ctrl+Right</kbd>。
  这些键在 VS Code 里虽已绑定命令，但触发条件都是各自的焦点环境
  （`cursorWordLeft` 要求 `textInputFocus`、`list.collapseAll` 要求列表焦点），
  在帮助面板中不成立，因此可用

## [0.6.0] 2026/10/11

* 新增两个命令，并设默认键位（仅在 Qt 帮助面板激活时生效）：
  * `QtConfigure : Qt Help Back` — 返回上一页，<kbd>Ctrl+Left</kbd>
  * `QtConfigure : Qt Help Forward` — 前进，<kbd>Ctrl+Right</kbd>
* 键位选择依据：这些键在 VS Code 里都绑定了命令，但触发条件都是各自焦点环境
  （`cursorWordLeft` 要求 `textInputFocus`，`list.collapseAll` 要求列表焦点，
  `Alt+方向键` 是编辑器导航），在帮助面板中均不成立，因此可用。
  再配合 `when: activeWebviewPanelId == qtConfigure.help`，
  键位只在帮助面板内生效
* 面板右下角按钮去掉文字，仅保留箭头图标

## [0.5.9] 2026/10/11

* 移除面板内的 Alt+Left / Alt+Right 快捷键：VS Code 已把 Alt+方向键用于
  `workbench.action.navigateBack/Forward`（编辑器导航），绑定在面板里会与之冲突。
  返回/前进仍可通过右下角的按钮操作

## [0.5.8] 2026/10/11

* 修正返回/前进按钮点击无反应：`post()` 每次都调用 `acquireVsCodeApi()`，
  而该 API 每个 Webview 只能调用一次，第二次会抛异常并被 catch 吞掉，
  导致消息发不出去。现在缓存 api 实例复用
* 修正工具栏遮挡正文：原先用 `position: sticky` 固定在视口顶部，
  会一直压住文档内容。改为浮动在右下角（`position: fixed`），
  不占文档流、不遮挡正文，悬停时提高不透明度

## [0.5.7] 2026/10/10

* 面板模式新增「返回 / 前进」：Webview 的内容是整体替换的
  （`panel.webview.html = ...`），这会重置 Webview 自身的会话历史，
  所以浏览器/Webview 的后退按钮在这里不可用，改为在扩展侧维护浏览历史栈
* 面板顶部加入返回/前进按钮，按历史位置自动启用或禁用；
  同时支持 Alt+Left / Alt+Right，与常见浏览器一致
* 按 F1 视为新的起点，会清空历史；在历史中段跳转会丢弃「未来」分支

## [0.5.6] 2026/10/10

* 修正面板内点击**同页锚点链接**不滚动的问题。此前这类链接被一律转发给扩展，
  扩展重新渲染整个页面，滚动位置随之丢失，表现为「点了不跳」；
  原始 HTML 中浏览器只是改 hash 并滚动，不重载页面。
  现在同页链接（`qstring.html#mid` 且文件即当前页）在本地直接滚动，
  与浏览器行为一致，实测两种模式的落点完全相同
* 跨页链接仍交由扩展处理（需要切换解包目录），分流逻辑在扩展调用之前判断
* 新增回归测试，断言注入脚本能识别同页链接且语法正确

## [0.5.5] 2026/10/10

* 修正面板内点击部分链接「不跳转」的问题。0.5.4 引入的规则把「锚点等于所在
  页面的类名」一律清空，但实测这类锚点在 229 个页面里是**真实存在**的
  （指向构造函数，如 `qlist-const-iterator.html#const_iterator`），
  清空后点击就变成了停在页面顶部，表现为「点了不跳」。
  现在不再对锚点做任何改写
* 锚点规则回归到与浏览器、Qt Creator 一致的最简形式：
  **锚点存在就跳过去，不存在就停在页面顶部**。实测 36 个类页面没有该类名锚点，
  打开时自然停在顶部，与 Qt Creator 的表现相同
* 移除 `resolveAnchor` / `classNameOf` / `titleOf` 及相关分支

## [0.5.4] 2026/10/10

* 首次尝试修正点击类名后的落点，改为停在页面顶部，并引入「锚点等于类名则
  视同顶部」的规则。该规则在 0.5.5 中被证明会误伤正常跳转，已移除

## [0.5.3] 2026/10/10

* 首次尝试修正点击类名的落点，改为跳到 `#details`（Detailed Description）。
  经与 Qt Creator 实际行为比对，该方向有误，已在 0.5.4 改回页面顶部

## [0.5.2] 2026/10/10

* 帮助面板内点击链接时，锚点解析与 F1 路径统一走同一处逻辑

## [0.5.1] 2026/10/10

* 修正 `engines.vscode` 声明：由 `^1.27.0` 提升到 `^1.63.0`。
  代码用到的 `fs.rmSync`（Node 14.14）、`webview.asWebviewUri`、`globalStorageUri`
  分别要求 VS Code 1.63 / 1.38 / 1.31，原声明会让旧版本装上后运行时报错
* `@types/vscode` 固定为 `1.63.0`（原先写 `^1.27.0`，全新安装会拉到最新 1.x，
  导致 TypeScript 放行目标版本并不存在的 API）
* 兼容 `executeDefinitionProvider` 返回 `LocationLink[]` 的情况：
  此前按 `Location[]` 处理，`uri` 为 undefined 会让符号解析静默降级为词匹配
* 为帮助面板注入 CSP（此前生成了 nonce 但未使用），
  `cspSource` 缺失时不注入，避免产生非法策略导致样式与图片全部被拦。
  其中 `base-uri` 取 `cspSource`：取 `'none'` 会让浏览器忽略注入的 `<base>`，
  `offline.css` 等相对资源解析到错误地址以 403 加载失败（页面只剩内置覆盖样式）
* 模板实参去除支持嵌套：`QMap<QString, QVector<int>>::at` -> `QMap::at`
  （原正则只去一层，会留下 `QMap<QString, QVector>::at`）
* `extension.ts` 新增代码的缩进统一为 tab，与文件原有风格一致
* README 补充 F1 会覆盖命令面板默认键位的说明与三种改法
* 清理未使用的 `WebviewMessage.ready`；集成测试的文档检测改为同时识别
  `qtHelpPaths` 与 `qtDir`，只配前者的用户不再被全部跳过

## [0.5.0] 2026/10/10

* 新增设置项 `qtConfigure.qtHelpViewMode`，可选择帮助文档的展示方式：
  `panel`（VS Code 侧边面板，默认）或 `browser`（系统默认浏览器）
* `browser` 模式在本机启动只监听 `127.0.0.1` 的临时服务，端口由系统分配，
  VS Code 关闭时自动停止；浏览器里可自由跳转，跨模块链接由服务按需解包
* 修正光标落在限定名不同段上的行为：`QFile::remove` 中点在 `QFile` 上查类、
  点在 `remove` 上查函数，与 Qt Creator 一致
* 修正帮助面板内点击链接会弹出无法访问页面的问题：
  相对链接改写为内部协议，不再依赖页面脚本，同时修掉注入脚本的语法错误
* 修正深色主题下函数签名框、代码块等仍为浅色的问题：
  改用 Qt 样式表里的真实类名（`h3.fn` / `span.fn` / `.name` / `.type` 等），
  并把自定义样式放到 Qt 样式表之后

## [0.4.0] 2026/10/09

* 新增 `QtConfigure : Show Qt Help` 命令：把光标放在 Qt 类名或函数名上按 F1，
  在侧边面板中打开本地 Qt 帮助文档，并直接定位到该函数或类的说明
* 新增 `QtConfigure : Rebuild Qt Help Index` 命令，用于重建帮助索引
* 新增设置项 `qtConfigure.qtHelpPaths`，可手动指定存放 `.qch` 的目录
* 直接读取 Qt 的 `.qch` 帮助文件（其本质是 SQLite 数据库），不依赖任何第三方运行时依赖
* 帮助面板支持页内链接跳转、跨 `.qch` 跳转与深色主题适配

## [0.3.0] 2026/05/15

* 项目名与主类名分离：创建项目时分别输入项目名（构建产物名）和主类名（C++ 类名/源文件名）
* CMakeLists.txt 优化：最低版本提升至 3.16，显式的 SOURCES/HEADERS/FORMS 文件列表，WIN32 默认注释
* main.cpp 中不再生成 `#pragma comment(lib, "user32.lib")`
* 重命名为 QtConfigure Enhanced

## [0.2.0] 2021/12/18

* 增加了对 CMake 的支持
* 增加了命令 `QtConfigure : Open Qt Assistant`，用于打开 Qt 助手

## [0.1.1] 2021/08/22

* 增加了对 Linux 的支持
* 修改了 Windows bat 文件：cd %BUILD_DIR% -> cd build

## [0.1.0] 2021/08/19

* 增加了 MSVC utf-8 编码选项
* 增加了命令 `QtConfigure : Open Qt Designer`，该命令仅在生成 Qt Ui 项目后才能使用

## [0.0.1] 2021/08/18

* 仅支持 Windows 下 MinGW MSVC 的 Qt 项目配置