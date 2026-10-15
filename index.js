#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import zlib from "node:zlib";

const TEMPLATE_REPO = "bare-engine/bare-template";
const DEFAULT_DIR = "my-bare-game";

const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = color(1);
const dim = color(2);
const red = color(31);
const green = color(32);
const cyan = color(36);

const HELP = `
Usage: npm create bare-game [folder] [-- options]

Options:
  --ref <tag|branch>  Template version to use (default: latest release, else main)
  --from <file>       Use a local .tar.gz of the template instead of downloading
  --no-git            Don't run git init
  --no-install        Don't install dependencies
  -y, --yes           Accept all defaults without asking
  -h, --help          Show this help
`;

function parseArgs(argv) {
    const args = { dir: undefined, ref: undefined, from: undefined, git: undefined, install: undefined, yes: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-h" || a === "--help") args.help = true;
        else if (a === "-y" || a === "--yes") args.yes = true;
        else if (a === "--no-git") args.git = false;
        else if (a === "--no-install") args.install = false;
        else if (a === "--ref") args.ref = argv[++i];
        else if (a.startsWith("--ref=")) args.ref = a.slice(6);
        else if (a === "--from") args.from = argv[++i];
        else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        else if (args.dir === undefined) args.dir = a;
        else throw new Error(`Unexpected argument: ${a}`);
    }
    return args;
}

function createPrompter(interactive) {
    const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
    return {
        async text(question, fallback) {
            if (!rl) return fallback;
            const answer = (await rl.question(`${question} ${dim(`(${fallback})`)} `)).trim();
            return answer || fallback;
        },
        async confirm(question, fallback = true) {
            if (!rl) return fallback;
            const answer = (await rl.question(`${question} ${dim(fallback ? "(Y/n)" : "(y/N)")} `)).trim().toLowerCase();
            return answer ? answer.startsWith("y") : fallback;
        },
        close() {
            rl?.close();
        },
    };
}

function isEmptyDir(dir) {
    if (!fs.existsSync(dir)) return true;
    return fs.readdirSync(dir).every((f) => f === ".git");
}

function toPackageName(name) {
    return (
        name
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/^[._]/, "")
            .replace(/[^a-z0-9-~]+/g, "-") || "bare-game"
    );
}

async function resolveRef() {
    try {
        const res = await fetch(`https://api.github.com/repos/${TEMPLATE_REPO}/releases/latest`, {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "create-bare-game" },
        });
        if (res.ok) {
            const release = await res.json();
            if (release.tag_name) return release.tag_name;
        }
    } catch {
        // Offline or rate limited: fall through to main, the download will report real errors.
    }
    return "main";
}

async function download(ref) {
    const url = `https://codeload.github.com/${TEMPLATE_REPO}/tar.gz/${encodeURIComponent(ref)}`;
    const res = await fetch(url, { headers: { "User-Agent": "create-bare-game" } });
    if (!res.ok) {
        const hint = res.status === 404 ? ` The ref "${ref}" doesn't exist, or ${TEMPLATE_REPO} isn't public.` : "";
        throw new Error(`Could not download the template (${res.status}) from ${url}.${hint}`);
    }
    return zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
}

function readString(buf, start, length) {
    const end = buf.indexOf(0, start);
    return buf.toString("utf8", start, end === -1 || end > start + length ? start + length : end);
}

function parsePax(data) {
    const fields = {};
    let i = 0;
    while (i < data.length) {
        const space = data.indexOf(0x20, i);
        if (space === -1) break;
        const len = parseInt(data.toString("utf8", i, space), 10);
        if (!len) break;
        const record = data.toString("utf8", space + 1, i + len - 1);
        const eq = record.indexOf("=");
        fields[record.slice(0, eq)] = record.slice(eq + 1);
        i += len;
    }
    return fields;
}

/** Extracts a tar archive into `dest`, dropping the top folder GitHub adds (`repo-ref/`). */
function extractTar(tar, dest) {
    const root = path.resolve(dest);
    let offset = 0;
    let longName = null;

    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) break;

        const size = parseInt(readString(header, 124, 12).trim() || "0", 8);
        const type = String.fromCharCode(header[156] || 0x30);
        const prefix = readString(header, 345, 155);
        let name = readString(header, 0, 100);
        if (prefix) name = `${prefix}/${name}`;

        const dataStart = offset + 512;
        const data = tar.subarray(dataStart, dataStart + size);
        offset = dataStart + Math.ceil(size / 512) * 512;

        if (type === "x") {
            longName = parsePax(data).path ?? longName;
            continue;
        }
        if (type === "L") {
            longName = readString(data, 0, data.length);
            continue;
        }
        if (type === "g") continue;
        if (longName) {
            name = longName;
            longName = null;
        }

        const relative = name.split("/").slice(1).join("/");
        if (!relative) continue;
        const target = path.resolve(root, relative);
        if (target !== root && !target.startsWith(root + path.sep)) {
            throw new Error(`Refusing to write outside the project folder: ${name}`);
        }

        if (type === "5") {
            fs.mkdirSync(target, { recursive: true });
        } else if (type === "0" || type === "\0") {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data);
        }
        // Links and other entry types are skipped; the template has none.
    }
}

function updatePackageJson(dir, name) {
    const file = path.join(dir, "package.json");
    if (!fs.existsSync(file)) return;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.name = name;
    pkg.version = "0.1.0";
    delete pkg.author;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 4) + "\n");
}

function packageManager() {
    const agent = process.env.npm_config_user_agent ?? "";
    for (const pm of ["pnpm", "yarn", "bun"]) {
        if (agent.startsWith(pm)) return pm;
    }
    return "npm";
}

function run(command, args, cwd, quiet = false) {
    const result = spawnSync(command, args, { cwd, stdio: quiet ? "ignore" : "inherit" });
    return result.status === 0;
}

/** Package managers are `.cmd` shims on Windows, which only start through a shell. */
function runPackageManager(pm, cwd) {
    const result = spawnSync(`${pm} install`, { cwd, stdio: "inherit", shell: true });
    return result.status === 0;
}

function hasGit() {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(HELP);
        return;
    }

    const interactive = !args.yes && process.stdin.isTTY;
    const prompt = createPrompter(interactive);
    console.log(`\n${bold("Bare Engine")} ${dim("· create a new game")}\n`);

    try {
        const dirInput = args.dir ?? (await prompt.text("Project folder:", DEFAULT_DIR));
        const dir = path.resolve(dirInput);
        if (!isEmptyDir(dir)) {
            throw new Error(`${dirInput} is not empty. Pick a new folder name.`);
        }
        const name = toPackageName(path.basename(dir));

        const useGit = args.git ?? (hasGit() && (await prompt.confirm("Initialize a git repository?")));
        const install = args.install ?? (await prompt.confirm("Install dependencies?"));
        prompt.close();

        let tar;
        if (args.from) {
            console.log(`\nUsing ${cyan(args.from)}...`);
            tar = zlib.gunzipSync(fs.readFileSync(args.from));
        } else {
            const ref = args.ref ?? (await resolveRef());
            console.log(`\nDownloading ${cyan(`${TEMPLATE_REPO}@${ref}`)}...`);
            tar = await download(ref);
        }

        fs.mkdirSync(dir, { recursive: true });
        extractTar(tar, dir);
        updatePackageJson(dir, name);
        console.log(green("✔ Project created"));

        if (useGit) {
            const ok =
                run("git", ["init", "-q"], dir, true) &&
                run("git", ["add", "-A"], dir, true) &&
                run("git", ["commit", "-q", "-m", "Initial commit from create-bare-game"], dir, true);
            console.log(ok ? green("✔ Git repository initialized") : dim("Git setup skipped (git init or commit failed)"));
        }

        const pm = packageManager();
        if (install) {
            console.log(`\nInstalling dependencies with ${pm}...\n`);
            if (!runPackageManager(pm, dir)) {
                console.log(red(`\nInstall failed. Run "${pm} install" inside the project folder to try again.`));
            }
        }

        const runDev = pm === "npm" ? "npm run dev" : `${pm} dev`;
        console.log(`\n${bold("Done.")} Next steps:\n`);
        if (dir !== process.cwd()) {
            const rel = path.relative(process.cwd(), dir);
            console.log(`  cd ${/\s/.test(rel) ? `"${rel}"` : rel}`);
        }
        if (!install) console.log(`  ${pm} install`);
        console.log(`  ${runDev}\n`);
    } finally {
        prompt.close();
    }
}

main().catch((err) => {
    console.error(red(`\n✖ ${err.message}`));
    process.exit(1);
});
