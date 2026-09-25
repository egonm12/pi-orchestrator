import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ProviderStream = ReturnType<NonNullable<NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>["streamSimple"]>>;
type StreamEvent = Awaited<ReturnType<ReturnType<ProviderStream[typeof Symbol.asyncIterator]>["next"]>>["value"];
type Message = Extract<StreamEvent, { type: "done" }> extends { message: infer T } ? T : never;

/** Pi's provider contract requires both an async iterable and a result promise.
 * Mirrors pi-ai's EventStream (dist/utils/event-stream.js, pi-ai 0.87.1):
 * terminal events settle result(), and consumers can iterate independently.
 * pi-ai does not resolve as a direct dependency from this package. */
export function autoStream(): { stream: ProviderStream; push: (event: StreamEvent) => void; end: (model: { api: string; provider: string; model: string }) => void } {
  const events: StreamEvent[] = [];
  const waiting: ((result: IteratorResult<StreamEvent>) => void)[] = [];
  let ended = false;
  let finish!: (message: Message) => void;
  const final = new Promise<Message>((resolve) => { finish = resolve; });
  const stream = {
    push(event: StreamEvent) {
      if (ended) return;
      if (event.type === "done" || event.type === "error") { ended = true; finish(event.type === "done" ? event.message : event.error); }
      const waiter = waiting.shift();
      if (waiter) waiter({ value: event, done: false });
      else events.push(event);
      if (ended) this.flush();
    },
    flush() {
      for (const waiter of waiting.splice(0)) waiter({ value: undefined, done: true });
    },
    end(model: { api: string; provider: string; model: string }) {
      if (!ended) this.push({ type: "error", reason: "error", error: {
        role: "assistant", content: [], ...model, stopReason: "error", timestamp: Date.now(),
        errorMessage: "auto model rung stream ended without a final message",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      this.flush();
    },
    result: () => final,
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (events.length) { yield events.shift()!; continue; }
        if (ended) return;
        const next = await new Promise<IteratorResult<StreamEvent>>((resolve) => waiting.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    },
  };
  return { stream: stream as unknown as ProviderStream, push: (event) => stream.push(event), end: (model) => stream.end(model) };
}
