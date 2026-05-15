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

## Features

* Command: `QtConfigure : New Project` 生成 Qt 项目配置文件

* Command: `QtConfigure : Set Qt Dir` 选择 Qt 安装目录，注意是安装目录，而不是 Qt 套件目录，
该扩展会根据 Qt 安装路径搜索相应的 Qt 套件以及编译器

* Command: `QtConfigure : Open Qt Designer` 打开 Qt Designer，该命令仅在生成 Qt Ui 项目后才能使用

* Command: `QtConfigure : Open Qt Assistant` 打开 Qt Assistant

### CMake

* 需要配合 VSCode [CMake](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools)  扩展使用

### QMake

* Build Debug:
在编译运行 Debug 时，请将`./.vscode/launch.json` 中的有关内容修改如下:`"program": "${workspaceRoot}/build/debug/${workspaceRootFolderName}.exe"    "preLaunchTask": "debug"`

* Build Release:
在编译运行 Release 时，请将`./.vscode/launch.json` 中的有关内容修改如下 :`"program": "${workspaceRoot}/build/release/${workspaceRootFolderName}.exe"    "preLaunchTask": "release"`

## Requirements

* [Qt](https://www.qt.io/)
* [ms-vscode.cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)
* [CMake](https://cmake.org) 
* [ms-vscode.cmake-tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools)

## 许可证

GNU General Public License v3.0，与原始版本相同。
