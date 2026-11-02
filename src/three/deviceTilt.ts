import { reactive } from 'vue'

export const deviceTilt = reactive({ active: false, x: 0, y: 0 })

const listeners = new Set<() => void>()
let baseline: { beta: number; gamma: number } | null = null
let filtered = { x: 0, y: 0 }
let lastSampleTime = 0

const clamp = (v: number) => Math.max(-1, Math.min(1, v))
const normalized = (v: number) => clamp(v) || 0
const angleDelta = (v: number) => ((v + 180) % 360 + 360) % 360 - 180
const SENSOR_SMOOTHING_SECONDS = 0.11
export const DEVICE_TILT_PITCH = 0.3
const PREFERENCE_KEY = 'vihko:device-tilt'

export function supportsDeviceTilt(): boolean {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window
}

export function orientationTilt(
  beta: number,
  gamma: number,
  baseBeta: number,
  baseGamma: number,
  screenAngle = 0,
) {
  let x = angleDelta(gamma - baseGamma)
  let y = angleDelta(beta - baseBeta)
  switch (((screenAngle % 360) + 360) % 360) {
    case 90: [x, y] = [y, -x]; break
    case 180: [x, y] = [-x, -y]; break
    case 270: [x, y] = [-y, x]; break
  }
  return { x: normalized(x / 22), y: normalized(y / 22) }
}

export function smoothTilt(
  previous: { x: number; y: number },
  next: { x: number; y: number },
  dt: number,
) {
  const alpha = 1 - Math.exp(-Math.min(0.25, Math.max(0, dt)) / SENSOR_SMOOTHING_SECONDS)
  const x = previous.x + (next.x - previous.x) * alpha
  const y = previous.y + (next.y - previous.y) * alpha
  return {
    x: Math.abs(x) < 0.015 ? 0 : x,
    y: Math.abs(y) < 0.015 ? 0 : y,
  }
}

export function deviceTiltRotation(x: number, y: number, yaw = 0.26) {
  return {
    rotX: clamp(y) * DEVICE_TILT_PITCH,
    rotY: clamp(x) * yaw,
  }
}

export function shouldApplyJournalDeviceTilt(active: boolean, mode: 'fan' | 'spread') {
  return active && mode === 'fan'
}

function orientationConstructor() {
  return window.DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>
  }
}

export function requiresDeviceTiltPermission(): boolean {
  return supportsDeviceTilt() && typeof orientationConstructor().requestPermission === 'function'
}

function notify() {
  listeners.forEach((listener) => listener())
}

function onOrientation(event: DeviceOrientationEvent) {
  if (event.beta == null || event.gamma == null) return
  if (!baseline) {
    baseline = { beta: event.beta, gamma: event.gamma }
    filtered = { x: 0, y: 0 }
    lastSampleTime = event.timeStamp
    return
  }
  const angle = screen.orientation?.angle ?? 0
  const next = orientationTilt(event.beta, event.gamma, baseline.beta, baseline.gamma, angle)
  const now = event.timeStamp || performance.now()
  const dt = lastSampleTime ? (now - lastSampleTime) / 1000 : 1 / 60
  lastSampleTime = now
  filtered = smoothTilt(filtered, next, dt)
  deviceTilt.x = filtered.x
  deviceTilt.y = filtered.y
  notify()
}

async function activateDeviceTilt(): Promise<boolean> {
  if (!supportsDeviceTilt()) return false
  try {
    const DeviceOrientation = orientationConstructor()
    if (DeviceOrientation.requestPermission) {
      const permission = await DeviceOrientation.requestPermission()
      if (permission !== 'granted') return false
    }
    if (!deviceTilt.active) {
      baseline = null
      filtered = { x: 0, y: 0 }
      lastSampleTime = 0
      deviceTilt.x = 0
      deviceTilt.y = 0
      window.addEventListener('deviceorientation', onOrientation)
      deviceTilt.active = true
      notify()
    }
    return true
  } catch {
    return false
  }
}

function savePreference(enabled: boolean) {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, enabled ? '1' : '0')
  } catch { /* storage may be unavailable */ }
}

export async function enableDeviceTilt(): Promise<boolean> {
  const enabled = await activateDeviceTilt()
  if (enabled) savePreference(true)
  return enabled
}

export function disableDeviceTilt() {
  savePreference(false)
  if (!deviceTilt.active) return
  window.removeEventListener('deviceorientation', onOrientation)
  baseline = null
  filtered = { x: 0, y: 0 }
  lastSampleTime = 0
  deviceTilt.active = false
  deviceTilt.x = 0
  deviceTilt.y = 0
  notify()
}

export function subscribeDeviceTilt(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function startDeviceTiltByDefault(): Promise<boolean> {
  let preference: string | null = null
  try {
    preference = window.localStorage.getItem(PREFERENCE_KEY)
  } catch { /* storage may be unavailable */ }
  if (preference === '0' || requiresDeviceTiltPermission()) return Promise.resolve(false)
  return activateDeviceTilt()
}
