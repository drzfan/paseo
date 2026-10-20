import { describe, expect, it, vi } from "vitest";
import { sendMessageImpl } from "./input";
import {
  canSubmitFromIme,
  resolveImeSendInputProps,
  runImeSubmitAction,
  type ComposerImeSendInputProps,
} from "./state";

const emptySubmitContext = {
  disabled: false,
  isSubmitDisabled: false,
  isSubmitLoading: false,
  value: "",
  attachments: [],
  hasExternalContent: false,
  allowEmptySubmit: false,
};

function withValue(value: string) {
  return { ...emptySubmitContext, value };
}

describe("composer IME send input props", () => {
  it("declares the send action key on Android", () => {
    const onSubmitEditing = vi.fn();
    const props: ComposerImeSendInputProps | undefined = resolveImeSendInputProps(
      true,
      onSubmitEditing,
    );

    expect(props).toEqual({
      returnKeyType: "send",
      blurOnSubmit: false,
      submitBehavior: "submit",
      onSubmitEditing,
    });
    props?.onSubmitEditing();
    expect(onSubmitEditing).toHaveBeenCalledOnce();
  });

  it("leaves other platforms untouched", () => {
    expect(resolveImeSendInputProps(false, () => undefined)).toBeUndefined();
  });
});

describe("composer IME submit guards", () => {
  it("ignores an empty composer without allowEmptySubmit", () => {
    const submit = vi.fn();
    expect(canSubmitFromIme(emptySubmitContext)).toBe(false);
    expect(runImeSubmitAction({ ...emptySubmitContext, submit })).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only text", () => {
    expect(canSubmitFromIme(withValue("  \n\t "))).toBe(false);
  });

  it("submits text, attachments, or external content", () => {
    expect(canSubmitFromIme(withValue("hello"))).toBe(true);
    expect(
      canSubmitFromIme({
        ...emptySubmitContext,
        attachments: [{ kind: "image" } as never],
      }),
    ).toBe(true);
    expect(canSubmitFromIme({ ...emptySubmitContext, hasExternalContent: true })).toBe(true);
  });

  it("submits an empty composer when the host allows it", () => {
    const submit = vi.fn();
    expect(runImeSubmitAction({ ...emptySubmitContext, allowEmptySubmit: true, submit })).toBe(
      true,
    );
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "isSubmitDisabled", "isSubmitLoading"] as const)(
    "ignores the action while %s",
    (gate) => {
      const submit = vi.fn();
      const ctx = { ...withValue("hello"), [gate]: true, submit };

      expect(runImeSubmitAction(ctx)).toBe(false);
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("submits through the Send button path when allowed", () => {
    const submit = vi.fn();
    expect(runImeSubmitAction({ ...withValue("hello"), submit })).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
  });
});

describe("composer IME submit send path", () => {
  it("exits fullscreen after an IME submit, like the Send button", () => {
    const onSubmit = vi.fn();
    const exitFullscreen = vi.fn();
    const onMinimizeHeight = vi.fn();
    const sendThroughIme = () =>
      runImeSubmitAction({
        ...withValue(" shipped from the IME "),
        submit: () =>
          sendMessageImpl({
            value: " shipped from the IME ",
            attachments: [],
            hasExternalContent: false,
            allowEmptySubmit: false,
            cwd: "/repo",
            isAgentRunning: false,
            onSubmit,
            onMinimizeHeight,
            preserveHeightOnSubmit: false,
            exitFullscreen,
          }),
      });

    expect(sendThroughIme()).toBe(true);
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith({
      text: "shipped from the IME",
      attachments: [],
      cwd: "/repo",
      forceSend: undefined,
    });
    expect(onMinimizeHeight).toHaveBeenCalledOnce();
  });

  it("does not exit fullscreen when the guard blocks the submit", () => {
    const submit = vi.fn();
    const sendThroughIme = () => runImeSubmitAction({ ...withValue("   "), submit });

    expect(sendThroughIme()).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
