import { createCanvas } from "@napi-rs/canvas";
(globalThis as any).document = {
  createElement: (t: string) => (t === "canvas" ? createCanvas(1, 1) : ({ getContext: () => null } as any)),
};
