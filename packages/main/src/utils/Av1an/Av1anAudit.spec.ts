import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Av1an } from './Av1an.js';
import {
    type AuditAv1anOptions,
    type Av1anTaskAudit,
    type Av1anTaskAuditInput,
    auditAv1anTask,
    diagnoseOverwrite,
    diagnoseStatus,
} from './Av1anAudit.js';
import { Encoder, OutputOverwrite } from '../../../../shared/src/data/Types/Options.js';
import { DependencyType, type DependencyPaths } from '../../../../shared/src/data/Configuration.js';

const inputPath = 'C:/My Videos/input.mkv';
const outputPath = 'C:/My Videos/output.mkv';

function makeEnvironment(): DependencyPaths {
    const packaged = { type: DependencyType.Packaged } as const;
    return {
        vapoursynth: { type: DependencyType.System },
        av1an: packaged,
        ffmpeg: { type: DependencyType.Custom, path: 'C:/Tools/ffmpeg/bin' },
        mkvtoolnix: packaged,
        dgdecnv: packaged,
        aom: packaged,
        svt: { type: DependencyType.Custom, path: 'C:/Tools/svt/SvtAv1EncApp.exe' },
        rav1e: packaged,
        vpx: packaged,
        x264: packaged,
        x265: packaged,
    };
}

/**
 * Positive-path options: svt encoder with built-in parameters, a custom
 * parameter overriding the built-in `crf`, one truthful boolean custom flag
 * and one falsy boolean custom flag, plus a string custom option.
 */
function makePositiveOptions(): AuditAv1anOptions {
    return {
        Av1an: {
            input: inputPath,
            output: outputPath,
            // overwriteOutput intentionally left unspecified so the default -y path is exercised
            workers: 4,
            temporary: { path: 'C:/My Videos/temp' },
            encoding: {
                encoder: Encoder.svt,
                preset: 4,
                crf: 25,
                'enable-hdr': 1,
            },
        },
        Av1anCustom: {
            encoding: {
                crf: { name: 'crf', flagPrefix: '--', type: 'number', value: 30, delimiter: ' ' },
                sharpness: { name: 'sharpness', flagPrefix: '--', type: 'boolean', value: true, delimiter: ' ' },
                'film-grain': { name: 'film-grain', flagPrefix: '--', type: 'boolean', value: false, delimiter: ' ' },
            },
            'my-flag': { name: 'my-flag', flagPrefix: '--', type: 'string', value: 'value with spaces', delimiter: ' ' },
        },
    } as unknown as AuditAv1anOptions;
}

function makeNegativeOptions(): AuditAv1anOptions {
    return {
        Av1an: {
            input: inputPath,
            output: outputPath,
            encoding: {
                encoder: Encoder.svt,
                preset: 2,
            },
        },
        Av1anCustom: {
            encoding: {
                'film-grain': { name: 'film-grain', flagPrefix: '--', type: 'boolean', value: false, delimiter: ' ' },
            },
        },
    } as unknown as AuditAv1anOptions;
}

function runAudit(options: AuditAv1anOptions, statusHistory: Av1anTaskAuditInput['statusHistory'] = []): Av1anTaskAudit {
    return auditAv1anTask({
        options,
        environment: makeEnvironment(),
        statusHistory,
        now: new Date('2026-11-11T00:00:00.000Z'),
    });
}

test('positive path: audit argument arrays equal BuildArguments item by item', () => {
    const options = makePositiveOptions();
    const built = Av1an.BuildArguments(options);
    const audit = runAudit(options);

    assert.deepEqual(audit.arguments, built.arguments);
    assert.deepEqual(audit.printFriendlyArguments, built.printFriendlyArguments);
    assert.equal(audit.arguments.length, audit.printFriendlyArguments.length);
    assert.equal(audit.lengthMismatch, false);
});

test('positive path: custom parameter overrides the same-name built-in parameter', () => {
    const options = makePositiveOptions();
    const audit = runAudit(options);
    const videoParamsIndex = audit.arguments.indexOf('--video-params');

    assert.notEqual(videoParamsIndex, -1);
    const videoParams = audit.arguments[videoParamsIndex + 1];

    // The custom value 30 wins; the built-in crf 25 must not survive.
    assert.match(videoParams, /--crf 30/);
    assert.doesNotMatch(videoParams, /--crf 25/);
    // Untouched built-in parameters are still emitted svt-style (`--key value`).
    assert.match(videoParams, /--preset 4/);
    assert.match(videoParams, /--enable-hdr 1/);
});

test('positive path: truthful boolean custom flag is emitted as a standalone argv item', () => {
    const options = makePositiveOptions();
    const audit = runAudit(options);

    assert.ok(audit.arguments.includes('--sharpness'));
    assert.ok(audit.printFriendlyArguments.includes('--sharpness'));
});

test('negative path: falsy boolean custom flag is never a standalone argv item', () => {
    const options = makeNegativeOptions();
    const built = Av1an.BuildArguments(options);
    const audit = runAudit(options);

    assert.deepEqual(audit.arguments, built.arguments);
    assert.deepEqual(audit.printFriendlyArguments, built.printFriendlyArguments);
    assert.equal(audit.arguments.includes('--film-grain'), false);
    assert.equal(audit.printFriendlyArguments.includes('--film-grain'), false);
});

test('default -y is added when overwriteOutput is unspecified, and not when explicitly set', () => {
    const defaultAudit = runAudit(makePositiveOptions());
    assert.deepEqual(defaultAudit.overwrite, {
        specified: false,
        value: null,
        defaultYAdded: true,
        flag: '-y',
    });
    assert.ok(defaultAudit.arguments.includes('-y'));

    const explicitOptions = {
        Av1an: { input: inputPath, output: outputPath, overwriteOutput: OutputOverwrite.no },
    } as unknown as AuditAv1anOptions;
    const explicitAudit = runAudit(explicitOptions);
    assert.deepEqual(explicitAudit.overwrite, {
        specified: true,
        value: OutputOverwrite.no,
        defaultYAdded: false,
        flag: '-n',
    });
    assert.ok(explicitAudit.arguments.includes('-n'));
    assert.equal(explicitAudit.arguments.includes('-y'), false);

    assert.equal(diagnoseOverwrite({
        Av1an: { input: inputPath, output: outputPath, overwriteOutput: OutputOverwrite.yes },
    } as unknown as AuditAv1anOptions).flag, '-y');
});

test('argument diffs explain every quoting difference (paths and spaced values)', () => {
    const audit = runAudit(makePositiveOptions());
    const diffFlags = audit.argumentDiffs.map(diff => diff.flag);

    // Input/output are path values without spaces in their raw form.
    const inputDiff = audit.argumentDiffs.find(diff => diff.flag === '-i');
    assert.ok(inputDiff);
    assert.equal(inputDiff?.isPath, true);
    assert.equal(inputDiff?.containsSpace, true);
    assert.equal(inputDiff?.reason, 'contains-space-and-path');
    assert.equal(inputDiff?.printFriendly, `"${inputPath}"`);

    const outputDiff = audit.argumentDiffs.find(diff => diff.flag === '-o');
    assert.ok(outputDiff);
    assert.equal(outputDiff?.reason, 'contains-space-and-path');

    // --temp is a quoted path value, --video-params is quoted because it contains spaces.
    const tempDiff = audit.argumentDiffs.find(diff => diff.flag === '--temp');
    assert.ok(tempDiff);
    assert.equal(tempDiff?.isPath, true);

    const videoParamsDiff = audit.argumentDiffs.find(diff => diff.flag === '--video-params');
    assert.ok(videoParamsDiff);
    assert.equal(videoParamsDiff?.containsSpace, true);

    // Custom string option value is also wrapped in quotes for display.
    assert.ok(diffFlags.includes('--my-flag'));

    // Every diff marks a purely quoted rendering and stays inside both arrays.
    for (const diff of audit.argumentDiffs) {
        assert.equal(diff.quoted, true);
        assert.equal(audit.printFriendlyArguments[diff.index], diff.printFriendly);
        assert.equal(audit.arguments[diff.index], diff.raw);
        assert.notEqual(diff.raw, diff.printFriendly);
    }

    // Non-quoted items (flags and bare values) never appear as diffs.
    assert.equal(audit.argumentDiffs.some(diff => diff.flag === '--encoder'), false);
});

test('status: empty history is idle and neither pausable nor resumable', () => {
    const audit = runAudit(makePositiveOptions(), []);

    assert.equal(audit.status.historyLength, 0);
    assert.equal(audit.status.currentState, 'idle');
    assert.equal(audit.status.canPause, false);
    assert.equal(audit.status.canResume, false);
    assert.equal(audit.status.isTerminal, false);
    assert.equal(audit.status.lastUpdatedAt, null);

    assert.deepEqual(diagnoseStatus([]), {
        historyLength: 0,
        currentState: 'idle',
        isTerminal: false,
        canPause: false,
        canResume: false,
        lastUpdatedAt: null,
        history: [],
    });
});

test('status: terminal state done is not resumable', () => {
    const history: Av1anTaskAuditInput['statusHistory'] = [
        { state: 'idle', time: new Date('2026-11-11T00:00:00.000Z') },
        { state: 'encoding', time: new Date('2026-11-11T00:01:00.000Z') },
        { state: 'done', time: new Date('2026-11-11T00:02:00.000Z') },
    ];
    const audit = runAudit(makePositiveOptions(), history);

    assert.equal(audit.status.currentState, 'done');
    assert.equal(audit.status.isTerminal, true);
    assert.equal(audit.status.canResume, false);
    assert.equal(audit.status.canPause, false);
    assert.equal(audit.status.lastUpdatedAt, '2026-11-11T00:02:00.000Z');

    // canceled and error are terminal/non-resumable as well.
    for (const terminalState of ['cancelled', 'error'] as const) {
        const terminal = diagnoseStatus([{ state: terminalState, time: new Date(0) }]);
        assert.equal(terminal.currentState, terminalState);
        assert.equal(terminal.isTerminal, true);
        assert.equal(terminal.canResume, false);
        assert.equal(terminal.canPause, false);
    }
});

test('status: paused is resumable; encoding and scene-detection are pausable', () => {
    const paused = runAudit(makePositiveOptions(), [
        { state: 'encoding', time: new Date('2026-11-11T00:01:00.000Z') },
        { state: 'paused', time: new Date('2026-11-11T00:02:00.000Z') },
    ]);
    assert.equal(paused.status.currentState, 'paused');
    assert.equal(paused.status.canResume, true);
    assert.equal(paused.status.canPause, false);

    const encoding = diagnoseStatus([{ state: 'encoding', time: new Date(0) }]);
    assert.equal(encoding.canPause, true);
    assert.equal(encoding.canResume, false);

    const sceneDetection = diagnoseStatus([{ state: 'scene-detection', time: new Date(0) }]);
    assert.equal(sceneDetection.canPause, true);
    assert.equal(sceneDetection.canResume, false);
});

test('environment diagnostic lists only custom dependency paths', () => {
    const audit = runAudit(makePositiveOptions());
    assert.deepEqual(audit.environment.customDependencies, [
        { dependency: 'ffmpeg', path: 'C:/Tools/ffmpeg/bin' },
        { dependency: 'svt', path: 'C:/Tools/svt/SvtAv1EncApp.exe' },
    ]);
});

test('audit result is JSON-serializable and round-trips losslessly', () => {
    const history: Av1anTaskAuditInput['statusHistory'] = [
        { state: 'idle', time: new Date('2026-11-11T00:00:00.000Z') },
        { state: 'encoding', time: '2026-11-11T00:01:00.000Z' },
        { state: 'paused', time: 1762819320000 },
    ];
    const audit = runAudit(makePositiveOptions(), history);

    const serialized = JSON.stringify(audit);
    assert.equal(typeof serialized, 'string');
    const restored = JSON.parse(serialized);
    assert.deepEqual(restored, audit);
    // Dates in the history are emitted as ISO strings, never as objects.
    assert.equal(typeof restored.status.history[0].time, 'string');
    assert.equal(restored.generatedAt, '2026-11-11T00:00:00.000Z');
});

test('Av1an.audit() collects instance options, environment and status history', () => {
    const options = makePositiveOptions();
    const environment = makeEnvironment();
    const av1an = new Av1an(options, environment, [
        { state: 'paused', time: new Date('2026-11-11T00:02:00.000Z') },
    ]);

    const audit = av1an.audit();
    const built = Av1an.BuildArguments(options);

    assert.deepEqual(audit.arguments, built.arguments);
    assert.deepEqual(audit.printFriendlyArguments, built.printFriendlyArguments);
    // The instance starts from one seeded 'idle' entry; a non-terminal previous
    // state causes the constructor to append a fresh 'idle' entry.
    assert.equal(audit.status.currentState, 'idle');
    assert.equal(audit.status.historyLength, 2);
    assert.deepEqual(audit.environment.customDependencies, [
        { dependency: 'ffmpeg', path: 'C:/Tools/ffmpeg/bin' },
        { dependency: 'svt', path: 'C:/Tools/svt/SvtAv1EncApp.exe' },
    ]);
    assert.equal(JSON.parse(JSON.stringify(audit)).status.currentState, 'idle');
});

test('Av1an.audit() keeps the initial idle state when given a terminal previous history', () => {
    const options = makePositiveOptions();
    const av1an = new Av1an(options, makeEnvironment(), [
        { state: 'encoding', time: new Date('2026-11-11T00:01:00.000Z') },
        { state: 'done', time: new Date('2026-11-11T00:02:00.000Z') },
    ]);

    // The constructor seeds allStates with a single 'idle' entry and, matching
    // its /done|canceled|error/ guard, does not append another one for terminal history.
    const audit = av1an.audit();
    assert.equal(audit.status.historyLength, 1);
    assert.equal(audit.status.currentState, 'idle');
    assert.equal(audit.status.canPause, false);
    assert.equal(audit.status.canResume, false);
});
