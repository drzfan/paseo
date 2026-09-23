import type { AudioInput, PushableAudioStream } from "@runanywhere/core";
import type { RunAnywhereFacade } from "./runanywhere-loader.native";

/**
 * Web/Electron stub for the RunAnywhere loader. On-device speech is a native
 * feature; on web every entry point reports unavailable so the voice runtime
 * keeps using the cloud voice session. The export surface mirrors the native
 * loader because shared modules (pcm.ts, ondevice-voice-session.ts) sit in the
 * web bundle graph and only run behind a native gate.
 */

function unavailable(): never {
  throw new Error("On-device speech is not available on this platform");
}

export function isRunAnywhereAvailable(): boolean {
  return false;
}

export function ensureRunAnywhereReady(): Promise<RunAnywhereFacade> {
  return Promise.reject(new Error("On-device speech is not available on this platform"));
}

export function createPushStream(): PushableAudioStream {
  return unavailable();
}

export function pcm16Input(_chunk: Uint8Array, _sampleRate?: number): AudioInput {
  return unavailable();
}
