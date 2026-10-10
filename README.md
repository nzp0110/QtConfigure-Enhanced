<!--
 * @Coding: utf-8
 * @Author: nzp0110
 * @Date: 2021-08-17 22:07:29
 * @Description: 
-->
# QtConfigure Enhanced

基于 [vector-wlc/VSCodeQtConfigure](https://github.com/vector-wlc/VSCodeQtConfigure) 的增强版。

<strong>这不是 Qt 官方工具！！！x3</strong>

在 VSCode 中生成 Qt 项目配置文件，按下 F5 可独立运行调试 Qt 项目

## Enhanced 与原版的区别

### 1. 项目名与主类名分离

原版的项目名同时用作 C++ 类名和构建产物名。增强版将两者拆分：

- **项目名**：仅作为构建产物名称（`.exe`、`.pro`、CMake project）
- **主类名**：作为 C++ 主窗口类名和源文件名（`.h`、`.cpp`、`.ui`）

创建项目时依次输入项目名 → 主类名。

### 2. CMakeLists.txt 优化

- `cmake_minimum_required` 从 3.5 提升至 **3.16**
- `aux_source_directory()` 改为显式 `set(SOURCES ...)` / `set(HEADERS ...)` / `set(FORMS ...)` 结构
- `WIN32` 标记已注释，如需终端调试取消注释即可
- C++ 源文件明确列出，不再依赖目录扫描

### 3. 移除 `user32.lib`

`main.cpp` 中不再生成 `#pragma comment(lib, "user32.lib")`。

### 4. 查看 Qt 帮助文档（F1）

在 Qt 符号上按 <kbd>F1</kbd>，直接在 VS Code 里打开本地 Qt 帮助文档中对应的函数或类说明，
效果类似 Qt Creator 的「按 F1 查看帮助」。

- 读取 Qt 安装目录下的 `.qch` 帮助文件（Qt Online Installer 中的 Documentation 组件）
- 首次使用会建立符号索引并缓存，之后打开帮助是即时的
- 定位到具体函数/类，而不是只打开类页面
- 支持两种展示方式（见下），默认在 VS Code 侧边面板中打开
- 深色主题自动适配

## Features

* Command: `QtConfigure : New Project` 生成 Qt 项目配置文件

* Command: `QtConfigure : Set Qt Dir` 选择 Qt 安装目录，注意是安装目录，而不是 Qt 套件目录，
该扩展会根据 Qt 安装路径搜索相应的 Qt 套件以及编译器

* Command: `QtConfigure : Open Qt Designer` 打开 Qt Designer，该命令仅在生成 Qt Ui 项目后才能使用

* Command: `QtConfigure : Open Qt Assistant` 打开 Qt Assistant

* Command: `QtConfigure : Show Qt Help` 查看光标处符号的本地 Qt 帮助文档（默认快捷键 <kbd>F1</kbd>）

* Command: `QtConfigure : Rebuild Qt Help Index` 重建 Qt 帮助索引

### 查看 Qt 帮助（F1）

把光标放在 Qt 的类名或函数名上按 <kbd>F1</kbd>，即可查看本地 Qt 帮助文档。

```cpp
QString text = "hello";
text.mid(6);        // 光标放在 mid 上按 F1 -> 打开 QString::mid 的说明
QApplication app;   // 光标放在 QApplication 上按 F1 -> 打开 QApplication 类说明
QFile::remove(p);   // 光标在 QFile 上按 F1 -> 打开 QFile 类；在 remove 上按 F1 -> 打开 remove 函数
```

文档来源是 Qt 自带的 `.qch` 文件，扩展会按以下顺序查找：

1. 设置项 `qtConfigure.qtHelpPaths` 指定的目录
2. `qtConfigure.qtDir` 下的 `Docs/Qt-<版本>/` 目录
3. 当前套件 `qtConfigure.qtKitDir` 对应的 Qt 安装目录下的 `Docs/Qt-<版本>/`

首次使用会扫描并建立索引（Qt 5.12 全套约 7 万个符号，耗时不到 1 秒），
结果缓存在扩展的全局存储目录中，`.qch` 文件有变化时会自动重建。
若提示找不到文档，通常是安装 Qt 时没有勾选 Documentation 组件，
或需要手动在设置里指定 `qtConfigure.qtHelpPaths`。

#### 展示方式

设置项 `qtConfigure.qtHelpViewMode` 决定文档在哪里打开：

| 取值 | 说明 |
|------|------|
| `panel`（默认） | 在 VS Code 侧边的面板中打开，不离开编辑器，跟随编辑器主题 |
| `browser` | 用系统默认浏览器打开，可在浏览器里自由浏览整套文档 |

两种方式都按需解包：只有真正打开某个模块的文档时才解包它。
`browser` 模式会在本机启动一个只监听 `127.0.0.1` 的临时服务，
端口由系统分配；VS Code 关闭时自动停止。浏览器里点击跨模块链接时，
服务会现场解包对应模块再返回（约 0.4～1.5 秒，之后走缓存）。

#### 关于 F1 快捷键

本扩展把 <kbd>F1</kbd> 绑定为「查看 Qt 帮助」，**这会覆盖 VS Code 默认的
「显示所有命令」（命令面板）**——在 C/C++ 文件里按 F1 不再打开命令面板，
这与 Qt Creator 的行为一致。

如果更习惯用 F1 打开命令面板，可以任选一种方式：

- 在「键盘快捷方式」里把 `qtConfigure.openQtHelp` 的 F1 改绑到其它键，
  或直接删除这条绑定，命令面板的 F1 即恢复；
- 用 <kbd>Shift</kbd>+<kbd>F1</kbd> 查看 Qt 帮助（在任意文件中都可用），
  然后把 F1 留给命令面板；
- 改用命令面板里的 `QtConfigure : Show Qt Help` 命令。

命令面板也可以用 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> 打开，
这个快捷键不受影响。

### CMake

* 需要配合 VSCode [CMake](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools)  扩展使用

### QMake

生成的项目已配置好 `.vscode/launch.json` 与 `scripts/` 下的构建脚本，
Debug 直接按 <kbd>F5</kbd>，Release 选择 `release` 构建任务即可。

## Requirements

* [Qt](https://www.qt.io/)（查看帮助文档需安装 Documentation 组件）
* [ms-vscode.cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)
* [CMake](https://cmake.org) 
* [ms-vscode.cmake-tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools)

## 许可证

GNU General Public License v3.0，与原始版本相同。
