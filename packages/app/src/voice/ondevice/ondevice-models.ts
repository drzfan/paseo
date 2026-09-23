import type { DownloadEvent, ModelRegistration } from "@runanywhere/core";
import { ensureRunAnywhereReady, type RunAnywhereFacade } from "./runanywhere-loader";

/** A row from the SDK's model registry (derived; the proto type is not re-exported in 0.20.x). */
type RegisteredModel = Awaited<ReturnType<RunAnywhereFacade["models"]["list"]>>[number];

/**
 * On-device speech model registry. English ships first; the Chinese pack is
 * registered behind the same table once its upstream URLs are verified on a
 * device (see notes/integration-design.md §9).
 *
 * `@runanywhere/proto-ts` enum members are numeric (the package is a
 * transitive dependency of @runanywhere/core and not directly importable
 * here), so the values below are the verified numeric members of the proto
 * enums, typed through the re-exported enum types. If the SDK ever changes
 * these, registration fails loudly at runtime and we fall back to cloud.
 */
const FRAMEWORK_SHERPA = 23 as ModelRegistration["framework"]; // INFERENCE_FRAMEWORK_SHERPA
const FRAMEWORK_ONNX = 1 as ModelRegistration["framework"]; // INFERENCE_FRAMEWORK_ONNX
const CATEGORY_STT = 2 as ModelRegistration["category"]; // MODEL_CATEGORY_SPEECH_RECOGNITION
const CATEGORY_TTS = 3 as ModelRegistration["category"]; // MODEL_CATEGORY_SPEECH_SYNTHESIS
const CATEGORY_VAD = 9 as ModelRegistration["category"]; // MODEL_CATEGORY_VOICE_ACTIVITY_DETECTION
const REGISTRY_STATUS_DOWNLOADED = 3; // MODEL_REGISTRY_STATUS_DOWNLOADED
const REGISTRY_STATUS_LOADED = 5; // MODEL_REGISTRY_STATUS_LOADED

export type OnDeviceVoiceLanguagePack = "en" | "zh";
export type OnDeviceVoiceModelRole = "stt" | "tts" | "vad";

export interface OnDeviceVoiceModel {
  id: string;
  role: OnDeviceVoiceModelRole;
  bcp47: string;
  downloadBytes: number;
  /** TTS only: the voice's native output sample rate (piper 22050, melo 44100). */
  outputSampleRate?: number;
}

interface LanguagePackSpec {
  sttModelId: string;
  ttsModelId: string;
  /** Language tag passed to transcribeStream; omit-handling stays per model. */
  sttLanguage: string;
  register: ModelRegistration[];
  models: OnDeviceVoiceModel[];
}

const ENGLISH_VAD_REGISTRATION: ModelRegistration = {
  id: "silero-vad",
  name: "Silero VAD",
  url: "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
  framework: FRAMEWORK_ONNX,
  category: CATEGORY_VAD,
  memoryRequirementBytes: 2_327_524,
};

const ENGLISH_PACK: LanguagePackSpec = {
  sttModelId: "sherpa-onnx-whisper-tiny.en",
  ttsModelId: "vits-piper-en_US-lessac-medium",
  sttLanguage: "en",
  register: [
    {
      id: "sherpa-onnx-whisper-tiny.en",
      name: "Sherpa Whisper Tiny (EN)",
      archiveUrl:
        "https://github.com/RunanywhereAI/sherpa-onnx/releases/download/runanywhere-models-v1/sherpa-onnx-whisper-tiny.en.tar.gz",
      framework: FRAMEWORK_SHERPA,
      category: CATEGORY_STT,
      memoryRequirementBytes: 75_000_000,
    },
    {
      id: "vits-piper-en_US-lessac-medium",
      name: "Piper TTS (US English - Medium)",
      archiveUrl:
        "https://github.com/RunanywhereAI/sherpa-onnx/releases/download/runanywhere-models-v1/vits-piper-en_US-lessac-medium.tar.gz",
      framework: FRAMEWORK_SHERPA,
      category: CATEGORY_TTS,
      memoryRequirementBytes: 65_000_000,
    },
    ENGLISH_VAD_REGISTRATION,
  ],
  models: [
    {
      id: "sherpa-onnx-whisper-tiny.en",
      role: "stt",
      bcp47: "en",
      downloadBytes: 75_000_000,
    },
    {
      id: "vits-piper-en_US-lessac-medium",
      role: "tts",
      bcp47: "en-US",
      downloadBytes: 65_000_000,
      outputSampleRate: 22050,
    },
  ],
};

// Chinese pack: reserved. URLs point at the upstream sherpa-onnx release
// assets and still need on-device verification (archive layout, SenseVoice
// behavior through the streaming API, melo multi-file completeness) before
// the settings UI un-gates "zh".
const CHINESE_PACK: LanguagePackSpec = {
  sttModelId: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue",
  ttsModelId: "vits-melo-tts-zh_en",
  sttLanguage: "zh",
  register: [
    {
      id: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue",
      name: "SenseVoice Small (zh/en/ja/ko/yue)",
      archiveUrl:
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
      framework: FRAMEWORK_SHERPA,
      category: CATEGORY_STT,
      memoryRequirementBytes: 160_000_000,
    },
    {
      id: "vits-melo-tts-zh_en",
      name: "MeloTTS (zh/en)",
      archiveUrl:
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2",
      framework: FRAMEWORK_SHERPA,
      category: CATEGORY_TTS,
      memoryRequirementBytes: 170_000_000,
    },
    ENGLISH_VAD_REGISTRATION,
  ],
  models: [
    {
      id: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue",
      role: "stt",
      bcp47: "zh",
      downloadBytes: 160_000_000,
    },
    {
      id: "vits-melo-tts-zh_en",
      role: "tts",
      bcp47: "zh-CN",
      downloadBytes: 170_000_000,
      outputSampleRate: 44100,
    },
  ],
};

export const LANGUAGE_PACKS: Record<OnDeviceVoiceLanguagePack, LanguagePackSpec> = {
  en: ENGLISH_PACK,
  zh: CHINESE_PACK,
};

const VAD_MODEL: OnDeviceVoiceModel = {
  id: "silero-vad",
  role: "vad",
  bcp47: "*",
  downloadBytes: 2_327_524,
};

/** Every model a pack needs on disk, including the shared VAD. */
export function packModels(pack: OnDeviceVoiceLanguagePack): OnDeviceVoiceModel[] {
  return [...LANGUAGE_PACKS[pack].models, VAD_MODEL];
}

export function estimatePackDownloadBytes(pack: OnDeviceVoiceLanguagePack): number {
  return packModels(pack).reduce((sum, model) => sum + model.downloadBytes, 0);
}

export function packSttLanguage(pack: OnDeviceVoiceLanguagePack): string {
  return LANGUAGE_PACKS[pack].sttLanguage;
}

/**
 * Register a pack's catalog rows. Idempotent — commons merges runtime fields
 * on re-registration, so this is safe to run on every cold start.
 */
export async function ensurePackRegistered(
  pack: OnDeviceVoiceLanguagePack,
  facade?: RunAnywhereFacade,
): Promise<void> {
  const sdk = facade ?? (await ensureRunAnywhereReady());
  await Promise.all(
    LANGUAGE_PACKS[pack].register.map((entry) =>
      sdk.models.register(entry).catch((error: unknown) => {
        // Registration failures are not fatal here: download/load re-raises
        // them and the voice runtime falls back to the cloud session.
        console.warn(`[OnDeviceVoice] model register failed: ${entry.id}`, error);
      }),
    ),
  );
}

export interface ModelDownloadProgress {
  modelId: string;
  bytesDone: number;
  bytesTotal: number;
  percent: number | undefined;
  extracting: boolean;
}

/** Drain one model's download event stream to completion. */
export async function drainModelDownload(
  modelId: string,
  onProgress: (progress: ModelDownloadProgress) => void,
  facade?: RunAnywhereFacade,
): Promise<void> {
  const sdk = facade ?? (await ensureRunAnywhereReady());
  const iterator = sdk.models.download(modelId)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      const event: DownloadEvent = step.value;
      if (event.type === "failed") {
        throw event.error ?? new Error(`Model download failed: ${modelId}`);
      }
      onProgress({
        modelId,
        bytesDone: "bytesDone" in event ? event.bytesDone : 0,
        bytesTotal: "bytesTotal" in event ? event.bytesTotal : 0,
        percent: "percent" in event ? event.percent : undefined,
        extracting: event.type === "extracting" || event.type === "verifying",
      });
    }
  } catch (error) {
    await iterator.return?.().catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Download every model a pack needs, sequentially, reporting progress. */
export async function downloadPack(
  pack: OnDeviceVoiceLanguagePack,
  onProgress: (progress: ModelDownloadProgress) => void,
  facade?: RunAnywhereFacade,
): Promise<void> {
  const sdk = facade ?? (await ensureRunAnywhereReady());
  await ensurePackRegistered(pack, sdk);
  for (const model of packModels(pack)) {
    await drainModelDownload(model.id, onProgress, sdk);
  }
}

/** Whether every pack model is on disk (registryStatus DOWNLOADED or LOADED). */
export async function isPackDownloaded(
  pack: OnDeviceVoiceLanguagePack,
  facade?: RunAnywhereFacade,
): Promise<boolean> {
  const sdk = facade ?? (await ensureRunAnywhereReady());
  const registered = await sdk.models.list();
  const byId = new Map<string, RegisteredModel>(registered.map((model) => [model.id, model]));
  return packModels(pack).every((model) => {
    const status = byId.get(model.id)?.registryStatus;
    return status === REGISTRY_STATUS_DOWNLOADED || status === REGISTRY_STATUS_LOADED;
  });
}

export interface LoadedVoiceModels {
  stt: OnDeviceVoiceModel;
  tts: OnDeviceVoiceModel;
  vad: OnDeviceVoiceModel;
}

/**
 * Make a pack resident: register, download (only when the settings screen has
 * not already), then load all three models. Category residency is what the
 * stt/tts/vad namespaces resolve against, so this must precede any session.
 */
export async function ensurePackLoaded(
  pack: OnDeviceVoiceLanguagePack,
  onProgress?: (progress: ModelDownloadProgress) => void,
  facade?: RunAnywhereFacade,
): Promise<LoadedVoiceModels> {
  const sdk = facade ?? (await ensureRunAnywhereReady());
  const spec = LANGUAGE_PACKS[pack];
  await ensurePackRegistered(pack, sdk);
  if (!(await isPackDownloaded(pack, sdk))) {
    await downloadPack(pack, onProgress ?? (() => undefined), sdk);
  }
  for (const id of [spec.sttModelId, spec.ttsModelId, VAD_MODEL.id]) {
    await sdk.models.load(id);
  }
  return {
    stt: spec.models.find((model) => model.role === "stt") ?? spec.models[0]!,
    tts: spec.models.find((model) => model.role === "tts") ?? spec.models[1]!,
    vad: VAD_MODEL,
  };
}
