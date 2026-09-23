import { describe, expect, it, vi } from "vitest";
import { SentenceBuffer } from "./sentence-buffer";

function collect(): { sentences: string[]; deps: { onSentence(text: string): void } } {
  const sentences: string[] = [];
  return {
    sentences,
    deps: {
      onSentence: (text) => {
        sentences.push(text);
      },
    },
  };
}

describe("SentenceBuffer", () => {
  it("emits a sentence once a terminator lands, across snapshots", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("Hello the", "m1");
    expect(sentences).toEqual([]);
    buffer.push("Hello there.", "m1");
    expect(sentences).toEqual(["Hello there."]);
  });

  it("holds punctuation-free text until a boundary or flush", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("still thinking", "m1");
    buffer.push("still thinking out loud", "m1");
    expect(sentences).toEqual([]);
    buffer.flushAll();
    expect(sentences).toEqual(["still thinking out loud"]);
  });

  it("treats newlines as boundaries (markdown lines)", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("first line\nsecond line\n", "m1");
    expect(sentences).toEqual(["first line", "second line"]);
  });

  it("recognizes Chinese terminators", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("今天天气怎么样？", "m1");
    buffer.push("今天天气怎么样？看起来不错。", "m1");
    expect(sentences).toEqual(["今天天气怎么样？", "看起来不错。"]);
  });

  it("does not cut inside decimals or abbreviations", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("Pi is 3.14159 and rising.", "m1");
    expect(sentences).toEqual(["Pi is 3.14159 and rising."]);
  });

  it("starts over when the messageId changes", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("first message partial", "m1");
    buffer.push("Second message done.", "m2");
    expect(sentences).toEqual(["Second message done."]);
  });

  it("re-buffers from scratch when a snapshot stops extending the seen text", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("This will be rewritten", "m1");
    buffer.push("Rewritten answer.", "m1");
    expect(sentences).toEqual(["Rewritten answer."]);
  });

  it("emits closed fenced code blocks as one unit instead of narrating them line by line", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("Here is code:\n```js\nconst x = 1;\n```\nAfter that.", "m1");
    expect(sentences).toEqual(["Here is code:", "```js\nconst x = 1;\n```", "After that."]);
  });

  it("holds text behind an open fenced block until the block closes", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("before ```js\nconst x = 1;\nstill open", "m1");
    expect(sentences).toEqual([]);
    buffer.push("before ```js\nconst x = 1;\nstill open\n``` and done.", "m1");
    // The block closes mid-line, so the following sentence rides along in one
    // unit; the speech sanitizer reduces the fenced part to a spoken cue.
    expect(sentences).toEqual(["before ```js\nconst x = 1;\nstill open\n``` and done."]);
  });

  it("flushAll drops unclosed fenced content but keeps preceding speakable text", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("answer ```js\nconst x = 1;", "m1");
    buffer.flushAll();
    expect(sentences).toEqual(["answer"]);
  });

  it("flushes a reply that ends exactly at a closing fence", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("summary ```js\ncode\n```", "m1");
    buffer.flushAll();
    expect(sentences).toEqual(["summary ```js\ncode\n```"]);
  });

  it("cuts on a soft boundary past the minimum length", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    const longTail = `${"a".repeat(70)}, ${"b".repeat(30)} more`;
    buffer.push(longTail, "m1");
    expect(sentences).toEqual([`${"a".repeat(70)},`]);
    expect(buffer).toBeTruthy();
  });

  it("hard-flushes punctuation-free text at the ceiling", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("x".repeat(200), "m1");
    expect(sentences).toEqual(["x".repeat(160)]);
  });

  it("reset drops buffered text and accepts a new reply", () => {
    const { sentences, deps } = collect();
    const buffer = new SentenceBuffer(deps);
    buffer.push("abandoned mid", "m1");
    buffer.reset();
    buffer.push("Fresh start.", "m2");
    expect(sentences).toEqual(["Fresh start."]);
  });

  it("ignores snapshots after flushAll until reset", () => {
    const { deps } = { deps: { onSentence: vi.fn() } };
    const buffer = new SentenceBuffer(deps);
    buffer.push("Done.", "m1");
    buffer.flushAll();
    buffer.push("Late arrival.", "m1");
    expect(deps.onSentence).toHaveBeenCalledTimes(1);
  });
});
