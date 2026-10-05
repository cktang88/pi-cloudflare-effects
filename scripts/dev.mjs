import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const dev = manifest.config?.dev;

if (typeof dev !== "boolean") {
	throw new Error('Set "config.dev" to true for local Wrangler, or false for a fully remote preview.');
}

const extraArgs = process.argv.slice(2);
if (extraArgs.some((arg) => ["--local", "-l", "--remote", "-r"].includes(arg))) {
	throw new Error('Wrangler mode comes from "config.dev"; remove --local/--remote and change that setting instead.');
}

const args = ["dev", ...(dev ? [] : ["--remote"]), ...extraArgs];
console.log(dev
	? "Wrangler local mode: bindings marked remote still use Cloudflare."
	: "Wrangler remote mode: the Worker and its bindings run on Cloudflare.");

const command = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const child = spawn(command, args, {
	cwd: root,
	stdio: "inherit",
	shell: process.platform === "win32",
});

child.on("error", (error) => {
	console.error(`Could not start Wrangler: ${error.message}`);
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	process.exitCode = code ?? (signal ? 1 : 0);
});
