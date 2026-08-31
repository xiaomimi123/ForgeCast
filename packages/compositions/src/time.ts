/** 实测现有成片为 1080×1920 @ 30fps（HyperFrames 用其默认值）。改这个值会让所有卡点错位。 */
export const FPS = 30
export function secToFrames(sec: number): number { return Math.round(sec * FPS) }
export function framesToSec(frames: number): number { return frames / FPS }
