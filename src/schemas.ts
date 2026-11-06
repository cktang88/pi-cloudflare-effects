import { Schema } from "effect";

/** Request bodies and settings the Worker accepts, checked with Effect Schema. */

export const RunInput = Schema.Struct({
	prompt: Schema.Trim.check(Schema.isNonEmpty({ message: "prompt must be a non-empty string" })),
});

export const InterruptInput = Schema.Struct({
	cause: Schema.Literals(["deadline", "runtime-crash"]),
});

export const DeadlineInput = Schema.Struct({
	seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300 }, { message: "seconds must be an integer from 1 to 300" })),
});

const McpServer = Schema.Struct({
	name: Schema.NonEmptyString,
	url: Schema.NonEmptyString,
	headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const McpServers = Schema.fromJsonString(Schema.Array(McpServer));

/** `MCP_SERVERS_JSON`: a JSON array of `{ name, url, headers? }`. Throws an error that says what is wrong. */
export const decodeMcpServers = Schema.decodeUnknownSync(McpServers);
