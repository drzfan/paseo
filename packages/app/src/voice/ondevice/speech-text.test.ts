import { describe, expect, it } from "vitest";
import { buildSpokenUserMessage, sanitizeForSpeech } from "./speech-text";

describe("sanitizeForSpeech", () => {
  it("collapses closed fenced code blocks to a spoken cue", () => {
    expect(sanitizeForSpeech("before ```js\nconst x = 1;\n``` after")).toBe(
      "before (code omitted) after",
    );
  });

  it("drops an unclosed fenced block entirely", () => {
    expect(sanitizeForSpeech("answer ```js\nconst x = 1;")).toBe("answer");
  });

  it("keeps inline code content without the backticks", () => {
    expect(sanitizeForSpeech("run `npm install` now")).toBe("run npm install now");
  });

  it("unwraps links and images to their labels", () => {
    expect(sanitizeForSpeech("see [the docs](https://example.com)")).toBe("see the docs");
    expect(sanitizeForSpeech("![a chart](https://example.com/x.png)")).toBe("a chart");
  });

  it("strips markdown emphasis, headings, list and quote markers", () => {
    expect(sanitizeForSpeech("**bold** and *italic* and ~~gone~~")).toBe(
      "bold and italic and gone",
    );
    expect(sanitizeForSpeech("## Heading")).toBe("Heading");
    expect(sanitizeForSpeech("- item one\n- item two")).toBe("item one\nitem two");
    expect(sanitizeForSpeech("1. first\n2. second")).toBe("first\nsecond");
    expect(sanitizeForSpeech("> quoted line")).toBe("quoted line");
  });

  it("collapses blank-line runs into single newlines and trims", () => {
    expect(sanitizeForSpeech("a\n\n\nb")).toBe("a\nb");
  });
});

describe("buildSpokenUserMessage", () => {
  it("wraps the transcript with a voice-input tag and the English instruction", () => {
    const message = buildSpokenUserMessage("  What is the weather?  ", "en");
    expect(message).toContain("<voice-input>\nWhat is the weather?\n</voice-input>");
    expect(message).toContain("<voice-mode-instruction>");
    expect(message).toContain("spoken aloud by on-device TTS");
  });

  it("uses the Chinese instruction for the zh language", () => {
    const message = buildSpokenUserMessage("今天天气怎么样", "zh");
    expect(message).toContain("<voice-input>\n今天天气怎么样\n</voice-input>");
    expect(message).toContain("端侧 TTS 朗读");
  });
});
