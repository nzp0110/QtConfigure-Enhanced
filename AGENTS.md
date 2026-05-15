# Qt Configure (qtconfigure)

VS Code 扩展：在 VSCode 中生成 Qt 项目配置文件，支持 CMake/QMake，Windows/Linux。

## 架构

```
package.json 声明命令/配置项/激活事件
src/
  extension.ts        — 入口：注册 4 个命令 + 编排交互流程
  qt_configurator.ts  — 业务逻辑：路径扫描、文件生成、终端管理
  template_files.ts   — 所有生成文件的模板（字符串常量 + `__占位符__` 替换）
templates/projects/   — 未使用（所有模板在 template_files.ts 内联）
```

## 关键命令

| 命令 | 作用 |
|------|------|
| `qtConfigure.newQtProject` | 交互式创建 Qt 项目 |
| `qtConfigure.setQtDir` | 选择 Qt 安装目录，自动扫描套件 |
| `qtConfigure.openQtDesigner` | 打开 Qt Designer（需带 UI 的项目） |
| `qtConfigure.openQtAssistant` | 打开 Qt Assistant |

## 构建与测试

```bash
npm run compile      # tsc -p ./
npm run watch        # tsc -watch -p ./
npm run lint         # eslint src --ext ts
npm run pretest      # compile + lint
npm run test         # VS Code 集成测试（vscode-test），需下载 VS Code，较慢
```

- 输出目录：`out/`（对应 `src/`）
- 测试框架：Mocha（`tdd` UI），运行 `out/test/suite/**/*.test.js`

## 模板系统（template_files.ts）

- 所有模板是 `export const` 字符串常量，用 `\n\` 多行拼接
- 占位符格式：`__PLACEHOLDER__`（双下划线包围）
- 替换使用 `strReplaceAll()`（`split + join`，非正则）— 修改模板时注意占位符命名需唯一
- `__PROJECT_NAME__` 几乎出现在所有模板中

## 配置项（VSCode settings）

| 键 | 作用域 | 说明 |
|----|--------|------|
| `qtConfigure.qtDir` | 全局 | Qt 安装根路径 |
| `qtConfigure.qtKitDir` | **工作区** | 当前选中的 Qt 套件路径 |
| `qtConfigure.mingwPath` | 全局 | MinGW 路径，自动推断 |
| `qtConfigure.vcvarsallPath` | 全局 | MSVC vcvarsall.bat 路径 |

注意：`qtKitDir` 写入工作区配置（`update(..., false)`），其余写入全局配置（`true`）。

## Qt 套件扫描算法

`setQtDir()` 扫描 `<root>/` 下以数字开头的目录 → 每个版本目录下找含 `mingw`/`msvc`/`gcc` 的子目录。

## 注意点

- 仅支持 win32 和 linux（macOS 不支持）
- 创建项目要求工作区是一个空文件夹（仅警告，不强制）
- MinGW 路径推断：套件名 `mingw81_64` → Tools 目录 `mingw810_64`（`_` → `0_`）
- MSVC 版本从套件名推断：`msvc2019_64` → VS 版本 `2019`
- 模板文件中的 `# FORMS` 注释符号在有 UI 项目时会被移除（取消 FORMS 声明）
- CMake 分支生成的 launch.json 依赖 `cmake.launchTargetPath`（需要 CMake Tools 插件）
- QMake Windows 分支生成的 `.bat` 脚本通过 `cmd /c` 调用
- 终端管理：插件复用名为 `"qtTerminal"` 的终端，关闭时自动清理引用
- `.vscodeignore` 排除了 `src/**`、`**/*.ts`、`**/*.map` 等 — 发布时需编译后的 JS
