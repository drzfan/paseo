import {
  AudioInputs,
  RunAnywhere,
  SDKEnvironment,
  createPushableAudioStream,
} from "@runanywhere/core";
import { ONNX } from "@runanywhere/onnx";

/**
 * Native loader for the RunAnywhere on-device speech SDK.
 *
 * The SDK ships as a direct dependency, so this is a static import — the
 * runtime protection that remains is the init sequence: if the native module
 * or backend registration fails once, `isRunAnywhereAvailable()` flips false
 * and the voice runtime falls back to the cloud voice session for the rest
 * of the process lifetime.
 */

export type RunAnywhereFacade = typeof RunAnywhere;

let readyFacade: Promise<RunAnywhereFacade> | null = null;
let initFailed = false;

/** Whether on-device speech can be attempted on this process. */
export function isRunAnywhereAvailable(): boolean {
  return !initFailed;
}

/**
 * Bring the SDK up, idempotently: sherpa-ONNX backend registration, then the
 * keyless local-mode initialize (no control-plane credentials; local inference
 * works while the deferred network phase retries in the background).
 */
export function ensureRunAnywhereReady(): Promise<RunAnywhereFacade> {
  if (!readyFacade) {
    readyFacade = (async () => {
      await ONNX.register();
      await RunAnywhere.initialize({
        apiKey: "",
        baseUrl: "",
        environment: SDKEnvironment.SDK_ENVIRONMENT_DEVELOPMENT,
      });
      return RunAnywhere;
    })().catch((error: unknown) => {
      initFailed = true;
      readyFacade = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
  }
  return readyFacade;
}

export { createPushableAudioStream, AudioInputs, SDKEnvironment };

/** Push stream for feeding mic PCM into transcribeStream/detectStream. */
export function createPushStream(): ReturnType<typeof createPushableAudioStream> {
  return createPushableAudioStream();
}

/** Wrap a PCM16 mono chunk into the SDK's AudioInput. */
export function pcm16Input(
  chunk: Uint8Array,
  sampleRate = 16000,
): ReturnType<typeof AudioInputs.pcm16> {
  return AudioInputs.pcm16(chunk, sampleRate);
}
