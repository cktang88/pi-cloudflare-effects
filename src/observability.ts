import { tracing } from "cloudflare:workers";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema, Tracer } from "effect";

/** Logs each Effect span as JSON when it ends. Cloudflare's traces are separate. */
class LoggedSpan extends Tracer.NativeSpan {
	override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
		super.end(endTime, exit);
		console.log(JSON.stringify({
			event: "effect.span",
			name: this.name,
			traceId: this.traceId,
			spanId: this.spanId,
			outcome: Exit.isSuccess(exit) ? "ok" : "error",
			durationMs: Number((endTime - this.startTime) / 1_000_000n),
		}));
	}
}

const tracer = Tracer.make({ span: (options) => new LoggedSpan(options) });

/** One Effect runtime per isolate, so every program uses the logging tracer. */
export const runtime = ManagedRuntime.make(Layer.succeed(Tracer.Tracer, tracer));

export class OperationFailed extends Schema.TaggedError<OperationFailed>()("OperationFailed", {
	operation: Schema.String,
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

type SpanAttributes = Record<string, string | number | boolean | undefined>;

/**
 * Runs an async function inside an Effect span and a Cloudflare custom span.
 * A failure becomes `OperationFailed` with the original message, so callers (and
 * the model, for tool calls) still see what went wrong.
 */
export const traced = <A>(name: string, attributes: SpanAttributes, run: (signal: AbortSignal) => Promise<A>): Promise<A> =>
	tracing.enterSpan(name, async (span) => {
		span.setAttributes(attributes);
		const program = Effect.tryPromise({
			try: run,
			catch: (cause) => new OperationFailed({ operation: name, message: errorMessage(cause), cause }),
		}).pipe(Effect.withSpan(name, { attributes }));
		const exit = await runtime.runPromiseExit(program);
		span.setAttribute("agent.outcome", Exit.isSuccess(exit) ? "ok" : "error");
		if (Exit.isSuccess(exit)) return exit.value;
		const error = Cause.squash(exit.cause);
		span.recordException(error instanceof Error ? error : String(error));
		throw error;
	});

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

