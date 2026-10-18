import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stateFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.dev-artifacts/extension-e2e-state.json");

interface State {
    serverPid?: number;
    fakePid?: number;
}

export default async function globalTeardown(): Promise<void> {
    let state: State;
    try {
        state = JSON.parse(await readFile(stateFile, "utf8")) as State;
    } catch {
        return;
    }
    for (const pid of [state.serverPid, state.fakePid]) {
        if (pid === undefined) continue;
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // Already gone.
        }
    }
}
