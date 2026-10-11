/**
 * common/rules.js
 * 纯本地规则引擎：关键词 / 正则匹配 + 模板渲染
 *
 * 设计约束：
 *  - 无网络、无模型、无 WASM
 *  - 意图数量 < 50，单次匹配 O(n)，实测 < 1ms
 *  - 不依赖随机数，便于测试复现
 */
import T from './responses'

/* ============================ 工具函数 ============================ */

// 轮换取模板：同一意图连续命中时依次取不同话术，无需随机数
const cursor = {}
function pick(list, key) {
  if (!list || list.length === 0) return ''
  const i = cursor[key] || 0
  cursor[key] = (i + 1) % list.length
  return list[i]
}

// 模板占位符替换：{time} -> 具体值；无对应变量时原样保留
function render(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, function (m, k) {
    const v = vars ? vars[k] : undefined
    return (v === undefined || v === null || v === '') ? m : v
  })
}

function say(list, key, vars) {
  return render(pick(list, key), vars || {})
}

/* ============================ 实体解析 ============================ */

// 解析相对时间：「10分钟后」「2小时」「30秒」
function parseDelay(text) {
  let m
  if ((m = text.match(/(\d+)\s*(?:个)?\s*(?:小时|时|h)/i))) {
    return { min: parseInt(m[1], 10) * 60, text: m[1] + '小时' }
  }
  if ((m = text.match(/(\d+)\s*(?:分钟|分|min)/i))) {
    return { min: parseInt(m[1], 10), text: m[1] + '分钟' }
  }
  if ((m = text.match(/(\d+)\s*(?:秒|s)/i))) {
    const sec = parseInt(m[1], 10)
    return { min: Math.max(1, Math.round(sec / 60)), text: m[1] + '秒' }
  }
  return null
}

// 从「提醒我10分钟后喝水」中抽取提醒内容
function parseLabel(text) {
  let s = String(text)
    .replace(/[\s\S]*?(?:提醒我|提醒|叫我|别忘了|记得|闹钟)/, '')
    .replace(/(\d+)\s*(?:个)?\s*(?:小时|时|h|分钟|分|min|秒|s)/gi, '')
    .replace(/^(?:后|之后|以后|去|要|我)/, '')
    .replace(/[，,。.！!？?、:：]/g, '')
    .trim()
  if (!s) s = '这件事'
  return s.length > 8 ? s.slice(0, 8) : s
}

/* ============================ 意图表 ============================ */
/* 匹配顺序即优先级：越靠前越优先命中 */

const INTENTS = [

  /* ---------- 简单问答：日期 / 时间 ---------- */
  {
    name: 'weekday',
    patterns: [/星期几/, /周几/, /礼拜几/, /今天(是)?(星期|周)[一二三四五六日天]/],
    reply: function (m, c) { return say(T.weekday_now, 'weekday', c) }
  },
  {
    name: 'date',
    patterns: [/几号/, /日期/, /今天是.*月.*日/, /年月日/],
    reply: function (m, c) { return say(T.date_today, 'date', c) }
  },
  {
    name: 'time',
    patterns: [/几点/, /时间/, /现在.*时/],
    reply: function (m, c) { return say(T.time_now, 'time', c) }
  },

  /* ---------- 设备控制（需排在健康查询之前，避免被“心率”抢走） ---------- */
  {
    name: 'device_vibrate',
    patterns: [/震动/, /振动/, /抖一下/, /振一下/],
    reply: function () { return { text: pick(T.device_vibrate, 'vibrate'), action: 'vibrate' } }
  },
  {
    name: 'device_hr_on',
    patterns: [/(打开|开启|开始|启动).{0,6}(心率|心跳)/],
    reply: function () { return say(T.device_hr_on, 'hr_on') }
  },
  {
    name: 'device_hr_off',
    patterns: [/(关闭|关掉|停止|关).{0,6}(心率|心跳)/],
    reply: function () { return say(T.device_hr_off, 'hr_off') }
  },
  {
    name: 'device_run_start',
    patterns: [/(开始|启动|进入).{0,6}(跑步|运动|锻炼|健走)/],
    reply: function () { return say(T.device_run_start, 'run') }
  },
  {
    name: 'device_stop',
    patterns: [/^(停止|结束|退出)$/, /(停止|结束|退出).{0,6}(跑步|运动|锻炼)/],
    reply: function () { return say(T.device_stop, 'stop') }
  },

  /* ---------- 提醒 / 闹钟 ---------- */
  {
    name: 'alarm_set',
    patterns: [/提醒我/, /提醒/, /叫我/, /别忘/, /闹钟/, /定时/],
    reply: function (m) {
      const d = parseDelay(m.input)
      if (!d) return say(T.device_alarm_need_time, 'alarm_need')
      const label = parseLabel(m.input)
      return {
        text: say(T.device_alarm_set, 'alarm', { delayText: d.text, label: label }),
        action: { type: 'alarm', delayMin: d.min, label: label }
      }
    }
  },

  /* ---------- 健康数据 ---------- */
  {
    name: 'health_heart',
    patterns: [/心率/, /心跳/, /脉搏/, /bpm/i],
    reply: function (m, c) {
      if (!c.heartRate || c.heartRate <= 0) return say(T.health_heart_unavailable, 'heart_na')
      return say(T.health_heart, 'heart', c)
    }
  },
  {
    name: 'health_steps',
    patterns: [/步数/, /走了多少/, /多少步/, /计步/, /steps/i],
    reply: function (m, c) {
      if (!c.steps || c.steps <= 0) return say(T.health_steps_empty, 'steps_empty')
      return say(T.health_steps, 'steps', c)
    }
  },
  {
    name: 'health_calories',
    patterns: [/卡路里/, /热量/, /消耗/, /千卡/, /kcal/i],
    reply: function (m, c) {
      if (!c.steps || c.steps <= 0) return say(T.health_nodata, 'nodata')
      return say(T.health_calories, 'cal', c)
    }
  },
  {
    name: 'health_sleep',
    patterns: [/睡眠/, /睡了多久/, /睡眠质量/, /几点睡/],
    reply: function () { return say(T.health_sleep, 'sleep') }
  },

  /* ---------- 离线能力边界 ---------- */
  {
    name: 'weather',
    patterns: [/天气/, /气温/, /下雨/, /温度/, /雾霾/],
    reply: function () { return say(T.offline_weather, 'weather') }
  },
  {
    name: 'music',
    patterns: [/音乐/, /放歌/, /播放/, /听歌/],
    reply: function () { return say(T.offline_music, 'music') }
  },
  {
    name: 'timer',
    patterns: [/计时/, /秒表/, /倒计时/],
    reply: function () { return say(T.offline_timer, 'timer') }
  },
  {
    name: 'help',
    patterns: [/帮助/, /怎么用/, /指令/, /能做什么/, /你会什么/, /功能/],
    reply: function () { return say(T.help, 'help') }
  },

  /* ---------- 闲聊 ---------- */
  {
    name: 'greeting',
    patterns: [/^(你好|您好|哈喽|嗨|hi|hello|在吗|早上好|中午好|下午好|晚上好)/i],
    reply: function () { return say(T.greeting, 'greet') }
  },
  {
    name: 'thanks',
    patterns: [/谢谢/, /多谢/, /感谢/, /thank/i],
    reply: function () { return say(T.thanks, 'thanks') }
  },
  {
    name: 'bye',
    patterns: [/再见/, /拜拜/, /bye/i, /晚安/],
    reply: function () { return say(T.bye, 'bye') }
  },
  {
    name: 'who',
    patterns: [/你是谁/, /你叫什么/, /介绍.*自己/, /你是什么/],
    reply: function () { return say(T.who, 'who') }
  },
  {
    name: 'joke',
    patterns: [/笑话/, /逗我/, /好无聊/, /讲个.*段子/],
    reply: function () { return say(T.joke, 'joke') }
  },
  {
    name: 'praise',
    patterns: [/你真棒/, /好厉害/, /真聪明/, /太强了/, /给你点赞/],
    reply: function () { return say(T.praise, 'praise') }
  }
]

/* ============================ 匹配入口 ============================ */

function normalize(r) {
  if (typeof r === 'string') return { text: r, action: null }
  if (r && typeof r === 'object') return { text: r.text || '', action: r.action || null }
  return { text: '', action: null }
}

/**
 * 匹配用户输入
 * @param {string} input 用户原始文本
 * @param {object} ctx   上下文变量（time/date/weekday/heartRate/steps/calories…）
 * @returns {{intent:string, text:string, action:(string|object|null)}}
 */
export function match(input, ctx) {
  const text = String(input === undefined || input === null ? '' : input).trim()
  const context = ctx || {}

  if (!text) {
    return { intent: 'empty', text: say(T.fallback, 'fallback', context), action: null }
  }

  for (let i = 0; i < INTENTS.length; i++) {
    const intent = INTENTS[i]
    for (let j = 0; j < intent.patterns.length; j++) {
      if (intent.patterns[j].test(text)) {
        const out = normalize(intent.reply({ input: text }, context))
        return { intent: intent.name, text: out.text, action: out.action }
      }
    }
  }

  return { intent: 'fallback', text: say(T.fallback, 'fallback', context), action: null }
}

/** 意图总数（用于自检，应 < 50） */
export function intentCount() {
  return INTENTS.length
}

export default { match: match, intentCount: intentCount }
