/**
 * Speech-side text shaping for on-device voice.
 *
 * `sanitizeForSpeech` strips markdown a TTS voice should not read aloud
 * (fenced code blocks become a spoken cue, inline markup loses its shell).
 * `buildSpokenUserMessage` wraps a finalized transcript with the voice-style
 * instruction — the app-side equivalent of the daemon voice session's
 * `wrapSpokenInput` + voice-mode system prompt (server/voice-config.ts),
 * needed because in on-device mode the daemon never enters voice mode and
 * only ever sees this as a plain text message.
 *
 * Pure logic, no React Native dependencies.
 */

const CODE_OMITTED_CUE = "(code omitted)";

export function sanitizeForSpeech(input: string): string {
  return (
    input
      // Fenced blocks (closed, or still-open from a held-back buffer unit) collapse to a cue.
      .replace(/```[\s\S]*?(?:```|$)/g, (match) =>
        match.endsWith("```") ? ` ${CODE_OMITTED_CUE} ` : "",
      )
      .replace(/`([^`\n]+)`/g, "$1") // inline code keeps its content
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image → alt text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link → label
      .replace(/^\s{0,3}#{1,6}\s+/gm, "") // heading markers
      .replace(/^\s*[-*+]\s+/gm, "") // bullet markers
      .replace(/^\s*\d+\.\s+/gm, "") // ordered-list markers
      .replace(/(\*\*|__|\*|~~)/g, "") // emphasis / strikethrough
      .replace(/^\s*>\s?/gm, "") // blockquote markers
      .replace(/\n{2,}/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

export type SpokenInstructionLanguage = "en" | "zh";

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

/**
 * Wrap a final transcript for the ordinary text-message channel. The tag
 * names deliberately differ from the daemon's `<spoken-input>` wrapper and
 * voice-mode prompt block so nothing on the server side strips or double-
 * interprets them.
 */
export function buildSpokenUserMessage(
  transcript: string,
  language: SpokenInstructionLanguage,
): string {
  const instruction = language === "zh" ? STYLE_INSTRUCTION_ZH : STYLE_INSTRUCTION_EN;
  return ["<voice-input>", transcript.trim(), "</voice-input>", instruction].join("\n");
}
