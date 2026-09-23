/**
 * Sentence buffer: turns the daemon's assistant-message snapshots into
 * speakable sentences for on-device TTS.
 *
 * The daemon replays the growing assistant message as full-text snapshots on
 * every `agent_stream` timeline event (the timeline reducer merges them by
 * `startsWith` — see timeline/session-stream-reducers.ts). This buffer keeps
 * the last seen text per message, extracts the appended delta, and emits a
 * sentence whenever a terminator (or newline) lands inside a speakable
 * region. Markdown fenced code blocks are never scanned for boundaries: a
 * closed block flows out as one unit (the speech sanitizer reduces it to a
 * spoken cue) and an open block holds back everything after it until the
 * closing fence arrives, so code is never narrated piecemeal.
 *
 * Pure logic, no React Native dependencies.
 */

/** Sentence terminators, Chinese and Latin. */
const SENTENCE_TERMINATORS = new Set([".", "!", "?", "。", "！", "？", "；", ";", "…"]);
/** Soft boundaries only cut when the trailing speakable text has grown past a minimum. */
const SOFT_BOUNDARIES = new Set([",", "，", "、", ":", "："]);
const SOFT_FLUSH_MIN_CHARS = 60;
/** Ceiling for punctuation-free runs (long code/URL lines) so TTS never starves. */
const HARD_FLUSH_CHARS = 160;

const FENCE_MARKER = "```";

export interface SentenceBufferDeps {
  /** One speakable sentence, already trimmed and non-empty. */
  onSentence(sentence: string): void;
}

export class SentenceBuffer {
  private seenText = "";
  private pending = "";
  private messageId: string | undefined;
  private done = false;

  constructor(private readonly deps: SentenceBufferDeps) {}

  /**
   * Feed one assistant-message snapshot. A changed `messageId` starts a new
   * message; a snapshot that no longer starts with the seen text (rewrite or
   * rewind) resets tracking and re-buffers from the new full text.
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
      this.pending = "";
      delta = text;
    }
    this.seenText = text;
    this.pending += delta;
    this.drain(false);
  }

  /** The reply finished: flush any remaining pending text as a final sentence. */
  flushAll(): void {
    if (this.pending.trim().length > 0) {
      this.drain(true);
    }
    this.done = true;
  }

  /** Start the next reply from scratch (turn_started or a new user message). */
  reset(): void {
    this.resetTracking();
  }

  /** Drop any buffered text without emitting (turn failed/canceled). */
  discard(): void {
    this.resetTracking();
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

  /**
   * Index one past the next emit boundary in `text`, or 0 when nothing may be
   * emitted yet. `text.split("```")` alternates outside (even indices) and
   * inside-fence (odd indices) segments; an even split length means the last
   * segment sits inside a still-open fence and is held back.
   */
  private findCut(text: string, final: boolean): number {
    const parts = text.split(FENCE_MARKER);

    // Absolute start offset of each split part (each part is followed by one
    // fence marker, except the last).
    const partBases: number[] = [];
    let offset = 0;
    for (const part of parts) {
      partBases.push(offset);
      offset += part.length + FENCE_MARKER.length;
    }

    let lastOutsideBase = 0;
    let lastOutside = "";
    let anyOutsideContent = false;

    for (let partIndex = 0; partIndex < parts.length; partIndex += 2) {
      const part = parts[partIndex]!;
      if (part.trim().length > 0) anyOutsideContent = true;
      lastOutsideBase = partBases[partIndex]!;
      lastOutside = part;

      for (let i = 0; i < part.length; i++) {
        const char = part[i]!;
        if (SENTENCE_TERMINATORS.has(char)) {
          // A period inside a number or abbreviation ("3.14", "e.g.") is not
          // a boundary: skip when the next char continues a word.
          if (char === "." && i + 1 < part.length && /[0-9a-zA-Z]/.test(part[i + 1]!)) continue;
          return lastOutsideBase + i + 1;
        }
        if (char === "\n") return lastOutsideBase + i + 1;
      }
    }

    const tailEnd = lastOutsideBase + lastOutside.length;
    if (final) {
      // Emit every outside region up to the last one; closed code blocks ride
      // along and the speech sanitizer reduces them to a spoken cue.
      return anyOutsideContent ? tailEnd : 0;
    }
    if (lastOutside.length >= HARD_FLUSH_CHARS) {
      const soft = this.lastSoftBoundaryBefore(lastOutside, HARD_FLUSH_CHARS);
      return soft !== null ? lastOutsideBase + soft : lastOutsideBase + HARD_FLUSH_CHARS;
    }
    if (lastOutside.length >= SOFT_FLUSH_MIN_CHARS) {
      const soft = this.lastSoftBoundaryBefore(lastOutside, lastOutside.length);
      return soft !== null ? lastOutsideBase + soft : 0;
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
