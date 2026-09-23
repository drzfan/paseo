import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { isNative } from "@/constants/platform";
import { useSettings } from "@/hooks/use-settings";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { OnDeviceVoiceSession } from "@/voice/ondevice/ondevice-voice-session";
import { createAudioEngine } from "@/voice/audio-engine";
import type { AudioEngine } from "@/voice/audio-engine-types";
import {
  createVoiceRuntime,
  type SpeechEngineChoice,
  type VoiceRuntime,
  type VoiceRuntimeSnapshot,
  type VoiceRuntimeTelemetrySnapshot,
} from "@/voice/voice-runtime";

interface VoiceContextValue extends VoiceRuntimeSnapshot {
  startVoice: (serverId: string, agentId: string) => Promise<void>;
  stopVoice: () => Promise<void>;
  isVoiceModeForAgent: (serverId: string, agentId: string) => boolean;
  toggleMute: () => void;
}

const EMPTY_SNAPSHOT: VoiceRuntimeSnapshot = {
  phase: "disabled",
  isVoiceMode: false,
  isVoiceSwitching: false,
  isMuted: false,
  activeServerId: null,
  activeAgentId: null,
  partialTranscript: null,
};

const EMPTY_TELEMETRY: VoiceRuntimeTelemetrySnapshot = {
  volume: 0,
  isSpeaking: false,
  segmentDuration: 0,
};

const VoiceRuntimeContext = createContext<VoiceRuntime | null>(null);
const VoiceAudioEngineContext = createContext<AudioEngine | null>(null);

const noopSubscribe = () => () => {};
const getEmptySnapshot = () => EMPTY_SNAPSHOT;
const getEmptyTelemetry = () => EMPTY_TELEMETRY;

export function useVoice() {
  const value = useVoiceOptional();
  if (!value) {
    throw new Error("useVoice must be used within VoiceProvider");
  }
  return value;
}

export function useVoiceOptional(): VoiceContextValue | null {
  const runtime = useContext(VoiceRuntimeContext);
  const snapshot = useSyncExternalStore(
    runtime ? runtime.subscribe : noopSubscribe,
    runtime ? runtime.getSnapshot : getEmptySnapshot,
    runtime ? runtime.getSnapshot : getEmptySnapshot,
  );

  // Methods on the runtime object literal close over factory-local state; they
  // don't use `this`, so no binding is needed. Memoising on [snapshot, runtime]
  // keeps the returned object reference stable across re-renders that don't
  // change either, preventing downstream memo/useMemo misses.
  return useMemo(() => {
    if (!runtime) {
      return null;
    }
    return {
      ...snapshot,
      startVoice: runtime.startVoice,
      stopVoice: runtime.stopVoice,
      isVoiceModeForAgent: runtime.isVoiceModeForAgent,
      toggleMute: runtime.toggleMute,
    };
  }, [snapshot, runtime]);
}

export function useVoiceTelemetry() {
  const telemetry = useVoiceTelemetryOptional();
  if (!telemetry) {
    throw new Error("useVoiceTelemetry must be used within VoiceProvider");
  }
  return telemetry;
}

export function useVoiceTelemetryOptional(): VoiceRuntimeTelemetrySnapshot | null {
  const runtime = useContext(VoiceRuntimeContext);
  const snapshot = useSyncExternalStore(
    runtime ? runtime.subscribeTelemetry.bind(runtime) : noopSubscribe,
    runtime ? runtime.getTelemetrySnapshot.bind(runtime) : getEmptyTelemetry,
    runtime ? runtime.getTelemetrySnapshot.bind(runtime) : getEmptyTelemetry,
  );

  return runtime ? snapshot : null;
}

export function useVoiceRuntimeOptional(): VoiceRuntime | null {
  return useContext(VoiceRuntimeContext);
}

export function useVoiceAudioEngineOptional(): AudioEngine | null {
  return useContext(VoiceAudioEngineContext);
}

interface VoiceProviderProps {
  children: ReactNode;
}

/**
 * Send a finalized on-device transcript through the ordinary message channel,
 * riding the composer dispatch pipeline so the user message lands in the chat
 * timeline optimistically exactly like a typed send.
 */
function sendOnDeviceVoiceMessage(serverId: string, agentId: string, text: string): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    return Promise.reject(new Error("Host is not connected"));
  }
  return dispatchComposerAgentMessage({
    client,
    agentId,
    text,
    attachments: [],
    encodeImages: async () => undefined,
    submission: createMessageSubmissionWriter(serverId),
    // A spoken follow-up always supersedes the running turn (barge-in).
    activeTurnBehavior: "interrupt",
  });
}

function abortOnDeviceVoiceTurn(serverId: string, agentId: string): Promise<void> {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    return Promise.resolve();
  }
  return client.cancelAgent(agentId).catch(() => undefined);
}

export function VoiceProvider({ children }: VoiceProviderProps) {
  const engineRef = useRef<AudioEngine | null>(null);
  const runtimeRef = useRef<VoiceRuntime | null>(null);

  // Latest speech-engine preference for the runtime's non-React callbacks.
  const speechEngine = useSettings((current) => current.voiceSpeechEngine);
  const languagePack = useSettings((current) => current.voiceLanguagePack);
  const settingsRef = useRef({ speechEngine, languagePack });
  settingsRef.current = { speechEngine, languagePack };

  if (!engineRef.current) {
    let runtime: VoiceRuntime | null = null;
    const engine = createAudioEngine({
      onCaptureData: (pcm) => {
        runtime?.handleCapturePcm(pcm);
      },
      onVolumeLevel: (level) => {
        runtime?.handleCaptureVolume(level);
      },
      onInterruption: () => {
        void runtime?.stopVoice().catch((error) => {
          console.error("[VoiceEngine] Failed to stop after audio interruption:", error);
        });
      },
      onError: (error) => {
        console.error("[VoiceEngine] Capture error:", error);
      },
    });

    const readSpeechEngineChoice = (): SpeechEngineChoice =>
      settingsRef.current.speechEngine ?? "cloud";

    runtime = createVoiceRuntime({
      engine,
      getServerInfo: (serverId) =>
        useSessionStore.getState().getSession(serverId)?.serverInfo ?? null,
      activateKeepAwake: async (tag) => {
        await activateKeepAwakeAsync(tag);
      },
      deactivateKeepAwake: async (tag) => {
        await deactivateKeepAwake(tag);
      },
      getSpeechEngineChoice: readSpeechEngineChoice,
      onNotice: (kind) => {
        if (kind === "onDeviceFallback") {
          console.warn("[VoiceProvider] On-device speech unavailable; using cloud voice mode");
        }
      },
      // On-device sessions only exist on native builds; web keeps cloud voice.
      createOnDeviceSession: isNative
        ? (events, serverId) =>
            new OnDeviceVoiceSession(
              {
                engine,
                sendMessage: (agentId, text) => sendOnDeviceVoiceMessage(serverId, agentId, text),
                abortActiveTurn: (agentId) => abortOnDeviceVoiceTurn(serverId, agentId),
                languagePack: settingsRef.current.languagePack ?? "en",
              },
              events,
            )
        : undefined,
    });

    engineRef.current = engine;
    runtimeRef.current = runtime;
  }

  const engine = engineRef.current;
  const runtime = runtimeRef.current!;

  useEffect(() => {
    return () => {
      void runtime.destroy().catch((error) => {
        console.error("[VoiceProvider] Failed to destroy voice runtime", error);
      });
    };
  }, [runtime]);

  return (
    <VoiceAudioEngineContext.Provider value={engine}>
      <VoiceRuntimeContext.Provider value={runtime}>{children}</VoiceRuntimeContext.Provider>
    </VoiceAudioEngineContext.Provider>
  );
}
