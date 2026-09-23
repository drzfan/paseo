# 端侧语音透传集成设计（RunAnywhere × paseo app）

> 状态：设计稿（只含文档与代码草稿，未改任何源码）
> 基线：paseo checkout `ec43e9067`（文中所有行号对应此 commit）；RunAnywhere RN SDK `bindings/react-native/packages/core` @ `0.20.37`（`~/research/runanywhere-sdks`）
> 背景材料：`~/research/paseo/learnings/2026-09-24-app-voice-on-device-migration.md`、`~/research/runanywhere-sdks/learnings/2026-09-24-paseo-integration.md`

## 0. 目标与范围

**目标**：新增「端侧语音模式」——daemon 完全无感知语音。按语音键后：

```
上行：mic PCM(16k/16bit/mono) → RunAnywhere 端侧 STT（流式 partial → final）
      → final 文本加语音风格前缀 → client.sendAgentMessage()（普通文本消息通道）
下行：daemon agent_stream timeline 事件（assistant_message 全量快照）
      → 增量 delta → 句缓冲器 → RunAnywhere 端侧 TTS 流式合成
      → float32→s16 转换 → paseo AudioEngine 播放
```

**不在范围**：daemon 侧任何改动（无协议扩展、无 voice-session 改造）；LLM 端侧化；Level 2 协议能力位方案（后续提给上游）。

**原则**：
- 原云端 voice session 完整保留，作为默认路径与回退路径；
- RunAnywhere SDK 做成**可选依赖**（optional peerDependency + 运行时探测），未安装 SDK 的构建零影响；
- 端侧模块只在 native 生效（iOS/Android），web/Electron 自动回落云端模式。

---

## 1. 源码事实清单（设计依据）

### 1.1 RunAnywhere RN SDK（路径省略前缀 `~/research/runanywhere-sdks/bindings/react-native/`）

| 事实 | 出处 |
|---|---|
| 初始化序列：`ONNX.register()` → `RunAnywhere.initialize({apiKey:'',baseUrl:'',environment:DEVELOPMENT})`（keyless 本地模式可用）→ `models.register(...)`（幂等可重跑） | `example/App.tsx:118-160,190-205`；`packages/core/src/Public/RunAnywhere.ts:316-329` |
| 流式 STT：`stt.transcribeStream(audio: AsyncIterable<AudioInput>, options)` → `AsyncIterable<TranscriptionEvent>`，事件 `started` / `partial`(alternatives[0].text) / `transcriptFinal`(segment.text/confidence) / `completed` / `failed` | `packages/core/src/Public/Api/Stt.ts:83-145`；example `STTScreen.tsx:342-349` |
| **一次 `transcribeStream` = 一个 native 会话**：输入 iterable 结束（close）触发 native `sttStreamStop`，drain 出 final；若整段没有 final 会合成一个空 final。SDK 未初始化或**未加载 STT 模型 → 静默零事件结束**（不抛错） | `packages/core/src/Public/Extensions/STT/RunAnywhere+STT.ts:176-183,352-366` |
| 麦克风喂入：`createPushableAudioStream()` → `{iterable, push(chunk:Uint8Array), close()}`；PCM 需包成 `AudioInputs.pcm16(chunk, 16000)` | `packages/core/src/Public/Helpers/PushableAudioStream.ts`；example `STTScreen.tsx:30,88-115` |
| VAD：`vad.detectStream(audio, {model:'silero-vad', minSilenceMs, minSpeechMs, activationThreshold})` → `speechStarted`/`speechEnded`/`activity{isSpeech,probability}`/`failed`/`completed`；`options.model` 会触发自动下载+加载 | `packages/core/src/Public/Api/Vad.ts:63-135` |
| 流式 TTS：`tts.synthesizeStream(text, options)` → `AsyncIterable<AudioChunk{data,index,isFinal}>`；**未加载 TTS 模型 → 静默结束**。`tts.speak()` 用 SDK 内置播放器（自带 audio session，与 paseo 的 expo-two-way-audio 冲突 → **不用**），interrupt 用 `SpeechHandle.interrupt()` | `packages/core/src/Public/Api/Tts.ts:76-110`；`Extensions/TTS/RunAnywhere+TTS.ts:125-158` |
| **TTS PCM 是 float32、模型原生采样率**：proto 注释明确 `AUDIO_FORMAT_PCM` = float32；`TTSOptions.sample_rate=0`（默认）= 原生率（piper-lessac = 22050 Hz） | `idl/tts_options.proto:58-68` |
| 模型管理：`models.register({id,name,url|archiveUrl|files,framework,category,memoryRequirementBytes})` / `models.download(id)` → `DownloadEvent`(started/progress/bytesDone/bytesTotal/extracting/completed/failed) / `models.load(id)` / `models.loaded(category)` / `models.delete(id)` / `models.list({category})` | `packages/core/src/Public/Api/Models.ts:118-330` |
| 官方英文模型注册条目（直接抄）：STT `sherpa-onnx-whisper-tiny.en`、TTS `vits-piper-en_US-lessac-medium`、VAD `silero-vad` | `example/src/services/ModelCatalogBootstrap.ts:445-528` |
| peerDeps：`react-native >=0.83.1`、`react-native-nitro-modules ^0.33.9`、`react >=19`（fs/blob-util/device-info 可选）。paseo 现状 RN 0.81.5 / Expo 54 → **不满足，见 §10** | `packages/core/package.json:peerDependencies`；`packages/app/package.json:114` |
| License：RunAnywhere License v1.0，OSI 开源项目免费（1.f 条），需保留 attribution | `~/research/runanywhere-sdks/LICENSE` |

### 1.2 paseo app（路径省略前缀 `packages/app/src/`）

| 事实 | 出处 |
|---|---|
| 采集 PCM：native `onMicrophoneData` → `onCaptureData(Uint8Array)`，16kHz/16bit/mono，mute 在 engine 层拦截（muted 时不下发） | `voice/audio-engine.native.ts:60-66` |
| 上行发送：`voice-runtime.ts` `handleCapturePcm` (L647) → `uploader.pushPcmChunk` (L505) → base64 → `adapter.sendVoiceAudioChunk(base64, "audio/pcm;rate=16000;bits=16")` | `voice/voice-runtime.ts:505-521,647-652` |
| adapter 实现（daemon RPC 封装）：`client.setVoiceMode` / `client.sendVoiceAudioChunk` / `client.audioPlayed` / `client.abortRequest` / `setAssistantAudioPlaying`（纯客户端 store 标志） | `contexts/session-context.tsx:340-376` |
| 文本消息发送 API：`client.sendAgentMessage(agentId, text, {messageId, activeTurnBehavior:"interrupt"|"steer", images, attachments})`（wire `send_agent_message_request`）；composer 的完整发送管线 `dispatchComposerAgentMessage`（含乐观插入本地 timeline） | `packages/client/src/daemon-client.ts:3345-3383`；`composer/actions.ts:201-234` |
| **daemon 回复 delta 的真实形态**：`agent_stream` 消息 → `event.type === "timeline"` → `event.item = {type:"assistant_message", text, messageId?}`，text 是**全量快照、单调前缀增长**（reducer 依赖 `event.item.text.startsWith(current.text)` 合并）。即 delta = `newText.slice(seenLen)` | `contexts/session-context.tsx:394-433`；`timeline/session-stream-reducers.ts:755-783`；`packages/protocol/src/messages.ts:746-752,667-671` |
| turn 生命周期：同一条 `agent_stream` 流上的 `turn_started/turn_completed/turn_failed/turn_canceled`，app 在 `onStream` 里转发给 `voiceRuntime.onTurnEvent` | `contexts/session-context.tsx:396-406`；`voice/voice-runtime.ts:940-962` |
| 播放路径：`engine.play({arrayBuffer,size,type:"audio/pcm;rate=N;bits=16"})` — 从 mime 解析采样率、内部重采样到 16k、`playPCMData`；`engine.stop()+clearQueue()` 即打断；队列 + duration 超时 resolve | `voice/audio-engine.native.ts:19-27,168-205,270-285` |
| phase 状态机：`disabled/starting/listening/submitting/waiting/playing/stopping`；`onAssistantAudioStarted/Finished`(L867/876) 复用价值高（stopCue + phase 切换 + turnInProgress 判断） | `voice/voice-runtime.ts:43-51,867-894` |
| 云端模式启动门槛：`startVoice` 检查 daemon capability `voice.voice`（`resolveVoiceUnavailableMessage`）→ 端侧模式必须**跳过**此检查 | `voice/voice-runtime.ts:727-736`；`utils/server-info-capabilities.ts:28-49` |
| daemon 语音模式的系统提示词与 spoken-input 包装（端侧模式需在客户端模拟等价物） | `packages/server/src/server/voice-config.ts:5-16,46-57` |
| daemon 侧 barge-in 语义：确认用户说话 → abort 运行中 agent turn | `packages/server/src/server/session/voice/voice-session.ts:987-994` |
| 设置存储：`AppSettings` 接口 + `DEFAULT_CLIENT_SETTINGS` + zod 归一化 + AsyncStorage（`APP_SETTINGS_KEY`），react-query 缓存，`useAppSettings()` / 非组件 `persistAppSettings()` | `hooks/use-settings/storage.ts:67-…`；`hooks/use-settings/index.ts:96-205` |
| voice UI：composer 麦克风按钮 → `attemptStartRealtimeVoice` → `voice.startVoice(serverId, agentId)`（toggle 式连续会话，非按住说话）；overlay 组件 `RealtimeVoiceOverlay` 显示 volume/isSpeaking | `composer/index.tsx:514-533`；`components/realtime-voice-overlay.tsx` |

---

## 2. 总体架构

```
                        packages/app/src/voice/
┌────────────────────────────────────────────────────────────────────────┐
│ voice-runtime.ts（改造，最小 diff）                                      │
│   startVoice ──┬─ engine === "cloud"    → 原路径（setVoiceMode + 上行流） │
│                └─ engine === "onDevice" → onDevice.start()             │
│   handleCapturePcm ─┬─ cloud    → uploader → adapter.sendVoiceAudioChunk│
│                     └─ onDevice → session.pushPcm(chunk)               │
│   onAgentStreamEvent(新增) ──→ session.handleAgentStreamEvent(...)       │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ 依赖注入（.native 可用，web 为 null）
┌──────────────▼─────────────────────────────────────────────────────────┐
│ ondevice/（新增目录）                                                    │
│  runanywhere-loader.ts   可选依赖动态加载 + 能力探测 + 单例初始化          │
│  ondevice-models.ts      模型注册表（英文先行/中文预留）+ 下载/加载封装     │
│  ondevice-voice-session.ts  端侧语音会话：VAD 断句→STT→sendMessage；      │
│                            句缓冲→TTS 队列→播放→interrupt                │
│  sentence-buffer.ts      纯逻辑：全量快照→delta→句子切分（可单测）         │
│  speech-text.ts          纯逻辑：markdown 清洗 + 语音风格前缀（可单测）    │
│  pcm.ts                  pcmAudioInputs 包装 + f32→s16 + 播放 source    │
└────────────────────────────────────────────────────────────────────────┘
               │ 复用
        AudioEngine（零改动）        client.sendAgentMessage / abortRequest
```

daemon 侧零改动：端侧模式下不调用 `setVoiceMode`，daemon 不知道有语音；回复走普通 `agent_stream`。

---

## 3. 新模块代码草稿

### 3.1 `voice/ondevice/runanywhere-loader.ts` — 可选依赖加载与初始化

```typescript
/**
 * 可选加载 @runanywhere/core + @runanywhere/onnx。
 *
 * paseo 主仓不直接依赖 RunAnywhere：SDK 以 optional peerDependency 形式存在，
 * 这里全部走 require() + try/catch，未安装时 isRunAnywhereAvailable() 返回
 * false，端侧语音入口直接隐藏/回退。require 路径必须是字符串字面量以便
 * Metro 静态分析；未安装时 require 抛错被 catch，不影响打包（SDK 列为
 * optionalDependency 时 Metro 会把它当可选解析失败处理——需在 app.json 的
 * expo.autolinking / metro resolver 中确认，见 §10 实施清单）。
 */
import { Platform } from "react-native";

export interface RunAnywhereMin {
  initialize(options: { apiKey: string; baseUrl: string; environment: number }): Promise<void>;
  reset(): Promise<void>;
  readonly isReady: boolean;
  readonly version: string;
  stt: {
    transcribeStream(
      audio: AsyncIterable<unknown>,
      options?: { language?: string },
    ): AsyncIterable<RunAnywhereTranscriptionEvent>;
    state(): Promise<{ isReady: boolean; modelId?: string }>;
  };
  tts: {
    synthesizeStream(text: string, options?: { speed?: number }): AsyncIterable<RunAnywhereAudioChunk>;
    state(): Promise<{ isReady: boolean }>;
  };
  vad: {
    detectStream(
      audio: AsyncIterable<unknown>,
      options?: {
        model?: string;
        activationThreshold?: number;
        minSpeechMs?: number;
        minSilenceMs?: number;
        prefixPaddingMs?: number;
      },
    ): AsyncIterable<RunAnywhereVadEvent>;
  };
  models: {
    register(model: RunAnywhereModelRegistration): Promise<unknown>;
    download(id: string): AsyncIterable<RunAnywhereDownloadEvent>;
    load(id: string): Promise<unknown>;
    loaded(category: number): Promise<{ id: string } | null>;
    list(filter?: { category?: number }): Promise<Array<{ id: string; registryStatus?: number }>>;
    delete(id: string): Promise<void>;
  };
}

// 事件形状（与 @runanywhere/core Public/Api/Types.ts 对齐的局部声明，
// 避免主仓类型依赖 SDK；SDK 安装后可改为直接 import type）
export interface RunAnywhereTranscriptionEvent {
  type: "started" | "partial" | "transcriptFinal" | "completed" | "failed";
  requestId?: string;
  sequence?: number;
  segment?: { text: string; confidence: number; durationMs: number };
  alternatives?: Array<{ text: string }>;
  error?: Error;
}
export interface RunAnywhereAudioChunk {
  data: Uint8Array;
  index: number;
  isFinal: boolean;
}
export interface RunAnywhereVadEvent {
  type: "speechStarted" | "speechEnded" | "activity" | "failed" | "completed";
  isSpeech?: boolean;
  probability?: number;
  timestampMs?: number;
  error?: Error;
}
export interface RunAnywhereDownloadEvent {
  type: "started" | "progress" | "extracting" | "completed" | "failed";
  bytesDone?: number;
  bytesTotal?: number;
  percent?: number;
  error?: Error;
}
export interface RunAnywhereModelRegistration {
  id: string;
  name: string;
  url?: string;
  archiveUrl?: string;
  files?: Array<{ url: string; filename: string; required?: boolean }>;
  framework: number; // InferenceFramework 枚举值，见 ondevice-models.ts 常量
  category: number;  // ModelCategory 枚举值
  memoryRequirementBytes?: number;
}

interface RunAnywhereOnnxBackend {
  register(): Promise<void | boolean>;
}

let cachedSdk: RunAnywhereMin | null = null;
let cachedOnnx: RunAnywhereOnnxBackend | null = null;
let unavailable = false;
let initPromise: Promise<RunAnywhereMin> | null = null;

function loadRaw(): { sdk: RunAnywhereMin; onnx: RunAnywhereOnnxBackend } | null {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null; // web/Electron 不加载
  try {
    // Metro 静态字符串 require；SDK 缺失时抛 "Unable to resolve module"
    const sdk = require("@runanywhere/core").RunAnywhere as RunAnywhereMin;
    const { AudioInputs, createPushableAudioStream } = require("@runanywhere/core");
    const onnx = require("@runanywhere/onnx").ONNX as RunAnywhereOnnxBackend;
    return { sdk, onnx, extras: { AudioInputs, createPushableAudioStream } };
  } catch {
    return null;
  }
}

export interface PushableStream {
  iterable: AsyncIterable<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
}
export function createPushStream(): PushableStream {
  const { createPushableAudioStream } = require("@runanywhere/core");
  return createPushableAudioStream() as PushableStream;
}
export function pcm16Input(chunk: Uint8Array, sampleRate = 16000): unknown {
  const { AudioInputs } = require("@runanywhere/core");
  return AudioInputs.pcm16(chunk, sampleRate);
}

export function isRunAnywhereAvailable(): boolean {
  if (unavailable) return false;
  if (cachedSdk) return true;
  const raw = loadRaw();
  if (!raw) {
    unavailable = true;
    return false;
  }
  return true;
}

/**
 * 幂等初始化：ONNX 后端注册 → RunAnywhere.initialize（keyless DEVELOPMENT，
 * 端侧推理不需要控制面；网络相位后台自行重试，失败不影响本地推理）。
 */
export function ensureRunAnywhereReady(): Promise<RunAnywhereMin> {
  if (cachedSdk) return Promise.resolve(cachedSdk);
  if (!initPromise) {
    initPromise = (async () => {
      const raw = loadRaw();
      if (!raw) throw new Error("RunAnywhere SDK is not installed on this build");
      const { SDKEnvironment } = require("@runanywhere/core");
      await raw.onnx.register(); // sherpa-onnx 引擎插件，注册一次
      await raw.sdk.initialize({
        apiKey: "",
        baseUrl: "",
        environment: SDKEnvironment.SDK_ENVIRONMENT_DEVELOPMENT,
      });
      cachedSdk = raw.sdk;
      return raw.sdk;
    })().catch((error) => {
      initPromise = null; // 允许重试
      throw error;
    });
  }
  return initPromise;
}
```

> **注**：`loadRaw()` 返回值里带了 `extras` 字段但接口类型没写——草稿示意；实现时把返回类型定成 `{sdk, onnx, extras: {AudioInputs, createPushableAudioStream}}` 或干脆拆成两个模块级 require 缓存（`createPushStream` / `pcm16Input` 已按后者写）。

### 3.2 `voice/ondevice/ondevice-models.ts` — 模型注册表与下载/加载封装

```typescript
/**
 * 端侧语音模型注册表。英文先行；中文条目已写好（URL 需在真机验证，
 * 见 §9）。framework/category 用 RunAnywhere proto 枚举的数值常量，
 * 与 @runanywhere/proto-ts/model_types 导出的枚举一致：
 *   INFERENCE_FRAMEWORK_SHERPA = 6（sherpa 模型）
 *   INFERENCE_FRAMEWORK_ONNX   = 2（silero-vad）
 *   MODEL_CATEGORY_SPEECH_RECOGNITION         = 3
 *   MODEL_CATEGORY_SPEECH_SYNTHESIS           = 4
 *   MODEL_CATEGORY_VOICE_ACTIVITY_DETECTION   = 5
 * （数值以安装的 proto-ts 为准做一层断言测试，防 SDK 升级改枚举。）
 */
import type { RunAnywhereDownloadEvent, RunAnywhereMin, RunAnywhereModelRegistration } from "./runanywhere-loader";

// ---- 枚举数值（安装 SDK 后替换为真实 import） ----
export const FRAMEWORK_SHERPA = 6;
export const FRAMEWORK_ONNX = 2;
export const CATEGORY_STT = 3;
export const CATEGORY_TTS = 4;
export const CATEGORY_VAD = 5;

export interface OnDeviceVoiceModel {
  /** 与 RunAnywhere registry 一致的模型 id */
  id: string;
  role: "stt" | "tts" | "vad";
  /** TTS 模型的原生输出采样率（piper-lessac=22050, melo-zh=44100）。STT/VAD 无此项 */
  outputSampleRate?: number;
  bcp47: string;
  downloadBytes: number;
}

export type OnDeviceVoiceLanguagePack = "en" | "zh";

interface LanguagePackSpec {
  sttModelId: string;
  ttsModelId: string;
  sttLanguageOption: string; // 传给 transcribeStream 的 language
  register: RunAnywhereModelRegistration[];
  models: OnDeviceVoiceModel[];
}

// ---- 英文包（全部来自官方 example catalog，URL 可信） ----
const ENGLISH_PACK: LanguagePackSpec = {
  sttModelId: "sherpa-onnx-whisper-tiny.en",
  ttsModelId: "vits-piper-en_US-lessac-medium",
  sttLanguageOption: "en",
  register: [
    {
      id: "sherpa-onnx-whisper-tiny.en",
      name: "Sherpa Whisper Tiny EN",
      archiveUrl:
        "https://github.com/RunanywhereAI/sherpa-onnx/releases/download/runanywhere-models-v1/sherpa-onnx-whisper-tiny.en.tar.gz",
      framework: FRAMEWORK_SHERPA,
      category: CATEGORY_STT,
      memoryRequirementBytes: 75_000_000,
    },
    {
      id: "vits-piper-en_US-lessac-medium",
      name: "Piper TTS en_US lessac medium",
      archiveUrl:
        "https://github.com/RunanywhereAI/sherpa-onnx/releases/download/runanywhere-models-v1/vits-piper-en_US-lessac-medium.tar.gz",
      framework: FRAMEWORK_SHERPA,
      category: CATEGORY_TTS,
      memoryRequirementBytes: 65_000_000,
    },
    {
      id: "silero-vad",
      name: "Silero VAD",
      url: "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
      framework: FRAMEWORK_ONNX,
      category: CATEGORY_VAD,
      memoryRequirementBytes: 2_327_524,
    },
  ],
  models: [
    { id: "sherpa-onnx-whisper-tiny.en", role: "stt", bcp47: "en", downloadBytes: 75_000_000 },
    { id: "vits-piper-en_US-lessac-medium", role: "tts", bcp47: "en-US", downloadBytes: 65_000_000, outputSampleRate: 22050 },
    { id: "silero-vad", role: "vad", bcp47: "*", downloadBytes: 2_327_524 },
  ],
};

// ---- 中文包（预留：URL 指向 sherpa-onnx 上游 asr-models release，真机验证后启用） ----
const CHINESE_PACK: LanguagePackSpec = {
  sttModelId: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue",
  ttsModelId: "vits-melo-tts-zh_en",
  sttLanguageOption: "zh",
  register: [
    {
      id: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue",
      name: "SenseVoice Small (zh/en/ja/ko/yue)",
      // 上游 tar.bz2（含顶层目录），archiveUrl 不带 layout → commons 自动推断
      archiveUrl:
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
      framework: FRAMEWORK_SHERPA,
      category: CATEGORY_STT,
      memoryRequirementBytes: 160_000_000,
    },
    {
      id: "vits-melo-tts-zh_en",
      name: "MeloTTS zh_en",
      archiveUrl:
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2",
      framework: FRAMEWORK_SHERPA,
      category: CATEGORY_TTS,
      memoryRequirementBytes: 170_000_000,
    },
    // VAD 复用英文包的 silero-vad（语言无关），注册逻辑见 ensurePackRegistered
  ],
  models: [
    { id: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue", role: "stt", bcp47: "zh", downloadBytes: 160_000_000 },
    { id: "vits-melo-tts-zh_en", role: "tts", bcp47: "zh-CN", downloadBytes: 170_000_000, outputSampleRate: 44100 },
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

function registrationsForPack(pack: LanguagePackSpec): RunAnywhereModelRegistration[] {
  const vadEntry = pack.register.find((entry) => entry.category === CATEGORY_VAD);
  return vadEntry ? pack.register : [...pack.register, ...ENGLISH_PACK.register.filter((e) => e.category === CATEGORY_VAD)];
}

/** 注册条目（幂等，commons 重注册时合并 runtime 字段）。App 启动后台跑一次。 */
export async function ensurePackRegistered(
  sdk: RunAnywhereMin,
  pack: OnDeviceVoiceLanguagePack,
): Promise<void> {
  await Promise.all(
    registrationsForPack(LANGUAGE_PACKS[pack]).map((entry) =>
      sdk.models.register(entry).catch((error) => {
        // 注册失败不致命：模型管理页会重试；语音启动时再兜底
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

/** 顺序下载 pack 全部模型（设置页模型管理调用，显示进度条）。 */
export async function downloadPack(
  sdk: RunAnywhereMin,
  pack: OnDeviceVoiceLanguagePack,
  onProgress: (progress: ModelDownloadProgress) => void,
): Promise<void> {
  const spec = LANGUAGE_PACKS[pack];
  const all = [...spec.models, ...(spec.models.some((m) => m.role === "vad") ? [] : [VAD_MODEL])];
  for (const model of all) {
    await drainDownload(sdk, model.id, onProgress);
  }
}

export function drainDownload(
  sdk: RunAnywhereMin,
  modelId: string,
  onProgress: (progress: ModelDownloadProgress) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    (async () => {
      const iterator = sdk.models.download(modelId)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done) break;
          const event = step.value as RunAnywhereDownloadEvent;
          if (event.type === "failed") {
            throw event.error ?? new Error(`download failed: ${modelId}`);
          }
          onProgress({
            modelId,
            bytesDone: event.bytesDone ?? 0,
            bytesTotal: event.bytesTotal ?? 0,
            percent: event.percent,
            extracting: event.type === "extracting",
          });
        }
        resolve();
      } catch (error) {
        await iterator.return?.().catch(() => undefined);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

/** pack 是否全部下载完（registryStatus: 2=DOWNLOADED, 3=LOADED，以 proto 为准） */
export async function isPackDownloaded(sdk: RunAnywhereMin, pack: OnDeviceVoiceLanguagePack): Promise<boolean> {
  const spec = LANGUAGE_PACKS[pack];
  const ids = [...spec.models.map((m) => m.id), VAD_MODEL.id];
  const list = await sdk.models.list();
  return ids.every((id) => {
    const found = list.find((model) => model.id === id);
    return Boolean(found && (found.registryStatus === 2 || found.registryStatus === 3));
  });
}

/**
 * 加载 pack 三件套到常驻（category 级 residency；download 缺失时先下载——
 * 正常流设置页已下载，这里是 startVoice 的兜底）。返回本 pack 的模型元数据。
 */
export async function ensurePackLoaded(
  sdk: RunAnywhereMin,
  pack: OnDeviceVoiceLanguagePack,
  onProgress?: (progress: ModelDownloadProgress) => void,
): Promise<Record<"stt" | "tts" | "vad", OnDeviceVoiceModel>> {
  const spec = LANGUAGE_PACKS[pack];
  await ensurePackRegistered(sdk, pack);
  if (!(await isPackDownloaded(sdk, pack))) {
    await downloadPack(sdk, pack, onProgress ?? (() => undefined));
  }
  for (const id of [spec.sttModelId, spec.ttsModelId, VAD_MODEL.id]) {
    await sdk.models.load(id); // 已加载时幂等（category 相同 → no-op）
  }
  const tts = spec.models.find((m) => m.role === "tts")!;
  return {
    stt: spec.models.find((m) => m.role === "stt")!,
    tts,
    vad: VAD_MODEL,
  };
}
```

### 3.3 `voice/ondevice/pcm.ts` — PCM 包装与转换

```typescript
/**
 * PCM 适配层。paseo 采集 = 16k/s16/mono（audio-engine.native 契约）；
 * RunAnywhere STT/VAD 输入 = AudioInputs.pcm16(chunk, 16000)；
 * RunAnywhere TTS 输出 = float32 PCM @ 模型原生率（proto 注释），
 * paseo 播放 = s16 + mime 带 rate（audio-engine.native.play 内部重采样到 16k）。
 */
import { pcm16Input } from "./runanywhere-loader";

/** 把 PCM16 chunk 流包成 RunAnywhere AudioInput 异步流（喂 transcribeStream/detectStream） */
export function pcm16AudioInputs(
  chunks: AsyncIterable<Uint8Array>,
  sampleRate = 16000,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = chunks[Symbol.asyncIterator]();
      return {
        async next() {
          const step = await iterator.next();
          if (step.done) return { value: undefined, done: true } as IteratorResult<unknown>;
          return { value: pcm16Input(step.value, sampleRate), done: false };
        },
        async return() {
          await iterator.return?.();
          return { value: undefined, done: true } as IteratorResult<unknown>;
        },
      };
    },
  };
}

/** float32 (little-endian) → int16，带削波。TTS 输出转 paseo 播放格式。 */
export function float32ToInt16(input: Uint8Array): Uint8Array {
  const sampleCount = Math.floor(input.byteLength / 4);
  const out = new Uint8Array(sampleCount * 2);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  for (let i = 0; i < sampleCount; i++) {
    const value = Math.max(-1, Math.min(1, view.getFloat32(i * 4, true)));
    const int16 = Math.round(value * 32767);
    out[i * 2] = int16 & 0xff;
    out[i * 2 + 1] = (int16 >> 8) & 0xff;
  }
  return out;
}

/** 组装 AudioEngine 播放 source（engine.play 从 mime 解析 rate 并重采样） */
export function ttsChunkPlaybackSource(
  pcm16: Uint8Array,
  sampleRate: number,
): { arrayBuffer(): Promise<ArrayBuffer>; size: number; type: string } {
  const bytes = pcm16.slice();
  return {
    size: bytes.byteLength,
    type: `audio/pcm;rate=${sampleRate};bits=16`,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}
```

### 3.4 `voice/ondevice/sentence-buffer.ts` — 全量快照 → 句子（纯逻辑）

```typescript
/**
 * 句缓冲器：消费 assistant_message 的全量快照流（每条 text 是前一条的
 * 前缀扩展，见 session-stream-reducers.ts:766 的 startsWith 契约），
 * 输出可朗读的完整句。
 *
 * 纯逻辑、无 RN 依赖，配套 sentence-buffer.test.ts。
 */

/** 句末标点：中英文。换行视为硬边界（markdown 列表/段落）。 */
const SENTENCE_TERMINATORS = new Set([
  ".", "!", "?", "。", "！", "？", "；", ";", "…",
]);
/** 软边界：逗号/顿号，仅在句子超长时切分 */
const SOFT_BOUNDARIES = new Set([",", "，", "、", ":", "："]);
const SOFT_FLUSH_MIN_CHARS = 60;
/** 单句上限：超长无标点（如长代码/URL 行）也切，避免 TTS 饥饿 */
const HARD_FLUSH_CHARS = 160;

export interface SentenceBufferDeps {
  /** 产出一个可朗读句（已 sanitize） */
  onSentence(sentence: string): void;
}

export class SentenceBuffer {
  private seenText = "";
  private pending = "";
  private messageId: string | undefined;
  private done = false;

  constructor(private readonly deps: SentenceBufferDeps) {}

  /**
   * 喂入一条 assistant_message 快照。
   * messageId 变化 = 新回复消息开始（前一条若有残余走 flushAll 由调用方决定）。
   * 非 startsWith（快照回退/重写）→ 全量重置。
   */
  push(text: string, messageId?: string): void {
    if (this.done) return;
    if (messageId !== undefined && this.messageId !== undefined && messageId !== this.messageId) {
      this.resetTracking();
    }
    if (messageId !== undefined) this.messageId = messageId;

    let delta: string;
    if (text.startsWith(this.seenText)) {
      delta = text.slice(this.seenText.length);
    } else {
      // 重写快照：丢弃 pending，按新全文重新缓冲
      this.pending = "";
      delta = text;
    }
    this.seenText = text;
    this.pending += delta;
    this.drain(false);
  }

  /** 回复结束（turn_completed/failed/canceled）：残余全部吐出 */
  flushAll(): void {
    if (this.pending.trim().length > 0) {
      this.drain(true);
    }
    this.done = true;
  }

  /** 下一轮回复前重置（新 turn_started 或用户新消息） */
  reset(): void {
    this.resetTracking();
    this.done = false;
  }

  private resetTracking(): void {
    this.seenText = "";
    this.pending = "";
    this.messageId = undefined;
    this.done = false;
  }

  private drain(final: boolean): void {
    for (;;) {
      const cut = this.findCut(this.pending, final);
      if (cut <= 0) return;
      const sentence = this.pending.slice(0, cut).trim();
      this.pending = this.pending.slice(cut);
      if (sentence.length > 0) this.deps.onSentence(sentence);
      if (this.pending.length === 0) return;
    }
  }

  private findCut(text: string, final: boolean): number {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (SENTENCE_TERMINATORS.has(ch)) {
        // 英文句点后跟数字/字母（如 "3.14"、"e.g."）不切——向后看一位
        if (ch === "." && i + 1 < text.length && /[0-9a-zA-Z]/.test(text[i + 1]!)) continue;
        return i + 1;
      }
      if (ch === "\n") return i + 1;
    }
    if (final) return text.length;
    if (text.length >= HARD_FLUSH_CHARS) {
      // 硬切前优先找软边界
      const soft = this.lastSoftBoundaryBefore(text, HARD_FLUSH_CHARS);
      return soft ?? HARD_FLUSH_CHARS;
    }
    if (text.length >= SOFT_FLUSH_MIN_CHARS) {
      const soft = this.lastSoftBoundaryBefore(text, text.length);
      if (soft) return soft;
    }
    return 0;
  }

  private lastSoftBoundaryBefore(text: string, limit: number): number | null {
    for (let i = Math.min(limit, text.length) - 1; i >= SOFT_FLUSH_MIN_CHARS; i--) {
      if (SOFT_BOUNDARIES.has(text[i]!)) return i + 1;
    }
    return null;
  }
}
```

### 3.5 `voice/ondevice/speech-text.ts` — 朗读清洗与风格前缀（纯逻辑）

```typescript
/**
 * 两件事：
 * 1. sanitizeForSpeech：把 assistant 回复里不适合朗读的 markdown 元素清掉
 *    （代码块整段丢弃、行内代码/链接去壳、标题符号剥离）。
 * 2. buildSpokenUserMessage：给 STT 结果加语音风格前缀——模拟 daemon 语音
 *    模式的 wrapSpokenInput（packages/server/src/server/voice-config.ts:57）+
 *    VOICE_AGENT_SYSTEM_INSTRUCTION（同文件 L5-16）的 app 侧等价物。
 *    daemon 不知道这是语音会话（未 setVoiceMode），风格约束只能随消息携带。
 */

export function sanitizeForSpeech(input: string): string {
  let text = input;
  // 围栏代码块整段跳过（朗读代码没意义，读一句“（代码）”提示）
  const fenceCount = (text.match(/```/g) ?? []).length;
  text = text.replace(/```[\s\S]*?(?:```|$)/g, (match) =>
    match.endsWith("```") ? " (code omitted) " : "", // 未闭合的尾部 fence：等下一批 delta
  );
  if (fenceCount % 2 === 1) {
    // 奇数个 fence：本批有未闭合块——把最后一个 fence 之后的内容留给后续快照。
    // 简化处理：交由 SentenceBuffer 的“句子太长硬切”兜底，这里不额外暂存。
  }
  text = text
    .replace(/`([^`]+)`/g, "$1")            // 行内代码去壳
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // 链接 → 文本
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")      // 标题符号
    .replace(/^\s*[-*+]\s+/gm, "")           // 无序列表符号
    .replace(/^\s*\d+\.\s+/gm, "")           // 有序列表符号
    .replace(/(\*\*|__|\*|~~)/g, "")         // 强调/删除线
    .replace(/^\s*>\s?/gm, "");              // 引用符号
  return text.trim();
}

export interface SpokenMessageStyle {
  language: "en" | "zh";
}

const STYLE_INSTRUCTION_EN = [
  "<voice-mode-instruction>",
  "The user is talking to you by voice; your reply will be spoken aloud by on-device TTS.",
  "Keep replies short and conversational.",
  "Do not use markdown, code blocks, tables, or long lists.",
  "If asked to write code or long text, give a brief spoken summary instead and note the full text is in the chat.",
  "</voice-mode-instruction>",
].join("\n");

const STYLE_INSTRUCTION_ZH = [
  "<voice-mode-instruction>",
  "用户正在用语音与你对话，你的回复将由端侧 TTS 朗读。",
  "请保持简短口语化，不要使用 markdown、代码块、表格或长列表。",
  "如需输出代码或长文，请口头概括要点，并说明完整内容在聊天窗口中。",
  "</voice-mode-instruction>",
].join("\n");

/** STT final → 发送文本。镜像 daemon wrapSpokenInput 的结构。 */
export function buildSpokenUserMessage(transcript: string, style: SpokenMessageStyle): string {
  const instruction = style.language === "zh" ? STYLE_INSTRUCTION_ZH : STYLE_INSTRUCTION_EN;
  return [
    `<spoken-input>`,
    transcript.trim(),
    `</spoken-input>`,
    instruction,
  ].join("\n");
}
```

> 设计取舍：风格前缀随**每条**语音消息携带（daemon 的做法是 system prompt 注入 + 每条 wrap，我们只有每条 wrap 这一个注入点）。token 开销 ~80/条，可接受。写死的 XML 标签名刻意避开 daemon 的 `<paseo_voice_mode>`（system prompt 块）与 `<instruction>`（防与 daemon 端侧 strip 逻辑混淆），用 `<voice-mode-instruction>` 独立命名。

### 3.6 `voice/ondevice/ondevice-voice-session.ts` — 端侧语音会话（核心）

```typescript
/**
 * OnDeviceVoiceSession：一次语音模式的完整生命周期。
 *
 * 上行：pushPcm → VAD 流（断句/打断判定）+ STT 流（partial → final）
 *       VAD speechEnded → close STT 输入 → 等 final → buildSpokenUserMessage
 *       → sendMessage（client.sendAgentMessage 管线）
 * 下行：handleAgentStreamEvent（timeline assistant_message 快照）
 *       → SentenceBuffer → tts.synthesizeStream → f32→s16 → engine.play 队列
 *
 * 生命周期由 voice-runtime 驱动：startVoice → start()；stopVoice → stop()。
 * 引擎（采集/播放）仍归 voice-runtime 所有，本类只拿 push/stop 句柄。
 */
import type { AudioEngine } from "@/voice/audio-engine-types";
import { SentenceBuffer } from "./sentence-buffer";
import { buildSpokenUserMessage, sanitizeForSpeech } from "./speech-text";
import { float32ToInt16, pcm16AudioInputs, ttsChunkPlaybackSource } from "./pcm";
import {
  createPushStream,
  ensureRunAnywhereReady,
  type PushableStream,
  type RunAnywhereAudioChunk,
  type RunAnywhereMin,
  type RunAnywhereTranscriptionEvent,
  type RunAnywhereVadEvent,
} from "./runanywhere-loader";
import { ensurePackLoaded, type OnDeviceVoiceLanguagePack, type OnDeviceVoiceModel } from "./ondevice-models";

export type OnDevicePhase =
  | "listening"        // 采集+VAD 待断句
  | "transcribing"     // VAD speechEnded，等 STT final
  | "submitting"       // final 已出，消息发送中
  | "waiting"          // 等 agent 回复（thinking tone 阶段）
  | "speaking";        // TTS 朗读中

export interface OnDeviceSessionEvents {
  onPhase(phase: OnDevicePhase): void;
  /** STT partial，UI 显示实时转写（替换云端模式的 transcription_result 展示） */
  onPartialTranscript(text: string): void;
  /** STT final（已发送），UI 显示/记录 */
  onFinalTranscript(text: string): void;
  onError(error: Error, context: "init" | "stt" | "send" | "tts" | "vad"): void;
  /** TTS 朗读开始/结束（映射到 voice-runtime 的 phase=playing 与 telemetry.isSpeaking） */
  onNarrationStarted(): void;
  onNarrationFinished(): void;
}

export interface OnDeviceSessionDeps {
  engine: AudioEngine;
  /** 发送消息（voice-context 注入：dispatchComposerAgentMessage 包装，见 §5.4） */
  sendMessage(agentId: string, text: string): Promise<void>;
  /** barge-in 时打断 daemon 上运行中的 turn（client.abortRequest 或 client.cancelAgent） */
  abortActiveTurn(agentId: string): Promise<void>;
  languagePack: OnDeviceVoiceLanguagePack;
  /** VAD 断句参数（毫秒）。默认值偏保守，后续按体验调 */
  vadOptions?: { minSpeechMs?: number; minSilenceMs?: number; activationThreshold?: number };
}

interface SttSegment {
  stream: PushableStream;
  task: Promise<void>;
  finalText: string | null;
}

export class OnDeviceVoiceSession {
  private sdk: RunAnywhereMin | null = null;
  private models: Record<"stt" | "tts" | "vad", OnDeviceVoiceModel> | null = null;

  private vadStream: PushableStream | null = null;
  private vadTask: Promise<void> | null = null;
  private sttSegment: SttSegment | null = null;

  private running = false;
  private userSpeaking = false;

  // ---- 下行朗读状态 ----
  private buffer: SentenceBuffer;
  private ttsQueue: string[] = [];
  private ttsActive = false;
  private narrationStarted = false;
  private ttsAbort = false;
  private activeAgentId: string | null = null;

  constructor(
    private readonly deps: OnDeviceSessionDeps,
    private readonly events: OnDeviceSessionEvents,
  ) {
    this.buffer = new SentenceBuffer({
      onSentence: (sentence) => this.enqueueTts(sentence),
    });
  }

  /** voice-runtime.startVoice 调用。throw = 初始化失败（调用方决定回退）。 */
  async start(agentId: string): Promise<void> {
    if (this.running) return;
    this.activeAgentId = agentId;

    // 1. SDK + 模型（失败 throw，由调用方回退云端）
    this.sdk = await ensureRunAnywhereReady();
    this.models = await ensurePackLoaded(this.sdk, this.deps.languagePack);

    // 2. VAD 常驻流（整个语音会话一条）
    this.running = true;
    this.ttsAbort = false;
    this.vadStream = createPushStream();
    this.vadTask = this.consumeVad(
      this.sdk.vad.detectStream(pcm16AudioInputs(this.vadStream.iterable), {
        model: this.models.vad.id,
        minSpeechMs: this.deps.vadOptions?.minSpeechMs ?? 120,
        minSilenceMs: this.deps.vadOptions?.minSilenceMs ?? 480,
        activationThreshold: this.deps.vadOptions?.activationThreshold ?? 0.5,
      }),
    );
    this.events.onPhase("listening");
  }

  /** voice-runtime.handleCapturePcm 调用（mute 已在 audio-engine 层拦截） */
  pushPcm(chunk: Uint8Array): void {
    if (!this.running || chunk.byteLength === 0) return;
    this.vadStream?.push(chunk);
    this.sttSegment?.stream.push(chunk);
  }

  /** voice-runtime.onAgentStreamEvent 转发（timeline/turn 事件） */
  handleTimelineEvent(agentId: string, item: { type: string; text?: string; messageId?: string }): void {
    if (!this.running || agentId !== this.activeAgentId) return;
    if (item.type === "assistant_message" && typeof item.text === "string") {
      if (this.ttsAbort) return; // 打断后本轮不再朗读残余
      this.buffer.push(item.text, item.messageId);
    }
  }

  /** turn 结束：残余句子 flush；failed/canceled 丢弃残余 */
  handleTurnFinished(agentId: string, outcome: "completed" | "failed" | "canceled"): void {
    if (!this.running || agentId !== this.activeAgentId) return;
    if (outcome === "completed") {
      this.buffer.flushAll();
      this.buffer.reset();
    } else {
      this.buffer.reset();
      this.ttsQueue.length = 0; // 失败/取消：未播的直接丢
    }
    void this.settleNarration();
  }

  /** 用户新 turn 开始：清朗读残余（新回复的 assistant_message 会带新 messageId） */
  handleTurnStarted(agentId: string): void {
    if (!this.running || agentId !== this.activeAgentId) return;
    this.buffer.reset();
  }

  /** voice-runtime.stopVoice / 销毁调用 */
  async stop(): Promise<void> {
    this.running = false;
    this.ttsAbort = true;
    this.interruptNarration();
    this.vadStream?.close();
    await this.vadTask?.catch(() => undefined);
    this.closeSttSegment("cancel");
    this.deps.engine.stop();
    this.deps.engine.clearQueue();
    this.events.onPhase("listening"); // runtime 随即置 disabled
  }

  // ================= 私有：上行 =================

  private async consumeVad(events: AsyncIterable<RunAnywhereVadEvent>): Promise<void> {
    const iterator = events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done) break;
        const event = step.value;
        switch (event.type) {
          case "speechStarted":
            this.userSpeaking = true;
            this.onUserSpeechConfirmed();
            break;
          case "speechEnded":
            this.userSpeaking = false;
            await this.finalizeCurrentUtterance();
            break;
          case "failed":
            this.events.onError(event.error ?? new Error("VAD stream failed"), "vad");
            return;
          default:
            break;
        }
      }
    } finally {
      await iterator.return?.().catch(() => undefined);
    }
  }

  /**
   * 用户开口（VAD 确认）：
   * 1) barge-in：正在朗读 → 停播放、清 TTS 队列、丢弃句缓冲残余、
   *    abort daemon 上运行中的 turn。
   * 2) 开新 STT 段（若上一段还开着——极少见，VAD 静音期应已闭合——先关掉）。
   * 回声风险由 expo-two-way-audio 的 AEC + minSpeechMs 双保险兜住。
   */
  private onUserSpeechConfirmed(): void {
    if (this.narrationStarted || this.ttsQueue.length > 0 || this.ttsActive) {
      this.interruptNarration();
      this.ttsAbort = false; // 新 turn 还会来新回复，重开朗读
      this.buffer.reset();
      if (this.activeAgentId) {
        void this.deps.abortActiveTurn(this.activeAgentId).catch(() => undefined);
      }
      this.events.onPhase("listening");
    }
    if (!this.sttSegment) {
      this.openSttSegment();
    }
  }

  private openSttSegment(): void {
    const sdk = this.sdk!;
    const stream = createPushStream();
    const segment: SttSegment = { stream, task: Promise.resolve(), finalText: null };
    this.sttSegment = segment;
    segment.task = (async () => {
      const events = sdk.stt.transcribeStream(
        pcm16AudioInputs(stream.iterable),
        { language: this.models!.stt.bcp47 === "zh" ? "zh" : "en" },
      );
      const iterator = events[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done) break;
          const event = step.value as RunAnywhereTranscriptionEvent;
          if (event.type === "partial") {
            const text = event.alternatives?.[0]?.text?.trim();
            if (text) this.events.onPartialTranscript(text);
          } else if (event.type === "transcriptFinal") {
            segment.finalText = event.segment?.text ?? "";
          } else if (event.type === "failed") {
            this.events.onError(event.error ?? new Error("STT stream failed"), "stt");
          }
        }
      } finally {
        await iterator.return?.().catch(() => undefined);
      }
    })();
  }

  /** VAD speechEnded：闭合 STT 输入 → native drain final → 发消息 */
  private async finalizeCurrentUtterance(): Promise<void> {
    const segment = this.sttSegment;
    if (!segment) return;
    this.sttSegment = null;
    this.events.onPhase("transcribing");
    segment.stream.close(); // 触发 native sttStreamStop → drain final
    await segment.task.catch(() => undefined);

    const transcript = (segment.finalText ?? "").trim();
    if (transcript.length === 0) {
      this.events.onPhase("listening"); // VAD 误报/纯 filler，丢弃
      return;
    }
    this.events.onFinalTranscript(transcript);
    this.events.onPhase("submitting");
    try {
      const message = buildSpokenUserMessage(transcript, {
        language: this.deps.languagePack === "zh" ? "zh" : "en",
      });
      await this.deps.sendMessage(this.activeAgentId!, message);
      this.events.onPhase("waiting");
    } catch (error) {
      this.events.onError(error instanceof Error ? error : new Error(String(error)), "send");
      this.events.onPhase("listening");
    }
  }

  /** 兜底：VAD 没来得及闭合的段（stop 场景）。mode: "cancel" 丢弃、"flush" 等待 */
  private closeSttSegment(mode: "cancel" | "flush"): void {
    const segment = this.sttSegment;
    if (!segment) return;
    this.sttSegment = null;
    segment.stream.close();
    if (mode === "cancel") {
      // task 自行结束即可，final 丢弃
      void segment.task.catch(() => undefined);
    }
  }

  // ================= 私有：下行朗读 =================

  private enqueueTts(rawSentence: string): void {
    const sentence = sanitizeForSpeech(rawSentence);
    if (sentence.length === 0) return;
    this.ttsQueue.push(sentence);
    void this.pumpTts();
  }

  private async pumpTts(): Promise<void> {
    if (this.ttsActive) return;
    this.ttsActive = true;
    try {
      while (this.ttsQueue.length > 0 && !this.ttsAbort && this.running) {
        const sentence = this.ttsQueue.shift()!;
        if (!this.narrationStarted) {
          this.narrationStarted = true;
          this.events.onNarrationStarted();
        }
        await this.speakSentence(sentence);
      }
    } finally {
      this.ttsActive = false;
      void this.settleNarration();
    }
  }

  /** 一句话：synthesizeStream → 逐 chunk 转 s16 → engine.play 顺序播放 */
  private async speakSentence(sentence: string): Promise<void> {
    const sdk = this.sdk!;
    const sampleRate = this.models!.tts.outputSampleRate ?? 22050;
    const iterator = sdk.tts.synthesizeStream(sentence)[Symbol.asyncIterator]();
    try {
      for (;;) {
        if (this.ttsAbort || !this.running) break;
        const step = await iterator.next();
        if (step.done) break;
        const chunk = step.value as RunAnywhereAudioChunk;
        if (chunk.data?.byteLength) {
          const pcm16 = float32ToInt16(chunk.data);
          // engine.play 排队串行播放；ttsAbort 时 stop+clearQueue 会 reject
          // 进行中的 play promise——吞掉即可
          await this.deps.engine.play(ttsChunkPlaybackSource(pcm16, sampleRate)).catch(() => undefined);
        }
      }
    } finally {
      await iterator.return?.().catch(() => undefined); // 中断时调 native ttsStopProto
    }
  }

  private interruptNarration(): void {
    this.ttsAbort = true;
    this.ttsQueue.length = 0;
    this.deps.engine.stop();
    this.deps.engine.clearQueue();
    if (this.narrationStarted) {
      this.narrationStarted = false;
      this.events.onNarrationFinished();
    }
  }

  /** 队列排空且无进行中合成 → 通知朗读结束（runtime 据此切 phase） */
  private async settleNarration(): Promise<void> {
    if (this.ttsActive || this.ttsQueue.length > 0) return;
    if (this.narrationStarted) {
      this.narrationStarted = false;
      this.events.onNarrationFinished();
    }
  }
}
```

> **STT 分段策略说明**：sherpa 的流式识别器自带 endpointing（`STT_STREAM_EVENT_KIND_FINAL`），但不同模型行为不一致（whisper-tiny 流式支持以真机验证为准）。VAD 驱动的「speechEnded → close → drain final → 新开一段」不依赖模型端点行为，语义与 daemon 侧 turn-controller（VAD 定 turn）一致，故为主策略；若真机验证发现 sherpa endpoint 够快，可去掉 VAD 分段、直接一条长 STT 流按 `transcriptFinal` 断段（改动仅限 `onUserSpeechConfirmed`/`finalizeCurrentUtterance` 两个函数）。

---

## 4. `voice-runtime.ts` 改造点（最小 diff）

以下行号基于 `ec43e9067` 的 `packages/app/src/voice/voice-runtime.ts`。核心思路：**不改现有云端路径任何行为**，只在入口处按 `speechEngine` 分叉。

### 4.1 类型与依赖（文件头部）

```diff
--- a/packages/app/src/voice/voice-runtime.ts
+++ L23 后新增 import 与类型：
+import type { OnDeviceVoiceSession } from "@/voice/ondevice/ondevice-voice-session";
+import type { OnDevicePhase } from "@/voice/ondevice/ondevice-voice-session";
+
+export type SpeechEngineChoice = "cloud" | "onDevice";
+
+export interface VoiceRuntimeDeps {
   engine: AudioEngine;
   getServerInfo(serverId: string): DaemonServerInfo | null;
   activateKeepAwake(tag: string): Promise<void>;
   deactivateKeepAwake(tag: string): Promise<void>;
+  /** 端侧语音会话工厂；web/SDK 未安装 → null（端侧入口不可用） */
+  createOnDeviceSession?: (events: OnDeviceSessionEvents) => OnDeviceVoiceSession | null;
+  /** 当前语音引擎偏好（读 settings；runtime 不直接依赖 settings 模块） */
+  getSpeechEngineChoice?: () => SpeechEngineChoice;
 }
```

`RuntimeState` 增加两个字段：

```diff
 interface RuntimeState {
   ...
+  onDeviceSession: OnDeviceVoiceSession | null;   // 当前端侧会话（active 时非空）
+  onDeviceActive: boolean;                        // 分叉开关缓存（startVoice 时定格）
 }
```

### 4.2 `handleCapturePcm`（L647-652）

```diff
     handleCapturePcm(chunk) {
       if (!state.snapshot.isVoiceMode || state.snapshot.isMuted) {
         return;
       }
-      uploader.pushPcmChunk(chunk);
+      if (state.onDeviceActive) {
+        state.onDeviceSession?.pushPcm(chunk);
+      } else {
+        uploader.pushPcmChunk(chunk);
+      }
     },
```

### 4.3 `startVoice`（L719-794）

```diff
     async startVoice(serverId, agentId) {
       ...
       const serverInfo = deps.getServerInfo(serverId);
-      const unavailableMessage = resolveVoiceUnavailableMessage({
-        serverInfo,
-        mode: "voice",
-      });
-      if (unavailableMessage) {
-        throw new Error(unavailableMessage);
-      }
+      const useOnDevice =
+        deps.getSpeechEngineChoice?.() === "onDevice" &&
+        deps.createOnDeviceSession !== undefined;
+      // 端侧模式：daemon 无语音能力要求，跳过 capability 检查
+      if (!useOnDevice) {
+        const unavailableMessage = resolveVoiceUnavailableMessage({
+          serverInfo,
+          mode: "voice",
+        });
+        if (unavailableMessage) {
+          throw new Error(unavailableMessage);
+        }
+      }
       ...
       try {
+        if (useOnDevice) {
+          // 错误回退：初始化失败 → 回退云端路径重跑本函数剩余部分
+          try {
+            const session = deps.createOnDeviceSession!(buildOnDeviceEvents());
+            await session.start(agentId);
+            state.onDeviceSession = session;
+            state.onDeviceActive = true;
+          } catch (error) {
+            console.warn("[VoiceRuntime] On-device voice unavailable, falling back to cloud:", error);
+            state.onDeviceActive = false;
+            state.onDeviceSession = null;
+            // 云端路径继续走（下面不 return）
+          }
+        }
         ...（keep-awake / engine.initialize 原样）
-        await session.adapter.setVoiceMode(true, agentId);
-        enabledCurrentVoiceMode = true;
+        if (!state.onDeviceActive) {
+          await session.adapter.setVoiceMode(true, agentId);
+          enabledCurrentVoiceMode = true;
+        }
         await deps.engine.startCapture();   // 两种模式都要开采集
         ...
```

> `buildOnDeviceEvents()`：runtime 内部工厂函数，把 `OnDeviceSessionEvents` 映射到现有状态机：
> - `onPhase("waiting")` → `patchSnapshot({phase:"waiting"})` + `reconcileCue()`（thinking tone 复用）
> - `onPhase("listening"/"transcribing"/"submitting")` → 对应 phase（"transcribing"/"submitting" 直接映射，phase 枚举已有）
> - `onNarrationStarted()` → **直接调用现有 `api.onAssistantAudioStarted(serverId)`**（L867：stopCue + phase=playing + setAssistantAudioPlaying(true)，全部是客户端行为，安全复用）
> - `onNarrationFinished()` → 现有 `api.onAssistantAudioFinished(serverId)`（L876：按 turnInProgress 决定 waiting/listening——语义完全一致）
> - `onError` → `console.error` + toast（经 deps 注入）+ 端侧致命错误时 `performLocalStop()`
> - `onPartialTranscript/onFinalTranscript` → 仅透传给 UI（`voice-context` 暴露新 hook，见 §5）

### 4.4 `stopVoice`（L796-821）与 `performLocalStop`

```diff
       try {
         stopCue();
         uploader.reset();
+        const onDeviceSession = state.onDeviceSession;
+        state.onDeviceSession = null;
+        state.onDeviceActive = false;
+        await onDeviceSession?.stop();
         state.transportReady = false;
         ...
```

### 4.5 云端专用事件加守卫

`onTranscriptionResult`（L896）、`onServerSpeechStateChanged`（L913）、`handleAudioOutput`（L675）开头统一加：
```diff
+      if (state.onDeviceActive) return; // 端侧模式 daemon 不发这些消息；防御性守卫
```

### 4.6 新增 `onAgentStreamEvent`（VoiceRuntime 接口 + 实现）

```diff
+    onAgentStreamEvent(serverId, agentId, event: AgentStreamEventPayload) {
+      if (!state.onDeviceActive || !state.onDeviceSession) return;
+      if (serverId !== state.snapshot.activeServerId || agentId !== state.snapshot.activeAgentId) return;
+      if (event.type === "timeline" && event.item.type === "assistant_message") {
+        state.onDeviceSession.handleTimelineEvent(agentId, {
+          type: event.item.type,
+          text: event.item.text,
+          messageId: event.item.messageId,
+        });
+        return;
+      }
+      // turn 事件已有 onTurnEvent；这里只补 start 的朗读残余清理
+    },
```

并在现有 `onTurnEvent`（L940）实现里对端侧模式加两行：

```diff
       if (eventType === "turn_started") {
+        state.onDeviceSession?.handleTurnStarted(agentId);
         state.turnInProgress = true;
         ...
       }
       state.turnInProgress = false;
+      state.onDeviceSession?.handleTurnFinished(agentId, eventType === "turn_completed" ? "completed" : eventType === "turn_canceled" ? "canceled" : "failed");
```

---

## 5. 其余挂接点改动

### 5.1 `contexts/session-context.tsx`（2 处小改）

**a) `onStream`（L394-433）**——delta 透传给 runtime（放在现有 `onTurnEvent` 调用旁，L405 后）：

```diff
         voiceRuntime?.onTurnEvent(serverId, agentId, event.type);
+        voiceRuntime?.onAgentStreamEvent?.(serverId, agentId, event);
```

> `onAgentStreamEvent` 在 VoiceRuntime 接口上设为必选方法即可（云端路径内部 no-op）。

**b) adapter 注册（L340-376）**——`abortRequest` 已有；无需改动。端侧 barge-in 用的 abort 走 voice-context 注入的闭包（下条）。

### 5.2 `contexts/voice-context.tsx`

`VoiceProvider`（L120-148）构造 runtime 时注入端侧工厂：

```diff
     runtime = createVoiceRuntime({
       engine,
       getServerInfo: ...,
       activateKeepAwake: ...,
       deactivateKeepAwake: ...,
+      getSpeechEngineChoice: () =>
+        useVoiceSettingsStore.getState().speechEngine,   // 见 §6
+      createOnDeviceSession: isNative
+        ? (events) => {
+            const client = getHostRuntimeClient(serverId); // 简化示意：实际从
+            // host-runtime 取当前 server 的 DaemonClient；Provider 重建时闭包刷新
+            return new OnDeviceVoiceSession(
+              {
+                engine,
+                sendMessage: (agentId, text) =>
+                  client.sendAgentMessage(agentId, text, {
+                    messageId: crypto.randomUUID(),
+                    activeTurnBehavior: "interrupt",
+                  }),
+                abortActiveTurn: (agentId) => client.cancelAgent(agentId),
+                languagePack: useVoiceSettingsStore.getState().languagePack,
+              },
+              events,
+            );
+          }
+        : undefined,
     });
```

> 注：`VoiceProvider` 是全局单例、跨 server 存活，而 `DaemonClient` 是 per-server 的。两个解法（实现时二选一）：
> 1. 工厂签名改成 `createOnDeviceSession(events, serverId)`，client 从 `getHostRuntimeStore()` 按 serverId 现查（推荐，与 `getServerInfo` 的注入方式一致）；
> 2. sendMessage/abort 走 `VoiceSessionAdapter` 新增可选方法（`sendTextMessage(text)`），由 session-context 的 registerSession 提供——协议面更干净但要动 adapter 接口。
> 草稿按 1 的方向，最终以实现评审定。

**乐观 UI**：`sendMessage` 直接用 `client.sendAgentMessage` 时，用户消息不会立即出现在聊天流（composer 路径的乐观插入在 `dispatchComposerAgentMessage`）。若要一致体验，注入的 `sendMessage` 改为调用 `dispatchComposerAgentMessage({client, agentId, text, attachments: [], encodeImages: async () => [], submission: createMessageSubmissionWriter(serverId), ...})`（`composer/actions.ts:201`，全部参数 app 内部可取）。

### 5.3 UI：partial 转写展示

云端模式 app 不显示转写文本（daemon `transcription_result` 只驱动 phase）。端侧模式已有 partial 数据，最小方案：`VoiceRuntimeSnapshot` 增加可选字段 `partialTranscript: string | null`（`onPartialTranscript` 时 patch，final/清段时清空），`RealtimeVoiceOverlay`（`components/realtime-voice-overlay.tsx`）在 meter 上方加一行 `Text` 显示。纯增量，不动现有布局逻辑。

### 5.4 设置存储与设置页

**`hooks/use-settings/storage.ts`**（AppSettings 接口 + DEFAULT_CLIENT_SETTINGS + zod 归一化三处同步加）：

```diff
 export interface AppSettings {
   ...
   pullRequestOpenLocation: PullRequestOpenLocation;
+  /** 语音引擎：cloud = daemon 侧 STT/TTS（现状）；onDevice = 端侧透传 */
+  voiceSpeechEngine: "cloud" | "onDevice";
+  /** 端侧语音语言包（决定注册/加载哪组模型） */
+  voiceLanguagePack: "en" | "zh";
 }

 export const DEFAULT_CLIENT_SETTINGS: AppSettings = {
   ...
+  voiceSpeechEngine: "cloud",
+  voiceLanguagePack: "en",
 };
```

zod schema 同步加 `z.enum(["cloud","onDevice"]).default("cloud")` / `z.enum(["en","zh"]).default("en")`（migrations 机制已有，加默认值即自动迁移旧记录）。

**设置页**（`app/settings/[section].tsx` 路由下新增 `voice` section，native only）：
- 「语音引擎」单选：云端 / 端侧（端侧选项在 `isRunAnywhereAvailable() === false` 时禁用并注明“需要安装语音扩展包构建”）；
- 「语言」：English（简体中文 disabled + “即将支持”）；
- 「模型管理」：显示 pack 内三个模型的下载状态/进度（`isPackDownloaded` + `drainDownload` 进度回调驱动），总大小提示（英文包 ~142MB），删除按钮（`models.delete`）。

### 5.5 设置读取的桥接

voice-runtime 不 import settings 模块（保持 voice 域独立）。新增极薄 store（或直接在 voice-context 里 `useSettings` 读 + ref 同步）：

```typescript
// voice/ondevice/voice-settings-bridge.ts
import { create } from "zustand";
import type { SpeechEngineChoice } from "@/voice/voice-runtime";

interface VoiceSettingsState {
  speechEngine: SpeechEngineChoice;
  languagePack: "en" | "zh";
}
export const useVoiceSettingsStore = create<VoiceSettingsState>(() => ({
  speechEngine: "cloud",
  languagePack: "en",
}));
// App 根组件里 useSettings 双向同步：
// settings.voiceSpeechEngine 变化 → useVoiceSettingsStore.setState
```

---

## 6. Barge-in（打断）完整链路

```
TTS 朗读中 → 用户开口
  → audio-engine AEC 消除回声后 mic 仍有语音（真语音）
  → VAD speechStarted（minSpeechMs=120ms 确认，防咳嗽/呼吸误触发）
  → OnDeviceVoiceSession.onUserSpeechConfirmed():
      interruptNarration(): ttsAbort=true → engine.stop()+clearQueue()
        → 进行中的 engine.play 被 reject（已 .catch 吞掉）
        → 下一个 synthesizeStream 迭代退出 → iterator.return() → native ttsStopProto
      → buffer.reset() + ttsQueue 清空（本轮回复残余不读）
      → abortActiveTurn(agentId) → client.cancelAgent → daemon abort agent turn
      → events.onNarrationFinished() → runtime.onAssistantAudioFinished → phase 回落
  → 开新 STT 段，用户这句成为新 turn
```

与云端模式（daemon `voice_input_state` → `onServerSpeechStateChanged` L913 的 resetPlaybackState 路径）语义对齐：确认说话 = 打断播放 + abort turn。差异点：判断源从 daemon VAD 换成本地 VAD；AEC 保证自声不误触发（`audio-engine.native` 采集带 AEC，背景调研已确认）。**真机必测项**：扬声器外放时 piper 朗读声是否触发 VAD（AEC 对扬声器回声的效果因机型而异）；不行则 fallback 策略：朗读期间把 `activationThreshold` 临时调高 0.5→0.7，或朗读期间忽略 VAD（退化为“朗读完才能插话”，与很多语音助手一致）。

---

## 7. 错误与回退矩阵

| 场景 | 检测点 | 行为 |
|---|---|---|
| SDK 未安装（普通构建） | `isRunAnywhereAvailable()` | 设置页端侧选项禁用；`createOnDeviceSession` 注入 undefined → 永远走云端 |
| web/Electron | 同上（Platform gate） | 同上 |
| `ensureRunAnywhereReady` 失败（native init 崩） | `startVoice` 的 try | toast + **自动回退云端路径**（若云端 capability 也不可用则整体失败，原错误语义） |
| 模型未下载 | `ensurePackLoaded` → `downloadPack` | 兜底下载（有进度 UI 时走设置页预下载；语音中触发则 blocking，UI 显示下载进度）；失败 → 回退云端 |
| STT 流 failed | `events.onError(context:"stt")` | toast；丢弃本段，回 `listening` 继续（会话不中断） |
| `sendMessage` 失败 | context:"send" | toast；回 `listening`（用户重说） |
| TTS 合成 failed/静默零 chunk（模型被换/卸载） | `synthesizeStream` 空转或 SDKException | 该句跳过；连续 3 句失败 → 停朗读，回复仍显示在聊天里（降级为“看得见的回复”），toast 提示 |
| VAD failed | context:"vad" | 会话致命 → `performLocalStop()` + toast（无断句能力无法继续） |
| 中途切回云端 | 用户在设置页改 `voiceSpeechEngine` | 下次 `startVoice` 生效；运行中会话不受影响（stopVoice 后切换） |

回退原则：**端侧是增强，云端是底线**；所有端侧初始化错误静默降级云端并 toast 一次，语音功能永不因 SDK 问题整体不可用。

---

## 8. 依赖与打包

```jsonc
// packages/app/package.json
{
  "dependencies": {
    // optional：npm/pnpm 装不上不阻塞；Metro 静态 require 失败已被 loader catch
    "@runanywhere/core": "0.20.x",
    "@runanywhere/onnx": "0.20.x"
  },
  "peerDependenciesMeta": {
    "@runanywhere/core": { "optional": true },
    "@runanywhere/onnx": { "optional": true }
  }
}
```

- 官方发布渠道待确认（当前 example 用 `workspace:*`，npm registry 是否发布 `@runanywhere/core` 需查；未发布则 git 依赖或 vendor tarball，见 §10）。
- License：RunAnywhere License v1.0，1.f 条 OSI 开源项目免费。**合规动作**：paseo 仓库 NOTICE/关于页保留 RunAnywhere copyright + license 链接；README 注明端侧语音为可选组件。
- attribution UI：设置页「语音（端侧）」section 底部加一行 "Powered by RunAnywhere"。

---

## 9. 模型注册表终稿

英文（先行，URL 来自官方 catalog，可信）：

| 角色 | id | 大小 | 输出率 | URL |
|---|---|---|---|---|
| STT | `sherpa-onnx-whisper-tiny.en` | 75MB | — | `github.com/RunanywhereAI/sherpa-onnx/releases/download/runanywhere-models-v1/sherpa-onnx-whisper-tiny.en.tar.gz` |
| TTS | `vits-piper-en_US-lessac-medium` | 65MB | 22050 | 同 release `vits-piper-en_US-lessac-medium.tar.gz` |
| VAD | `silero-vad` | 2.3MB | — | `github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx` |

中文（预留，代码已写好条目，真机验证后放开）：

| 角色 | id | 大小 | 输出率 | URL（待验证） |
|---|---|---|---|---|
| STT | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue` | ~160MB(int8) | — | `github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2`（中英混合，与 daemon 侧 SenseVoice 同源） |
| TTS | `vits-melo-tts-zh_en` | ~170MB | 44100 | `github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2`（中英双语；备选 kokoro 多语种，sherpa 1.13.2 支持度待查） |
| VAD | 复用 `silero-vad` | — | — | 同英文包 |

中文验证清单：① 上游 tarball 解包布局与 commons 自动推断兼容；② SenseVoice 经 sherpa streaming 接口的行为（SenseVoice 是 offline 模型，RunAnywhere 的 sttStream 对 offline 模型是否退化为“close 后整段转写”——push-to-talk 语义下可接受，延迟 ~1s/句）；③ melo 模型 lexicon/dict 多文件下载完整性。中国网络下 GitHub/HF 直链不稳 → 设置页模型下载支持自定义镜像 URL（`ModelRegistration.url` 直接换 base，预留 `voiceModelMirrorBase` 设置项）。

---

## 10. 实施顺序与门槛

1. **RN 版本门槛（硬阻塞）**：RunAnywhere peer 要求 RN ≥0.83.1 / nitro ^0.33.9；paseo 现状 RN 0.81.5 / Expo 54。路径 a：**升级 Expo 55（RN 0.83）**——主线方案，代价是全量回归；路径 b：忽略 peer warning 强装实测（nitro 0.33 对 0.81 大概率能跑，但**不承诺**，仅作为 spike 验证 API 通路用）。建议：先在独立 branch 走 b 验证链路可行性，同步提 a 的升级 PR。
2. **发布渠道确认**：npm 上是否已有 `@runanywhere/core`/`@runanywhere/onnx` 正式版；没有则与上游确认发布计划或 fork 自建 tarball。
3. **spike（英文链路）**：强装 SDK → loader 跑通 init/register/download/load → `whisper-tiny.en + piper-lessac + silero-vad` 真机跑通「按键→说话→文本→sendMessage→delta→TTS 播放」全链路，重点验证：whisper-tiny 流式 partial 行为、TTS float32/22050 假设、AEC 下 barge-in 误触发率。
4. **正式 PR 拆分**：
   - PR1：sentence-buffer + speech-text + pcm（纯逻辑 + 单测，无 SDK 依赖）
   - PR2：loader + models + settings（可选依赖落地，云端路径零改动）
   - PR3：ondevice-voice-session + voice-runtime/session-context/voice-context 分叉 + overlay partial 展示
   - PR4：中文包启用（模型验证完成后）
5. **反哺上游（Level 2，后续）**：端侧跑稳后，把 `onDeviceSpeech` 协议能力位方案（app 发已转录文本、daemon 跳过语音管线、保留 voice session 语义）整理成 issue 提给 getpaseo/paseo。

## 11. 测试计划（遵循 docs/testing.md：只跑改动文件）

- `sentence-buffer.test.ts`：快照前缀增长/重写回退/messageId 切换/中英标点/软硬切分/flushAll/reset。纯函数，全量可跑。
- `speech-text.test.ts`：markdown 清洗各形态（围栏/行内/链接/列表）、中英前缀生成。
- `pcm.test.ts`：float32→int16 边界值（±1.0、削波、空输入）、mime 组装。
- `ondevice-models.test.ts`：pack 注册/下载/加载编排（mock `RunAnywhereMin`，断言调用序）。
- `voice-runtime.test.ts` 扩展：onDeviceActive 分叉（capture 路由、云端事件守卫、startVoice 回退路径）。现有 17883 字节测试文件模式照抄。
- 真机 QA（docs/qa.md 证据标准）：iOS + Android 各录一段「说话→回复朗读→打断→再说话」屏幕录制；弱网（300ms RTT/丢包）对比演示——端侧模式语音体验与网络无关的卖点验证。
