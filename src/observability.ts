import { Effect, Exit, Tracer } from "effect";
import { tracing } from "cloudflare:workers";

const tracer = Tracer.make({
	span(options) {
		const span = new Tracer.NativeSpan(options);
		return {
			get _tag() { return "Span" as const; },
			get name() { return span.name; },
			get spanId() { return span.spanId; },
			get traceId() { return span.traceId; },
			get parent() { return span.parent; },
			get annotations() { return span.annotations; },
			get status() { return span.status; },
			get attributes() { return span.attributes; },
			get links() { return span.links; },
			get sampled() { return span.sampled; },
			get kind() { return span.kind; },
			attribute: (key, value) => span.attribute(key, value),
			event: (name, startTime, attributes) => span.event(name, startTime, attributes),
			addLinks: (links) => span.addLinks(links),
			end(endTime, exit) {
				span.end(endTime, exit);
				console.log(JSON.stringify({
					event: "effect.span",
					name: span.name,
					traceId: span.traceId,
					spanId: span.spanId,
					outcome: Exit.isSuccess(exit) ? "ok" : "error",
					durationMs: Number((endTime - span.startTime) / 1_000_000n),
				}));
			},
		};
	},
});

export const withObservability = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	effect.pipe(Effect.withTracer(tracer));

export const withCloudflareSpan = <A>(
	name: string,
	attributes: Record<string, string | number | boolean | undefined>,
	run: () => Promise<A>,
): Promise<A> => tracing.enterSpan(name, async (span) => {
	span.setAttributes(attributes);
	try {
		const result = await run();
		span.setAttribute("agent.outcome", "ok");
		return result;
	} catch (error) {
		span.setAttribute("agent.outcome", "error");
		span.recordException(error instanceof Error ? error : String(error));
		throw error;
	}
});
