/**
 * common/storage.js
 * 基于 @system.storage 的本地持久化封装
 *  - 对话历史：仅保留最近 HISTORY_LIMIT 条
 *  - 用户偏好：键值对
 * 所有值以 JSON 字符串存储，兼容不同设备的 storage 实现。
 */
import storage from '@system.storage'

export const HISTORY_KEY = 'chat_history_v1'
export const PREFS_KEY = 'user_prefs_v1'
export const HISTORY_LIMIT = 20

function getRaw(key) {
  return new Promise(function (resolve) {
    try {
      storage.get({
        key: key,
        success: function (data) {
          resolve(data === undefined ? null : data)
        },
        fail: function () {
          resolve(null)
        }
      })
    } catch (e) {
      resolve(null)
    }
  })
}

function setRaw(key, value) {
  return new Promise(function (resolve) {
    try {
      storage.set({
        key: key,
        value: value,
        success: function () {
          resolve(true)
        },
        fail: function () {
          resolve(false)
        }
      })
    } catch (e) {
      resolve(false)
    }
  })
}

function removeRaw(key) {
  return new Promise(function (resolve) {
    try {
      storage.delete({
        key: key,
        success: function () { resolve(true) },
        fail: function () { resolve(false) }
      })
    } catch (e) {
      resolve(false)
    }
  })
}

/** 读取对话历史（最多 HISTORY_LIMIT 条） */
export function loadHistory() {
  return getRaw(HISTORY_KEY).then(function (raw) {
    if (!raw) return []
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!Array.isArray(arr)) return []
      return arr.slice(-HISTORY_LIMIT)
    } catch (e) {
      return []
    }
  })
}

/** 保存对话历史，自动裁剪 */
export function saveHistory(list) {
  const trimmed = (list || []).slice(-HISTORY_LIMIT)
  return setRaw(HISTORY_KEY, JSON.stringify(trimmed))
}

/** 读取用户偏好 */
export function loadPrefs() {
  return getRaw(PREFS_KEY).then(function (raw) {
    if (!raw) return {}
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch (e) {
      return {}
    }
  })
}

/** 保存用户偏好 */
export function savePrefs(prefs) {
  return setRaw(PREFS_KEY, JSON.stringify(prefs || {}))
}

/** 清空全部本地数据 */
export function clearAll() {
  return Promise.all([removeRaw(HISTORY_KEY), removeRaw(PREFS_KEY)]).then(function () {
    return true
  })
}

export default {
  HISTORY_KEY: HISTORY_KEY,
  PREFS_KEY: PREFS_KEY,
  HISTORY_LIMIT: HISTORY_LIMIT,
  loadHistory: loadHistory,
  saveHistory: saveHistory,
  loadPrefs: loadPrefs,
  savePrefs: savePrefs,
  clearAll: clearAll
}
