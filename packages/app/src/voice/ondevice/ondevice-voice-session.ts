import type { AudioEngine } from "@/voice/audio-engine-types";
import type { PushableAudioStream, TranscriptionEvent, VadEvent } from "@runanywhere/core";
import {
  ensurePackLoaded,
  packSttLanguage,
  type OnDeviceVoiceLanguagePack,
  type OnDeviceVoiceModel,
} from "./ondevice-models";
import {
  createPushStream,
  ensureRunAnywhereReady,
  type RunAnywhereFacade,
} from "./runanywhere-loader";
import { float32ToInt16, pcm16AudioInputs, pcm16PlaybackSource } from "./pcm";
import { SentenceBuffer } from "./sentence-buffer";
import { buildSpokenUserMessage, sanitizeForSpeech } from "./speech-text";

/**
 * One on-device voice session: mic PCM in, agent text out, TTS audio out.
 *
 * Uplink: captured PCM feeds a resident Silero VAD stream; VAD segments the
 * utterances (speechEnded closes the STT input, which drains the final
 * transcript natively), and the finalized text goes out through the ordinary
 * text-message channel with the spoken-style wrapper. The daemon never sees
 * audio or enters voice mode.
 * Downlink: assistant-message snapshots from the agent stream flow through a
 * sentence buffer; each sentence is synthesized by on-device TTS and played
 * through the shared audio engine queue. Confirmed user speech interrupts
 * playback and aborts the running agent turn (barge-in), mirroring the cloud
 * voice session's semantics with local detection.
 *
 * The audio engine stays owned by the voice runtime; this class only pushes
 * PCM in and enqueues playback out.
 */

/** Coarse session phase, mapped by the voice runtime onto its own phases. */
export type OnDevicePhase = "listening" | "transcribing" | "submitting" | "waiting" | "speaking";

export type OnDeviceErrorContext = "init" | "stt" | "send" | "tts" | "vad";

export interface OnDeviceSessionEvents {
  onPhase(phase: OnDevicePhase): void;
  /** Interim STT text for display (on-device replacement for transcription_result). */
  onPartialTranscript(text: string): void;
  /** Finalized transcript that was sent as a message. */
  onFinalTranscript(text: string): void;
  onError(error: Error, context: OnDeviceErrorContext): void;
  onNarrationStarted(): void;
  onNarrationFinished(): void;
}

export interface OnDeviceSessionDeps {
  engine: AudioEngine;
  /** Send one message through the ordinary channel (composer dispatch pipeline). */
  sendMessage(agentId: string, text: string): Promise<void>;
  /** Abort the agent's running turn (barge-in). */
  abortActiveTurn(agentId: string): Promise<void>;
  languagePack: OnDeviceVoiceLanguagePack;
  /** VAD segmentation knobs; defaults favor fast turns over long utterances. */
  vadOptions?: {
    minSpeechMs?: number;
    minSilenceMs?: number;
    activationThreshold?: number;
  };
}

/** Give up narrating a reply after this many consecutive dead TTS streams. */
const TTS_SILENT_FAILURE_LIMIT = 3;

interface SttSegment {
  stream: PushableAudioStream;
  task: Promise<void>;
  finalText: string | null;
}

export class OnDeviceVoiceSession {
  private facade: RunAnywhereFacade | null = null;
  private models: {
    stt: OnDeviceVoiceModel;
    tts: OnDeviceVoiceModel;
    vad: OnDeviceVoiceModel;
  } | null = null;

  private vadStream: PushableAudioStream | null = null;
  private vadTask: Promise<void> | null = null;
  private sttSegment: SttSegment | null = null;

  private running = false;
  private activeAgentId: string | null = null;
  private turnActive = false;

  private readonly buffer: SentenceBuffer;
  private ttsQueue: string[] = [];
  private ttsActive = false;
  private narrationStarted = false;
  private narrationAborted = false;
  private consecutiveSilentTts = 0;

  constructor(
    private readonly deps: OnDeviceSessionDeps,
    private readonly events: OnDeviceSessionEvents,
  ) {
    this.buffer = new SentenceBuffer({ onSentence: (sentence) => this.enqueueTts(sentence) });
  }

  /** Bring up the SDK, models, and the resident VAD stream. Throws on init failure. */
  async start(agentId: string): Promise<void> {
    if (this.running) return;
    this.activeAgentId = agentId;

    this.facade = await ensureRunAnywhereReady();
    this.models = await ensurePackLoaded(this.deps.languagePack, undefined, this.facade);

    this.running = true;
    this.narrationAborted = false;
    this.vadStream = createPushStream();
    this.vadTask = this.consumeVad(
      this.facade.vad.detectStream(pcm16AudioInputs(this.vadStream.iterable), {
        model: this.models.vad.id,
        minSpeechMs: this.deps.vadOptions?.minSpeechMs ?? 120,
        minSilenceMs: this.deps.vadOptions?.minSilenceMs ?? 480,
        activationThreshold: this.deps.vadOptions?.activationThreshold ?? 0.5,
      }),
    );
    this.events.onPhase("listening");
  }

  /** Captured mic PCM (mute is already filtered by the audio engine). */
  pushPcm(chunk: Uint8Array): void {
    if (!this.running || chunk.byteLength === 0) return;
    this.vadStream?.push(chunk);
    this.sttSegment?.stream.push(chunk);
  }

  /** Assistant timeline snapshots from the agent stream (text is a full snapshot). */
  handleTimelineEvent(
    agentId: string,
    item: { type: string; text?: string; messageId?: string },
  ): void {
    if (!this.running || agentId !== this.activeAgentId) return;
    if (item.type !== "assistant_message" || typeof item.text !== "string") return;
    if (this.narrationAborted) return;
    this.buffer.push(item.text, item.messageId);
  }

  handleTurnStarted(agentId: string): void {
    if (!this.running || agentId !== this.activeAgentId) return;
    this.turnActive = true;
    this.buffer.reset();
    this.ttsQueue.length = 0; // a new turn's narration replaces any stale queue
    this.narrationAborted = false;
  }

  handleTurnFinished(agentId: string, outcome: "completed" | "failed" | "canceled"): void {
    if (!this.running || agentId !== this.activeAgentId) return;
    this.turnActive = false;
    if (outcome === "completed") {
      this.buffer.flushAll();
    } else {
      this.buffer.discard();
      this.ttsQueue.length = 0;
    }
    this.settleNarration();
  }

  /** Tear the session down; the voice runtime releases the audio engine after. */
  async stop(): Promise<void> {
    this.running = false;
    this.interruptNarration();
    this.vadStream?.close();
    await this.vadTask?.catch(() => undefined);
    this.vadStream = null;
    this.vadTask = null;
    if (this.sttSegment) {
      const segment = this.sttSegment;
      this.sttSegment = null;
      segment.stream.close();
      void segment.task.catch(() => undefined);
    }
  }

  private async consumeVad(events: AsyncIterable<VadEvent>): Promise<void> {
    const iterator = events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done || !this.running) break;
        const event = step.value;
        if (event.type === "speechStarted") {
          this.onUserSpeechConfirmed();
        } else if (event.type === "speechEnded") {
          void this.finalizeCurrentUtterance();
        } else if (event.type === "failed") {
          this.events.onError(event.error ?? new Error("VAD stream failed"), "vad");
          return;
        }
      }
    } finally {
      await iterator.return?.().catch(() => undefined);
    }
  }

  /**
   * Confirmed user speech: interrupt narration and abort the running turn
   * (barge-in), then make sure an STT segment is recording this utterance.
   * Echo from our own playback is suppressed by the capture pipeline's AEC
   * plus the VAD minSpeechMs confirmation.
   */
  private onUserSpeechConfirmed(): void {
    if (this.narrationStarted || this.ttsQueue.length > 0 || this.ttsActive) {
      this.interruptNarration();
      this.buffer.discard();
    }
    if (this.turnActive && this.activeAgentId) {
      void this.deps.abortActiveTurn(this.activeAgentId).catch(() => undefined);
    }
    if (!this.sttSegment) {
      this.openSttSegment();
    }
  }

  private openSttSegment(): void {
    const facade = this.facade;
    const models = this.models;
    if (!facade || !models) return;
    const stream = createPushStream();
    const segment: SttSegment = { stream, task: Promise.resolve(), finalText: null };
    this.sttSegment = segment;
    segment.task = (async () => {
      const transcription = facade.stt.transcribeStream(pcm16AudioInputs(stream.iterable), {
        language: packSttLanguage(this.deps.languagePack),
      });
      const iterator = transcription[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done) break;
          const event: TranscriptionEvent = step.value;
          if (event.type === "partial") {
            const text = event.alternatives[0]?.text?.trim();
            if (text) this.events.onPartialTranscript(text);
          } else if (event.type === "transcriptFinal") {
            segment.finalText = event.segment.text;
          } else if (event.type === "failed") {
            this.events.onError(event.error ?? new Error("STT stream failed"), "stt");
          }
        }
      } finally {
        await iterator.return?.().catch(() => undefined);
      }
    })();
  }

  /** VAD silence: close the STT input (native stop drains the final) and send. */
  private async finalizeCurrentUtterance(): Promise<void> {
    const segment = this.sttSegment;
    if (!segment) return;
    this.sttSegment = null;
    this.events.onPhase("transcribing");
    segment.stream.close();
    await segment.task.catch(() => undefined);

    const transcript = (segment.finalText ?? "").trim();
    if (transcript.length === 0) {
      this.events.onPhase("listening"); // VAD false positive or filler-only
      return;
    }

    this.events.onFinalTranscript(transcript);
    this.events.onPhase("submitting");
    try {
      const message = buildSpokenUserMessage(
        transcript,
        this.deps.languagePack === "zh" ? "zh" : "en",
      );
      await this.deps.sendMessage(this.activeAgentId!, message);
      this.narrationAborted = false; // a new reply is coming; narration may resume
      this.events.onPhase("waiting");
    } catch (error) {
      this.events.onError(error instanceof Error ? error : new Error(String(error)), "send");
      this.events.onPhase("listening");
    }
  }

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
      while (this.ttsQueue.length > 0 && !this.narrationAborted && this.running) {
        const sentence = this.ttsQueue.shift()!;
        if (!this.narrationStarted) {
          this.narrationStarted = true;
          this.events.onNarrationStarted();
        }
        await this.speakSentence(sentence);
      }
    } finally {
      this.ttsActive = false;
      this.settleNarration();
    }
  }

  /**
   * One sentence: stream synthesized float32 chunks, convert to PCM16, and
   * enqueue each on the audio engine. Interruptions reject the in-flight
   * play promise; that rejection is expected and swallowed.
   */
  private async speakSentence(sentence: string): Promise<void> {
    const facade = this.facade;
    const models = this.models;
    if (!facade || !models) return;
    const sampleRate = models.tts.outputSampleRate ?? 22050;
    const iterator = facade.tts.synthesizeStream(sentence)[Symbol.asyncIterator]();
    let receivedChunks = 0;
    try {
      for (;;) {
        if (this.narrationAborted || !this.running) break;
        const step = await iterator.next();
        if (step.done) break;
        const chunk = step.value;
        if (chunk.data.byteLength > 0) {
          receivedChunks += 1;
          await this.deps.engine
            .play(pcm16PlaybackSource(float32ToInt16(chunk.data), sampleRate))
            .catch(() => undefined);
        }
      }
    } finally {
      await iterator.return?.().catch(() => undefined);
    }
    if (receivedChunks === 0) {
      // A zero-chunk stream is the SDK's silent-finish signal (voice not
      // loaded). Report once past the limit instead of muting the reply.
      this.consecutiveSilentTts += 1;
      if (this.consecutiveSilentTts >= TTS_SILENT_FAILURE_LIMIT) {
        this.events.onError(
          new Error("On-device TTS produced no audio (voice model not loaded?)"),
          "tts",
        );
        this.consecutiveSilentTts = 0;
      }
    } else {
      this.consecutiveSilentTts = 0;
    }
  }

  private interruptNarration(): void {
    this.narrationAborted = true;
    this.ttsQueue.length = 0;
    this.deps.engine.stop();
    this.deps.engine.clearQueue();
    if (this.narrationStarted) {
      this.narrationStarted = false;
      this.events.onNarrationFinished();
    }
  }

  private settleNarration(): void {
    if (this.ttsActive || this.ttsQueue.length > 0) return;
    if (this.narrationStarted) {
      this.narrationStarted = false;
      this.events.onNarrationFinished();
    }
  }
}
