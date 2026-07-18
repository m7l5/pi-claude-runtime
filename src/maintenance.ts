import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ClaudeVersionState = {
  current?: string;
  latest?: string;
  updateAvailable: boolean;
  checked: boolean;
};

export const parseVersion = (value: string): string | undefined =>
  value.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];

export const compareVersions = (left: string, right: string): number => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export async function checkClaudeVersion(binary = "claude"): Promise<ClaudeVersionState> {
  const [installed, latest] = await Promise.allSettled([
    execFileAsync(binary, ["--version"], { timeout: 5_000 }).then(({ stdout }) => parseVersion(stdout)),
    fetch("https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((payload: { version?: string } | undefined) => payload?.version),
  ]);
  const current = installed.status === "fulfilled" ? installed.value : undefined;
  const latestVersion = latest.status === "fulfilled" ? latest.value : undefined;
  return {
    current,
    latest: latestVersion,
    updateAvailable: Boolean(current && latestVersion && compareVersions(current, latestVersion) < 0),
    checked: true,
  };
}

export async function resolveClaudeUpdateCommand(binary = "claude"): Promise<{
  command: string;
  args: string[];
}> {
  try {
    const { stdout } = await execFileAsync("which", [binary], { timeout: 3_000 });
    const resolved = await realpath(stdout.trim());
    const normalized = resolved.replaceAll("\\", "/").toLowerCase();
    if (normalized.includes("/.local/share/claude/") || normalized.endsWith("/.local/bin/claude")) {
      return { command: binary, args: ["update"] };
    }
    if (normalized.includes("/homebrew/") || normalized.includes("/cellar/")) {
      return { command: "brew", args: ["upgrade", "claude-code"] };
    }
    if (normalized.includes("/node_modules/") || normalized.includes("/npm/")) {
      return { command: "npm", args: ["install", "-g", "@anthropic-ai/claude-code@latest"] };
    }
  } catch {}
  return { command: binary, args: ["update"] };
}
