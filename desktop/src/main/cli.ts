/**
 * The App's command-line modes (PLAN T15.2, T15.3). They run without a window and exit with a code:
 *   0  done
 *   1  the import or the rollback failed; the message says what was left as it was
 *   2  the App is already running (single instance); quit it and run the command again
 *   3  the command line is wrong, or the export has several accounts and --user-email names none
 * `--then-open` is what the menu's "Import from Docker…" uses after it restarts the App: the import runs, and the
 * App then starts as usual.
 */
export type CliCommand =
    | { kind: "import"; dir: string; userEmail?: string; thenOpen: boolean }
    | { kind: "rollback" };

export type CliParse = { command: CliCommand } | { error: string };

const CLI_FLAGS = [
    "--import",
    "--user-email",
    "--rollback-import",
    "--then-open",
];

/**
 * Returns null when no CLI flag is present (a normal start). Other arguments, such as the ones Electron or
 * Chromium add, are ignored.
 */
export function parseCli(argv: readonly string[]): CliParse | null {
    if (!argv.some((arg) => CLI_FLAGS.includes(arg))) return null;
    const importAt = argv.indexOf("--import");
    const emailAt = argv.indexOf("--user-email");
    const rollback = argv.includes("--rollback-import");

    if (rollback) {
        if (importAt >= 0) {
            return {
                error: "--import and --rollback-import cannot be used together",
            };
        }
        if (emailAt >= 0) {
            return { error: "--user-email only applies to --import" };
        }
        return { command: { kind: "rollback" } };
    }
    if (importAt < 0) {
        return { error: "--import <dir> is needed" };
    }
    const dir = argv[importAt + 1];
    if (!dir || dir.startsWith("--")) {
        return { error: "--import needs the export folder" };
    }
    let userEmail: string | undefined;
    if (emailAt >= 0) {
        const email = argv[emailAt + 1];
        if (!email || email.startsWith("--")) {
            return { error: "--user-email needs an address" };
        }
        userEmail = email;
    }
    return {
        command: {
            kind: "import",
            dir,
            userEmail,
            thenOpen: argv.includes("--then-open"),
        },
    };
}
