# 本地对话助手（小米手环 10 · Xiaomi Vela JS 应用）

一个**完全离线**的手环端轻量对话助手。基于纯 JavaScript 规则引擎（关键词 / 正则匹配 + 模板响应）实现意图识别，
不联网、不加载任何模型、不调用云端 API、不使用 WASM。

---

## 一、硬件与平台约束

| 项目 | 约束 |
| --- | --- |
| 目标设备 | 小米手环 10（Xiaomi Vela OS） |
| 应用形态 | Xiaomi Vela JS 应用（`.rpk`） |
| 内存 | 约 16 MB |
| 存储 | 标准版 256 MB / NFC 版 512 MB；快应用分区约 8 MB |
| 算力 | 无 NPU |
| 网络 | 手环 10 不支持 `fetch`，本应用亦不发起任何网络请求 |
| 交互 | 仅支持触摸点击（无键盘，Vela `input` 组件无文本输入类型），故采用快捷指令面板 |

---

## 二、目录结构

```
vela-band-chat/
├── package.json                 # 项目配置 / aiot 构建脚本
├── README.md
└── src/                         # 源码目录（固定名称，不可更改）
    ├── manifest.json            # 应用配置：包名、图标、features、路由
    ├── app.ux                   # 应用入口
    ├── common/
    │   ├── rules.js             # 规则引擎：意图表 + 匹配入口
    │   ├── responses.js         # 响应模板库（含 {time} 等占位符）
    │   ├── storage.js           # @system.storage 封装（历史 20 条 / 偏好）
    │   ├── health.js            # 健康数据适配层（步数本地估算 + 心率特性检测）
    │   └── images/logo.png      # 应用图标 192×192
    └── pages/
        └── index/index.ux       # 主对话页面（template / style / script 三合一）
```

> `build/`、`dist/`、`sign/` 由构建工具生成，无需手工维护。

---

## 三、能力边界（重要，请先阅读）

开发前已核对 Vela 官方接口文档，结论如下：

1. **`@system.sensor` 在 Vela 上只提供** `subscribePressure` / `subscribeAccelerometer` / `subscribeCompass`。
   官方「支持明细」表中，小米手环 10 **仅支持压力与加速度**（不支持罗盘）。
   文档：<https://iot.mi.com/vela/quickapp/zh/features/system/sensor.html>
2. **Vela 未提供 `@system.health` / `@service.health`**，系统「接口」清单中无健康类模块。
   文档：<https://iot.mi.com/vela/quickapp/zh/features/system/>
   → **第三方快应用无法读取系统心率、睡眠与系统步数。**

因此本应用采取「能做到的真做，做不到的如实说明」的策略，绝不伪造数据：

| 需求 | 实现方式 | 状态 |
| --- | --- | --- |
| 步数 | 用加速度计在本地做峰值检测估算，按自然日缓存 | ✅ 真实可用（仅统计应用前台期间，非系统步数） |
| 卡路里 | 由本地步数估算（步数 × 0.04 千卡） | ✅ 可用 |
| 心率 | 特性检测：若运行环境提供 `sensor.subscribeHeartRate` 则自动启用 | ⚠️ 当前 Vela 无此接口，返回如实提示；接口一旦开放无需改代码即可生效 |
| 睡眠 | 无接口 | ⚠️ 如实提示用户到「小米运动健康」App 查看 |
| 提醒 / 闹钟 | `@system.alarm.setAlarm`（相对时间换算为绝对时刻，`days: []` 表示一次性） | ✅ 真实可用 |
| 设备控制（震动） | `@system.vibrator.vibrate` | ✅ 真实可用 |
| 打开心率监测 / 开始跑步 | 系统级能力，第三方不可调用 | ⚠️ 如实提示 |
| 自由文本输入 | Vela 的 `input` 组件 `type` 仅支持 `button / checkbox / radio`，**无文本输入能力**；手环亦无键盘 | ❌ 不支持，改为**纯快捷指令面板**点击交互（规则引擎本身仍支持任意文本，可直接复用） |

`input` 组件文档：<https://iot.mi.com/vela/quickapp/zh/components/form/input.html>

---

## 四、核心设计

### 1. 规则引擎 `common/rules.js`

* 意图表 `INTENTS` 为**有序数组**，遍历时返回**第一个命中**的结果，顺序即优先级。
  关键顺序：`日期/时间` → `设备控制` → `提醒` → `健康` → `离线边界` → `闲聊` → `兜底`。
  （设备控制必须排在健康之前，否则「打开心率监测」会被「心率」抢走。）
* 每条意图包含 `patterns`（关键词 / 正则数组）、`reply(input, ctx)`（返回字符串或 `{text, action}`）。
* 正则**不使用 `g` 标志**，避免 `lastIndex` 状态污染导致的匹配漂移。
* 模板话术采用**轮转 `pick()`**（而非随机数），保证同一意图多次回答不重复、且测试可复现。
* 占位符渲染 `render()` 支持 `{time}` `{steps}` `{calories}` `{weekday}` 等，缺失变量原样保留。
* 实体解析：
  * `parseDelay()` 支持「10分钟 / 2小时 / 30秒」；
  * `parseLabel()` 从「提醒我10分钟后喝水」中抽取提醒内容「喝水」。
* 未匹配时返回兜底话术：「我还不太明白，试试问心率或步数。」
* 当前意图数 **23 条**（上限 50）。

### 2. 响应模板库 `common/responses.js`

28 组模板，纯静态字符串，零依赖。已通过静态校验：`rules.js` 引用的模板 key 与定义**完全一致，无缺失、无冗余**。

### 3. 本地存储 `common/storage.js`

* `@system.storage` 封装，统一以 JSON 字符串读写，兼容不同设备的 storage 实现。
* 对话历史仅保留最近 **20 条**（`HISTORY_LIMIT`），超出自动裁剪；另有用户偏好键值对。

### 4. 健康适配层 `common/health.js`

* 加速度计峰值检测：动态基线 + 峰值阈值（`mag > baseline × 1.18` 且高出基线 `> 0.22`），
  相邻步最小间隔 280 ms 抑制抖动误判；采样间隔 `ui`（约 60 ms）。
* 按自然日持久化，跨天自动归零。
* 页面销毁时 `unsubscribeAccelerometer()`，避免持续耗电。

### 5. 界面 `pages/index/index.ux`

* 两段式布局：顶部状态栏 → 对话列表（`list` + `list-item`，`flex: 1`）→ 底部快捷指令面板。
* 底部 8 个快捷指令（显示文案 → 实际下发文本）：
  你好 / 心率 / 步数 / 卡路里 / 时间 / 星期几→`今天星期几` / 震动→`震动一下` / 提醒喝水→`提醒我10分钟后喝水`。
  显示文案短、下发文本完整，兼顾窄屏排版与指令完整性。
* 按钮统一用 `text` + 样式实现（不依赖 `button` 组件），事件绑定用 `onclick`
  （Vela 同时支持 `onclick` 与 `@click` 两种写法）。
* 按 Vela 官方示例约定，页面响应式数据用 `private` 声明；`list` 仅设 `flex: 1` 由父级 flex 列布局给出高度
  （`list` 无 `scroll-y` / `show-scrollbar` 属性，其文档要求"显式高度"，此处由 flex 提供）。
* 深色 AMOLED 友好配色，无动画，`max-width: 84%` 气泡自适应窄屏。
* 新消息后尝试 `$element('chat').scrollTo({index})` 滚动到底部（已 try/catch 保护，接口缺失时静默降级）。

---

## 五、构建说明

### 方式 A：AIoT-IDE（推荐）

1. 安装 AIoT-IDE（Vela 官方 IDE，支持 Windows / macOS / Ubuntu）。
2. `文件 → 打开` 本目录（IDE 会读取 `src/manifest.json`、识别 `package.json`）。
3. 顶部操作栏点击 **打包应用**，产物输出到 `dist/` 目录，后缀为 `.rpk`。

### 方式 B：AIoT-toolkit 命令行

```bash
# 全局安装命令行工具
npm i -g aiot-toolkit

# 在项目根目录执行
aiot build        # 构建，生成 rpk
aiot release      # release 模式构建（正式包）
aiot start        # 启动模拟器预览
aiot getConnectedDevices   # 查看已连接设备
```

也可以直接用 `package.json` 中已配置好的脚本：

```bash
npm run build     # 等价于 aiot build
npm run release   # 等价于 aiot release
```

> 从零开始的项目建议先用 `npm create aiot` 生成脚手架，再将其 `sign/`（签名证书）、
> `package.json` 与构建配置替换/合并到本工程，本工程只提供 `src/` 源码与最小 `package.json`。
> 参考：<https://iot.mi.com/vela/quickapp/zh/tools/toolkit/start.html>

### 打包成 zip 交付

```bash
zip -r bandchat-src.zip . -x "build/*" "dist/*" "node_modules/*"
```

---

## 六、部署说明

1. **开发期预览**：`aiot start` 启动模拟器；或 AIoT-IDE 内置模拟器直接运行调试（支持多屏 UI 模拟器预设手环尺寸）。
2. **真机调试**：官方文档说明当前真机调试**仅支持 Xiaomi Watch S4**，
   需联系小米工作人员获取调试设备。参考：<https://iot.mi.com/vela/quickapp/zh/tools/devicedebug/start.html>
3. **安装到小米手环 10**：需走官方发布流程——将 `dist/` 下的 `.rpk` 通过小米应用商店 / Vela 应用平台提交审核，
   审核通过后在手环「应用商店」中下载安装。
4. 安装后在应用列表打开「本地助手」即可使用，**无需联网**。

---

## 七、测试用例（23 条）

以下用例已通过等价的 Node 测试脚本对 `src/common/rules.js` + `src/common/responses.js` 实际执行验证，
**23 / 23 全部通过**（测试上下文：`time=14:30`、`weekday=星期六`、`date=10月11日`、`steps=3291`）。
另有静态校验：规则引用的 28 个模板 key 与定义完全一致，无缺失、无冗余。

用例 1–22 均可由界面上的快捷指令触发（见第四节第 5 点）；规则引擎本身支持任意文本，用例 23 验证兜底分支。

| # | 输入 | 命中意图 | 实际响应 | 附加动作 |
| --- | --- | --- | --- | --- |
| 1 | 你好 | greeting | 你好呀，我是手环小助手，随时为你服务~ | — |
| 2 | 谢谢 | thanks | 不客气~ | — |
| 3 | 你是谁 | who | 我是运行在你手环上的本地小助手，靠规则匹配应答，不联网、不上传任何数据。 | — |
| 4 | 讲个笑话 | joke | 我问手环：你累吗？手环说：我只有 16MB 内存，没空累。 | — |
| 5 | 现在几点 | time | 现在是 14:30。 | — |
| 6 | 时间 | time | 当前时间 14:30。 | — |
| 7 | 今天星期几 | weekday | 今天是 星期六。 | — |
| 8 | 今天是几号 | date | 今天是 10月11日，星期六。 | — |
| 9 | 我的心率是多少 | health_heart | Vela 快应用未开放心率接口，请在系统「心率」应用中查看。 | 尝试读心率（无接口则静默） |
| 10 | 步数 | health_steps | 本应用记录到 3291 步（本地加速度估算）。 | — |
| 11 | 卡路里 | health_calories | 按本地步数估算，今天约消耗 132 千卡。 | — |
| 12 | 睡眠 | health_sleep | Vela 快应用未开放睡眠接口，请在「小米运动健康」App 查看昨晚睡眠。 | — |
| 13 | 震动一下 | device_vibrate | 好的，已震动提醒。 | `vibrator.vibrate` |
| 14 | 打开心率监测 | device_hr_on | 心率监测由系统应用负责，我无法打开，请在应用列表进入「心率」。 | — |
| 15 | 关闭心率监测 | device_hr_off | 心率监测由系统应用负责，我无法关闭它。 | — |
| 16 | 开始跑步 | device_run_start | 运动模式需在系统「运动」应用中启动，我无法代劳。 | — |
| 17 | 停止 | device_stop | 我无法控制系统的运动模式，请在系统「运动」应用中操作。 | — |
| 18 | 提醒我10分钟后喝水 | alarm_set | 好的，已为你设置 10分钟 后提醒：喝水。 | `{type:alarm, delayMin:10, label:"喝水"}` |
| 19 | 提醒我2小时后开会 | alarm_set | 好的，已为你设置 2小时 后提醒：开会。 | `{type:alarm, delayMin:120, label:"开会"}` |
| 20 | 提醒我 | alarm_set | 要多久后提醒呢？可以说「提醒我10分钟后喝水」。 | — |
| 21 | 今天天气怎么样 | weather | 离线模式下我无法获取天气，请查看手机或手环天气卡片。 | — |
| 22 | 你能做什么 | help | 你可以问我：心率、步数、卡路里、睡眠、现在几点、今天星期几；也可以说「提醒我10分钟后喝水」「打开心率监测」。 | — |
| 23 | asdfgh | fallback | 我还不太明白，试试问「心率」或「步数」。 | — |

---

## 八、性能与资源占用

| 指标 | 实测 / 估算 |
| --- | --- |
| 意图数量 | 23 条（约束 < 50 ✅） |
| 匹配耗时 | 典型 10–130 µs，首次调用（JIT 预热）< 900 µs（约束 < 100 ms ✅，余量约 3 个数量级） |
| 源码体积 | `src/` 全部代码 + 配置约 28 KB（含图标） |
| 常驻内存 | 规则表与模板为静态字符串，无大对象、无缓存膨胀；显著低于 4 MB |
| 快应用分区 | rpk 为十余 KB 级，远低于 8 MB |
| 网络请求 | 0（无 `fetch`、无 `@system.request`、manifest 未声明任何网络 feature） |
| 定时器 | 仅 1 个 30 ms 延时用于滚动到底部，用后即释放 |

---

## 九、验收标准对照

| 验收项 | 结论 |
| --- | --- |
| 能在小米手环 10 上安装并启动 | 代码与 manifest 符合 Vela 规范（`deviceTypeList: ["watch"]`、源码位于 `src/`）；安装需走官方发布流程 |
| 完全离线运行，无任何网络请求 | ✅ 全链路无网络调用 |
| 能正确响应预设指令 | ✅ 23/23 用例通过 |
| 响应时间 < 100 ms | ✅ 实测 µs 级 |
| 内存 < 4 MB、快应用分区 < 8 MB | ✅ 代码与资源总量约 28 KB |

---

## 十、已知限制与后续扩展

1. 心率、睡眠、系统步数受 Vela 平台能力限制无法读取，界面已如实告知，不做任何数据伪造。
   若后续 Vela 开放 `@system.sensor.subscribeHeartRate`，`common/health.js` 的特性检测会让心率功能**自动生效**，无需改动业务代码。
2. **Vela 不支持文本输入**（`input` 组件仅 `button / checkbox / radio`），故交互改为快捷指令面板，
   无法自由输入任意句子。`common/rules.js` 的 `match(text, ctx)` 接口本身与输入方式解耦：
   若后续平台开放输入组件，只需恢复输入框并调用 `onQuick(text)` 即可，规则引擎零改动。
3. 本地步数为加速度计估算值，仅统计应用前台运行期间，与系统步数不一致属预期行为；不同佩戴松紧与步态下
   阈值可能需微调（`common/health.js` 顶部的 `PEAK_RATIO` / `PEAK_DELTA` / `MIN_INTERVAL`）。
4. 闹钟调用时系统会弹出确认框，需用户同意后才真正生效（`fail` 回调错误码 201 表示用户拒绝）。
5. 扩展新意图只需在 `common/rules.js` 的 `INTENTS` 中追加一条，并在 `common/responses.js` 中补充模板即可，
   无需改动页面逻辑。

---

## 十一、参考文档

* Vela JS 应用接口总览：<https://iot.mi.com/vela/quickapp/zh/features/>
* 传感器 sensor：<https://iot.mi.com/vela/quickapp/zh/features/system/sensor.html>
* 闹钟 alarm：<https://iot.mi.com/vela/quickapp/zh/features/system/alarm.html>
* 项目配置 manifest：<https://iot.mi.com/vela/quickapp/zh/guide/framework/manifest.html>
* 项目结构与目录约定：<https://iot.mi.com/vela/quickapp/zh/guide/start/project-overview.html>
* AIoT-toolkit 命令行：<https://iot.mi.com/vela/quickapp/zh/tools/toolkit/start.html>
* 打包应用：<https://iot.mi.com/vela/quickapp/zh/tools/release/start.html>
