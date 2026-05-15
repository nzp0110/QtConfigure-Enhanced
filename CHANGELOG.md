<!--
 * @Coding: utf-8
 * @Author: vector-wlc
 * @Date: 2021-08-17 22:07:28
 * @Description: 
-->
# Change Log

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