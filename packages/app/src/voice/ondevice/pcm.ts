import { pcm16Input } from "./runanywhere-loader";

/**
 * PCM adapters between the paseo audio pipeline and the RunAnywhere SDK.
 *
 * Capture side: the audio engine emits 16 kHz / 16-bit / mono chunks; the SDK
 * wants them wrapped as `AudioInputs.pcm16` inside an async iterable.
 * Playback side: the SDK's streaming TTS emits float32 PCM at the voice's
 * native sample rate; the audio engine plays 16-bit PCM and resamples itself
 * from the rate embedded in the source mime type.
 */

/** Wrap a PCM16 mono chunk stream into the SDK's audio-input stream. */
export function pcm16AudioInputs(
  chunks: AsyncIterable<Uint8Array>,
  sampleRate = 16000,
): AsyncIterable<ReturnType<typeof pcm16Input>> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = chunks[Symbol.asyncIterator]();
      return {
        async next() {
          const step = await iterator.next();
          if (step.done) {
            return { value: undefined, done: true } as IteratorResult<
              ReturnType<typeof pcm16Input>
            >;
          }
          return { value: pcm16Input(step.value, sampleRate), done: false };
        },
        async return() {
          await iterator.return?.();
          return { value: undefined, done: true } as IteratorResult<ReturnType<typeof pcm16Input>>;
        },
      };
    },
  };
}

/** Convert little-endian float32 samples to clamped int16 (TTS output → playback). */
export function float32ToInt16(input: Uint8Array): Uint8Array {
  const sampleCount = Math.floor(input.byteLength / 4);
  const output = new Uint8Array(sampleCount * 2);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.max(-1, Math.min(1, view.getFloat32(i * 4, true)));
    const int16 = Math.round(sample * 32767);
    output[i * 2] = int16 & 0xff;
    output[i * 2 + 1] = (int16 >> 8) & 0xff;
  }
  return output;
}

/** Build one streaming-TTS-chunk playback source for the audio engine queue. */
export function pcm16PlaybackSource(
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
