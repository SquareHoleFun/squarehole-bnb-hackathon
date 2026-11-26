import { describe, expect, it } from 'vitest';
import { BOX, REST_POSE, SEQUENCE_MS, SPHERE_RADIUS, poseAt, type Pose } from './sequence';

const STEP_MS = 4;

function samples(): readonly { readonly ms: number; readonly pose: Pose }[] {
  const count = Math.ceil(SEQUENCE_MS / STEP_MS) + 1;
  return Array.from({ length: count }, (_, i) => {
    const ms = Math.min(i * STEP_MS, SEQUENCE_MS);
    return { ms, pose: poseAt(ms) };
  });
}

describe('shape-sorter sequence', () => {
  it('is short (under three seconds)', () => {
    expect(SEQUENCE_MS).toBeGreaterThan(1500);
    expect(SEQUENCE_MS).toBeLessThanOrEqual(3000);
  });

  it('starts and ends exactly on the rest pose so poster, first and last frame match', () => {
    expect(poseAt(0)).toEqual(REST_POSE);
    expect(poseAt(SEQUENCE_MS)).toEqual(REST_POSE);
  });

  it('clamps out-of-range and invalid times to the rest pose', () => {
    expect(poseAt(-50)).toEqual(REST_POSE);
    expect(poseAt(SEQUENCE_MS + 10_000)).toEqual(REST_POSE);
    expect(poseAt(Number.NaN)).toEqual(REST_POSE);
  });

  it('rests the sphere in the square hole with part of it visible above the rim', () => {
    const top = BOX.height + 2 * BOX.bevel;
    expect(REST_POSE.sphere.x).toBe(0);
    expect(REST_POSE.sphere.z).toBe(0);
    expect(REST_POSE.sphere.y).toBeLessThan(top);
    expect(REST_POSE.sphere.y + SPHERE_RADIUS).toBeGreaterThan(top);
  });

  it('leaves the hole, touches the ground and drops back in', () => {
    const all = samples();
    const top = BOX.height + 2 * BOX.bevel;
    const highest = Math.max(...all.map((s) => s.pose.sphere.y));
    const lowest = Math.min(...all.map((s) => s.pose.sphere.y));
    expect(highest).toBeGreaterThan(top + SPHERE_RADIUS);
    expect(lowest).toBeLessThan(SPHERE_RADIUS * 1.05);
  });

  it('moves continuously (no teleporting between 4ms samples)', () => {
    let previous = poseAt(0).sphere;
    for (const { ms, pose } of samples()) {
      const b = pose.sphere;
      const jump = Math.hypot(b.x - previous.x, b.y - previous.y, b.z - previous.z);
      expect(jump, `jump at ${ms}ms`).toBeLessThan(0.12);
      previous = b;
    }
  });

  it('keeps squash, box bounce and wobble in a gentle range', () => {
    for (const { pose } of samples()) {
      expect(pose.sphere.squash).toBeGreaterThan(0.7);
      expect(pose.sphere.squash).toBeLessThan(1.3);
      expect(pose.box).toBeGreaterThan(0.93);
      expect(pose.box).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(pose.wobble)).toBeLessThan(0.2);
    }
  });

  it('never passes through the wooden top: below the rim the sphere is either centred in the hole or clear of the box', () => {
    const top = BOX.height + 2 * BOX.bevel;
    const clear = BOX.width / 2 + BOX.bevel + SPHERE_RADIUS;
    for (const { ms, pose } of samples()) {
      const bottom = pose.sphere.y - SPHERE_RADIUS * pose.sphere.squash;
      if (bottom >= top) continue;
      const centred = Math.abs(pose.sphere.x) < 1e-6 && Math.abs(pose.sphere.z) < 1e-6;
      const outside = Math.abs(pose.sphere.x) > clear || Math.abs(pose.sphere.z) > clear;
      expect(centred || outside, `sphere intersects the box top at ${ms}ms`).toBe(true);
    }
  });

  it('never sinks below the ground', () => {
    for (const { ms, pose } of samples()) {
      const bottom = pose.sphere.y - SPHERE_RADIUS * pose.sphere.squash;
      expect(bottom, `below ground at ${ms}ms`).toBeGreaterThan(-1e-6);
    }
  });

  it('is deterministic', () => {
    expect(poseAt(1234.5)).toEqual(poseAt(1234.5));
  });
});
