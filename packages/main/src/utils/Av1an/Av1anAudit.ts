import {
    type DependencyPaths,
    DependencyType,
} from '../../../../shared/src/data/Configuration.js';
import type { Options } from '../../../../shared/src/data/Types/Options.js';
import { OutputOverwrite } from '../../../../shared/src/data/Types/Options.js';
import type { Task } from '../../../../shared/src/data/Projects.js';
import type { Av1anStatus } from '../../../../shared/src/data/Types/Status.js';
import { Av1an } from './Av1an.js';

/**
 * Snapshot of the Av1an options for one task. Structurally identical to the
 * private `Av1anOptions` type used by {@link Av1an}.
 */
export type AuditAv1anOptions = Task['item'] & { Av1an: Options };

/**
 * One status-history entry as accepted by the diagnostic.
 * `time` may be a Date, an ISO string or a numeric timestamp.
 */
export interface AuditStatusEntry {
    state: Av1anStatus['state'];
    time: Date | string | number;
    progress?: Av1anStatus['progress'];
    error?: unknown;
}

export interface Av1anTaskAuditInput {
    options: AuditAv1anOptions;
    environment: DependencyPaths;
    statusHistory: readonly AuditStatusEntry[];
    /** Reference "now". Defaults to the current time when omitted. */
    now?: Date;
}

export type Av1anArgumentQuoteReason = 'path' | 'contains-space' | 'contains-space-and-path' | 'quoted';

export interface Av1anArgumentDiff {
    /** Zero-based position in both argument arrays. */
    index: number;
    /** The flag token preceding this value, when applicable. */
    flag: string | null;
    /** Raw value as passed to the av1an child process. */
    raw: string;
    /** Value as rendered for display (surrounded by double quotes). */
    printFriendly: string;
    /** Always true: every divergence between the two arrays is a quoting change. */
    quoted: true;
    containsSpace: boolean;
    isPath: boolean;
    reason: Av1anArgumentQuoteReason;
}

export interface Av1anOverwriteDiagnostic {
    /** Whether `overwriteOutput` was explicitly specified on the snapshot. */
    specified: boolean;
    /** The explicit value, or null when unspecified. */
    value: OutputOverwrite | null;
    /** True when av1an would receive a default `-y` because nothing was specified. */
    defaultYAdded: boolean;
    /** The overwrite flag that ends up on the command line, if any. */
    flag: '-y' | '-n' | null;
}

export interface Av1anStatusDiagnostic {
    historyLength: number;
    /** Inferred current state; an empty history is treated as `idle`. */
    currentState: Av1anStatus['state'];
    /** True for the terminal states `done`, `cancelled` and `error`. */
    isTerminal: boolean;
    /** Pausing is only meaningful while `encoding` or `scene-detection`. */
    canPause: boolean;
    /** Only a `paused` task can be resumed. */
    canResume: boolean;
    lastUpdatedAt: string | null;
    /** Status history normalized to JSON-serializable plain data. */
    history: { state: Av1anStatus['state']; time: string }[];
}

export interface Av1anEnvironmentDiagnostic {
    /** Dependencies configured with a custom path, the entries BuildEnvironmentPath would prepend on Windows. */
    customDependencies: { dependency: keyof DependencyPaths; path: string }[];
}

export interface Av1anTaskAudit {
    /** Final argv, item-by-item equal to `Av1an.BuildArguments(options).arguments`. */
    arguments: string[];
    /** Display argv, item-by-item equal to `Av1an.BuildArguments(options).printFriendlyArguments`. */
    printFriendlyArguments: string[];
    /** Per-index explanation of every quoting difference between the two arrays. */
    argumentDiffs: Av1anArgumentDiff[];
    lengthMismatch: boolean;
    overwrite: Av1anOverwriteDiagnostic;
    status: Av1anStatusDiagnostic;
    environment: Av1anEnvironmentDiagnostic;
    /** ISO timestamp of the `now` snapshot the diagnostic was built for. */
    generatedAt: string;
}

/** Flags whose values are file/system paths and are therefore quoted for display. */
const PATH_VALUE_FLAGS = new Set([
    '-i',
    '-o',
    '--proxy',
    '--log-file',
    '--temp',
    '--scenes',
    '--zones',
    '--vmaf',
]);

const TERMINAL_STATES: Av1anStatus['state'][] = ['done', 'cancelled', 'error'];
const PAUSABLE_STATES: Av1anStatus['state'][] = ['encoding', 'scene-detection'];

function toIsoTime(time: Date | string | number): string {
    return new Date(time).toISOString();
}

function looksLikePath(value: string): boolean {
    return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value);
}

/**
 * Explain every item where the display array quotes a value that the raw argv
 * contains unquoted. The two arrays are built in lockstep by BuildArguments,
 * so every divergence is purely a double-quote wrapping of the same value.
 */
export function diffArguments(argv: readonly string[], printFriendlyArguments: readonly string[]): Pick<Av1anTaskAudit, 'argumentDiffs' | 'lengthMismatch'> {
    const argumentDiffs: Av1anArgumentDiff[] = [];
    const lengthMismatch = argv.length !== printFriendlyArguments.length;
    const comparedLength = Math.min(argv.length, printFriendlyArguments.length);

    for (let index = 0; index < comparedLength; index += 1) {
        const raw = argv[index];
        const printFriendly = printFriendlyArguments[index];

        if (raw === printFriendly) {
            continue;
        }

        const previous = index > 0 ? argv[index - 1] : null;
        const flag = previous !== null && previous.startsWith('-') ? previous : null;
        const containsSpace = /\s/.test(raw);
        const isPath = (flag !== null && PATH_VALUE_FLAGS.has(flag)) || looksLikePath(raw);

        let reason: Av1anArgumentQuoteReason;
        if (containsSpace && isPath) {
            reason = 'contains-space-and-path';
        } else if (containsSpace) {
            reason = 'contains-space';
        } else if (isPath) {
            reason = 'path';
        } else {
            reason = 'quoted';
        }

        argumentDiffs.push({
            index,
            flag,
            raw,
            printFriendly,
            quoted: true,
            containsSpace,
            isPath,
            reason,
        });
    }

    return { argumentDiffs, lengthMismatch };
}

export function diagnoseOverwrite(options: AuditAv1anOptions): Av1anOverwriteDiagnostic {
    const overwriteOutput = options.Av1an.overwriteOutput;
    // BuildArguments treats any non-null/non-undefined enum value as explicit.
    const specified = overwriteOutput !== null && overwriteOutput !== undefined;

    if (!specified) {
        return {
            specified: false,
            value: null,
            defaultYAdded: true,
            flag: '-y',
        };
    }

    return {
        specified: true,
        value: overwriteOutput,
        defaultYAdded: false,
        flag: overwriteOutput === OutputOverwrite.yes ? '-y' : '-n',
    };
}

export function diagnoseStatus(statusHistory: readonly AuditStatusEntry[]): Av1anStatusDiagnostic {
    const history = statusHistory.map(entry => ({
        state: entry.state,
        time: toIsoTime(entry.time),
    }));

    if (statusHistory.length === 0) {
        return {
            historyLength: 0,
            currentState: 'idle',
            isTerminal: false,
            canPause: false,
            canResume: false,
            lastUpdatedAt: null,
            history,
        };
    }

    const lastEntry = statusHistory[statusHistory.length - 1];
    const currentState = lastEntry.state;

    return {
        historyLength: statusHistory.length,
        currentState,
        isTerminal: TERMINAL_STATES.includes(currentState),
        canPause: PAUSABLE_STATES.includes(currentState),
        canResume: currentState === 'paused',
        lastUpdatedAt: toIsoTime(lastEntry.time),
        history,
    };
}

export function diagnoseEnvironment(environment: DependencyPaths): Av1anEnvironmentDiagnostic {
    const customDependencies = (Object.entries(environment) as [keyof DependencyPaths, DependencyPaths[keyof DependencyPaths]][])
        .filter(([, preference]) => preference.type === DependencyType.Custom)
        .map(([dependency, preference]) => ({
            dependency,
            path: (preference as { path: string }).path,
        }));

    return { customDependencies };
}

/**
 * Pure command-line and status-progression diagnostic for one Av1an task.
 *
 * The argument arrays are delegated to {@link Av1an.BuildArguments} so that the
 * diagnostic can never drift from the argv actually handed to the child
 * process. This function spawns no process, performs no file system access and
 * touches no Electron API; its return value contains only JSON-serializable
 * plain data (Dates are rendered as ISO strings).
 */
export function auditAv1anTask(input: Av1anTaskAuditInput): Av1anTaskAudit {
    const { options, environment, statusHistory } = input;
    const now = input.now ?? new Date();

    const { arguments: args, printFriendlyArguments } = Av1an.BuildArguments(options);
    const { argumentDiffs, lengthMismatch } = diffArguments(args, printFriendlyArguments);

    return {
        arguments: [...args],
        printFriendlyArguments: [...printFriendlyArguments],
        argumentDiffs,
        lengthMismatch,
        overwrite: diagnoseOverwrite(options),
        status: diagnoseStatus(statusHistory),
        environment: diagnoseEnvironment(environment),
        generatedAt: now.toISOString(),
    };
}
