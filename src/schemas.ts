import { Schema } from "effect";

/** Request bodies and settings the Worker accepts, checked with Effect Schema. */

export const RunInput = Schema.Struct({
	prompt: Schema.Trim.check(Schema.isNonEmpty({ message: "prompt must be a non-empty string" })),
});

const Prompt = Schema.Trim.check(Schema.isNonEmpty({ message: "prompt must be a non-empty string" }));

const HistoryItem = Schema.Struct({
	role: Schema.Literals(["user", "assistant"]),
	text: Schema.Trim.check(Schema.isNonEmpty({ message: "each history message needs text" })),
});

/** Starts an agent; it can start from an existing history (Pi 1.6 `init`) and require approvals. */
export const LaunchInput = Schema.Struct({
	prompt: Prompt,
	history: Schema.optionalKey(Schema.Array(HistoryItem)),
	approvals: Schema.optionalKey(Schema.Boolean),
	replyMinutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_440 }, { message: "replyMinutes must be an integer from 1 to 1440" }))),
});

export const MessageInput = Schema.Struct({
	prompt: Prompt,
	mode: Schema.Literals(["queue", "steer"]),
	keep: Schema.Boolean,
});

export const ForkInput = Schema.Struct({
	prompt: Schema.optionalKey(Schema.String),
	note: Schema.optionalKey(Schema.String),
});

/** HumanAnswer's signal schema allows 8,000 characters; ApprovalDecision's note 2,000. index.ts checks the lengths. */
export const ANSWER_MAX = 8_000;
export const NOTE_MAX = 2_000;
export const HISTORY_MAX = 200;

export const AnswerInput = Schema.Struct({
	key: Schema.NonEmptyString,
	text: Schema.optionalKey(Schema.String),
	decision: Schema.optionalKey(Schema.Literals(["allow", "deny"])),
});

export const McpReconnectInput = Schema.Struct({
	serverId: Schema.NonEmptyString,
});

export const InterruptInput = Schema.Struct({
	cause: Schema.Literals(["deadline", "runtime-crash", "abort-all"]),
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
