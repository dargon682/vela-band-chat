/**
 * common/health.js
 * 健康数据适配层（完全本地，无网络）
 *
 * === 关于 Vela 能力边界的事实（依据官方文档）===
 * 文档：https://iot.mi.com/vela/quickapp/zh/features/system/sensor.html
 *   @system.sensor 在 Vela 上仅提供 subscribePressure / subscribeAccelerometer / subscribeCompass；
 *   支持明细中「小米手环 10」仅支持压力与加速度（不支持罗盘）。
 *   Vela 未提供 @system.health / @service.health，即第三方快应用无法读取系统心率、睡眠、系统计步。
 *
 * 因此本模块的策略是：
 *   1) 步数：用加速度计在本地做峰值检测估算，按自然日缓存（仅统计应用前台期间，非系统步数）；
 *   2) 心率：特性检测 —— 若运行环境提供 sensor.subscribeHeartRate 则自动启用，
 *            否则返回 null，由界面给出如实提示，绝不伪造数据；
 *   3) 睡眠：无接口，返回 null。
 */
import sensor from '@system.sensor'
import storage from '@system.storage'

const STEPS_KEY = 'local_steps_v1'
const MIN_INTERVAL = 280   // 相邻两步最小间隔(ms)，抑制抖动误判
const PEAK_RATIO = 1.18    // 峰值须高于动态基线
const PEAK_DELTA = 0.22    // 峰值须高出基线的最小绝对量

let steps = 0
let baseline = 0
let baselineReady = false
let lastStepTs = 0
let subscribed = false

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function today() {
  const d = new Date()
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function loadSaved() {
  return new Promise(function (resolve) {
    try {
      storage.get({
        key: STEPS_KEY,
        success: function (raw) {
          try {
            const o = typeof raw === 'string' ? JSON.parse(raw) : raw
            steps = (o && o.date === today() && o.steps > 0) ? o.steps : 0
          } catch (e) {
            steps = 0
          }
          resolve(steps)
        },
        fail: function () { resolve(0) }
      })
    } catch (e) {
      resolve(0)
    }
  })
}

function saveSteps() {
  try {
    storage.set({ key: STEPS_KEY, value: JSON.stringify({ date: today(), steps: steps }) })
  } catch (e) {}
}

/**
 * 启动本地步数估算
 * @param {Function} onStep 每次步数变化回调，参数为当前累计步数
 */
export function startStepCounter(onStep) {
  loadSaved().then(function (v) {
    if (onStep) onStep(v)
  })
  if (subscribed) return
  subscribed = true
  try {
    sensor.subscribeAccelerometer({
      interval: 'ui',   // 约 60ms 一次，兼顾灵敏度与功耗
      callback: function (ret) {
        const x = ret.x || 0
        const y = ret.y || 0
        const z = ret.z || 0
        const mag = Math.sqrt(x * x + y * y + z * z)
        if (!baselineReady) {
          baseline = mag
          baselineReady = true
          return
        }
        baseline = baseline + (mag - baseline) * 0.04  // 缓慢跟随的动态基线
        const now = Date.now()
        if (mag - baseline > PEAK_DELTA && mag > baseline * PEAK_RATIO && now - lastStepTs > MIN_INTERVAL) {
          lastStepTs = now
          steps++
          saveSteps()
          if (onStep) onStep(steps)
        }
      },
      fail: function () {}
    })
  } catch (e) {
    subscribed = false
  }
}

export function stopStepCounter() {
  subscribed = false
  baselineReady = false
  try { sensor.unsubscribeAccelerometer() } catch (e) {}
  saveSteps()
}

export function getSteps() {
  return steps
}

export function resetSteps() {
  steps = 0
  saveSteps()
}

/** 运行环境是否提供心率接口（Vela 当前为 false） */
export function hasHeartRateApi() {
  return !!(sensor && typeof sensor.subscribeHeartRate === 'function')
}

/**
 * 读取心率。无接口时直接回调 null，不做任何伪造。
 * @param {Function} cb cb(heartRate|Number|null)
 */
export function measureHeartRate(cb) {
  if (!hasHeartRateApi()) {
    cb(null)
    return
  }
  let done = false
  try {
    sensor.subscribeHeartRate({
      callback: function (ret) {
        if (done) return
        const hr = ret && ret.heartRate
        if (hr && hr > 0) {
          done = true
          try { sensor.unsubscribeHeartRate() } catch (e) {}
          cb(hr)
        }
      },
      fail: function () {
        if (!done) { done = true; cb(null) }
      }
    })
  } catch (e) {
    if (!done) { done = true; cb(null) }
  }
}

export default {
  startStepCounter: startStepCounter,
  stopStepCounter: stopStepCounter,
  getSteps: getSteps,
  resetSteps: resetSteps,
  hasHeartRateApi: hasHeartRateApi,
  measureHeartRate: measureHeartRate
}
