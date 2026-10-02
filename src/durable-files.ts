import { err, FileError, ok, type FileInfo, type FileSystem, type Result, type TextLineReader } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";

/** A small durable file system for Pi Durable's JSONL storage inside one DO. */
export class DurableObjectFiles implements FileSystem {
	readonly id: string;
	cwd = "/";
	private readonly storage: DurableObjectStorage;
	private readonly prefix: string;

	constructor(storage: DurableObjectStorage, id: string) {
		this.storage = storage;
		this.id = id;
		this.prefix = `pi-fs:${id}:`;
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(normalizePath(path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(normalizePath(parts.join("/")));
	}

	async readTextFile(path: string, _context: Context): Promise<Result<string, FileError>> {
		const value = await this.get(path);
		return value === undefined ? err(notFound(path)) : ok(value);
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const result = await this.readTextFile(path, context);
		if (!result.ok) return result;
		const lines = splitLines(result.value);
		let index = 0;
		return ok({
			readLine: async () => ok(lines[index++]),
			close: async () => {},
		});
	}

	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		const result = await this.readTextFile(path, context);
		const lines = result.ok ? splitLines(result.value).map((line) => line.text) : undefined;
		return lines ? ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines)) : result as Result<string[], FileError>;
	}

	async readBinaryFile(path: string, _context: Context): Promise<Result<Uint8Array, FileError>> {
		const value = await this.get(path);
		return value === undefined ? err(notFound(path)) : ok(new TextEncoder().encode(value));
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		await this.storage.put(this.key(path), typeof content === "string" ? content : new TextDecoder().decode(content));
		return ok(undefined);
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const previous = await this.get(path);
		const suffix = typeof content === "string" ? content : new TextDecoder().decode(content);
		await this.storage.put(this.key(path), (previous ?? "") + suffix);
		return ok(undefined);
	}

	async truncateFile(path: string, size: number): Promise<Result<void, FileError>> {
		const value = await this.get(path);
		if (value === undefined) return err(notFound(path));
		const bytes = new TextEncoder().encode(value);
		const next = new Uint8Array(Math.max(0, size));
		next.set(bytes.subarray(0, next.length));
		await this.storage.put(this.key(path), new TextDecoder().decode(next));
		return ok(undefined);
	}

	async flushFile(_path: string, _context: Context): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async renameFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>> {
		const value = await this.get(sourcePath);
		if (value === undefined) return err(notFound(sourcePath));
		await this.storage.put(this.key(destinationPath), value);
		await this.storage.delete(this.key(sourcePath));
		return ok(undefined);
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const value = await this.get(path);
		if (value === undefined) return err(notFound(path));
		return ok({ name: basename(path), path: normalizePath(path), kind: "file", size: new TextEncoder().encode(value).length, mtimeMs: 0 });
	}

	async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		const directory = normalizePath(path);
		const entries = await this.storage.list<string>({ prefix: `${this.prefix}${directory}/` });
		const files: FileInfo[] = [];
		for (const [key, value] of entries) {
			const relative = key.slice(this.prefix.length + directory.length + 1);
			if (!relative || relative.includes("/")) continue;
			files.push({ name: relative, path: `${directory}/${relative}`, kind: "file", size: new TextEncoder().encode(value).length, mtimeMs: 0 });
		}
		return ok(files);
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		return ok(normalizePath(path));
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		return ok((await this.get(path)) !== undefined);
	}

	async createDir(_path: string, _options: { recursive?: boolean } | undefined): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined): Promise<Result<void, FileError>> {
		const key = this.key(path);
		if ((await this.get(path)) !== undefined) {
			await this.storage.delete(key);
			return ok(undefined);
		}
		if (options?.recursive) {
			const entries = await this.storage.list({ prefix: `${key}/` });
			await this.storage.delete([...entries.keys()]);
			return ok(undefined);
		}
		return options?.force ? ok(undefined) : err(notFound(path));
	}

	async createTempDir(prefix: string | undefined): Promise<Result<string, FileError>> {
		return ok(normalizePath(`/tmp/${prefix ?? "pi"}-${crypto.randomUUID()}`));
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined): Promise<Result<string, FileError>> {
		return ok(normalizePath(`/tmp/${options?.prefix ?? "pi"}-${crypto.randomUUID()}${options?.suffix ?? ""}`));
	}

	async cleanup(_context: Context): Promise<void> {}

	private key(path: string): string {
		return `${this.prefix}${normalizePath(path)}`;
	}

	private async get(path: string): Promise<string | undefined> {
		return this.storage.get<string>(this.key(path));
	}
}

function normalizePath(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

function basename(path: string): string {
	return normalizePath(path).split("/").at(-1) ?? "";
}

function notFound(path: string): FileError {
	return new FileError("not_found", `File not found: ${path}`, path);
}

function splitLines(value: string): Array<{ text: string; terminated: boolean }> {
	if (!value) return [];
	const parts = value.split("\n");
	const terminated = value.endsWith("\n");
	if (terminated) parts.pop();
	return parts.map((text, index) => ({ text, terminated: terminated || index < parts.length - 1 }));
}
