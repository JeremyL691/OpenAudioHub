/**
 * Long transcripts are summarized in two passes: notes per part, then the
 * template over the notes. One pass would overflow the context window of
 * many chat models (an 11-hour recording is ~130k characters).
 *
 * shortcut: a fixed character budget, not the model's real context size;
 * upgrade to a per-model budget if users report cut-off parts.
 */
export const SUMMARY_CHUNK_CHARS = 40_000;

// Splits after the punctuation, so each sentence keeps its own.
const SENTENCE_END = /(?<=[。！？!?.])/;

/** Splits `text` into ordered parts of at most `maxChars`, on line ends, then sentence ends. */
export function splitTranscript(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];
    const parts: string[] = [];
    let current = "";
    const push = () => {
        if (current.trim()) parts.push(current.trim());
        current = "";
    };
    for (const line of text.split("\n")) {
        for (const piece of splitLongLine(line, maxChars)) {
            if (current.length + piece.length + 1 > maxChars) push();
            current += current ? `\n${piece}` : piece;
        }
    }
    push();
    return parts;
}

function splitLongLine(line: string, maxChars: number): string[] {
    if (line.length <= maxChars) return [line];
    const sentences = line.split(SENTENCE_END);
    const pieces: string[] = [];
    let current = "";
    for (const sentence of sentences) {
        if (current && current.length + sentence.length > maxChars) {
            pieces.push(current);
            current = "";
        }
        current += sentence;
        // A single sentence longer than the budget is cut hard.
        while (current.length > maxChars) {
            pieces.push(current.slice(0, maxChars));
            current = current.slice(maxChars);
        }
    }
    if (current) pieces.push(current);
    return pieces;
}

/** "1:05:00" style clock for a position in the recording. */
function clock(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Approximate time range of each part, assuming speech is spread evenly
 * over the recording. Transcripts carry no timestamps, so this is the only
 * anchor the model gets for "when" in a long recording.
 */
export function partTimeRanges(
    parts: string[],
    durationMs: number,
): { start: string; end: string }[] {
    const total = parts.reduce((sum, part) => sum + part.length, 0) || 1;
    let offset = 0;
    return parts.map((part) => {
        const start = (offset / total) * durationMs;
        offset += part.length;
        return {
            start: clock(start),
            end: clock((offset / total) * durationMs),
        };
    });
}

export function buildPartNotesPrompt(
    part: string,
    index: number,
    count: number,
    range: { start: string; end: string },
): string {
    return `This is part ${index + 1} of ${count} of one long recording, covering roughly ${range.start} to ${range.end}. Write detailed notes on this part only. They will be merged with the notes on the other parts, so keep detail rather than condensing.

Use Markdown: a short heading per topic, in the order discussed, with bullets under each. Keep every concrete fact: names, numbers, dates, places, decisions and who made them, tasks with their owner and deadline, open questions, and short verbatim quotes that matter. Note when a topic seems to continue from the previous part or into the next one. Write no introduction or conclusion.

Transcription part:
${part}`;
}

/** Stands in for `{transcription}` in the template when the input is part notes. */
export function joinPartNotes(
    notes: string[],
    ranges: { start: string; end: string }[],
): string {
    return notes
        .map(
            (note, i) =>
                `### Part ${i + 1} (about ${ranges[i].start} to ${ranges[i].end})\n${note}`,
        )
        .join("\n\n");
}
