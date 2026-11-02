import { describe, expect, it } from 'vitest'
import {
  DEVICE_TILT_PITCH, deviceTiltRotation, orientationTilt, shouldApplyJournalDeviceTilt, smoothTilt,
} from './deviceTilt'

describe('orientationTilt', () => {
  it('uses orientation changes relative to the enable position', () => {
    expect(orientationTilt(11, -11, 0, 0)).toEqual({ x: -0.5, y: 0.5 })
  })

  it('clamps large tilts and wraps beta across the angle boundary', () => {
    expect(orientationTilt(-150, 90, 170, 0)).toEqual({ x: 1, y: 1 })
  })

  it('rotates the axes for landscape screen orientations', () => {
    expect(orientationTilt(11, 0, 0, 0, 90)).toEqual({ x: 0.5, y: 0 })
    expect(orientationTilt(11, 0, 0, 0, 270)).toEqual({ x: -0.5, y: 0 })
  })
})

describe('smoothTilt', () => {
  it('filters a sudden sensor jump and converges over successive samples', () => {
    const first = smoothTilt({ x: 0, y: 0 }, { x: 1, y: -1 }, 1 / 60)
    expect(first.x).toBeGreaterThan(0)
    expect(first.x).toBeLessThan(0.2)
    expect(first.y).toBe(-first.x)

    let settled = first
    for (let i = 0; i < 30; i++) settled = smoothTilt(settled, { x: 1, y: -1 }, 1 / 60)
    expect(settled.x).toBeGreaterThan(0.98)
    expect(settled.y).toBeLessThan(-0.98)
  })

  it('removes tiny residual sensor jitter around neutral', () => {
    expect(smoothTilt({ x: 0, y: 0 }, { x: 0.01, y: -0.01 }, 1 / 60))
      .toEqual({ x: 0, y: 0 })
  })
})

describe('deviceTiltRotation', () => {
  it('follows forward/backward pitch without changing the yaw mapping', () => {
    const rotation = deviceTiltRotation(0.5, 0.5, 0.2)
    expect(DEVICE_TILT_PITCH).toBe(0.3)
    expect(rotation.rotX).toBe(0.15)
    expect(rotation.rotY).toBe(0.1)
    expect(deviceTiltRotation(0, -0.5).rotX).toBe(-0.15)
  })
})

describe('shouldApplyJournalDeviceTilt', () => {
  it('applies sensor movement to the fan but not the book spread', () => {
    expect(shouldApplyJournalDeviceTilt(true, 'fan')).toBe(true)
    expect(shouldApplyJournalDeviceTilt(true, 'spread')).toBe(false)
    expect(shouldApplyJournalDeviceTilt(false, 'fan')).toBe(false)
  })
})
