import { type KeyboardEvent, type PointerEvent, type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Slider } from "radix-ui";
import { Download, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { formatBytes, formatClock } from "@/lib/format";
import { cn } from "@/lib/cn";
import { originalDownloadUrl } from "@/lib/recordings";
import { PLAYBACK_RATES, usePlayer } from "./player-context";

/** Recordings longer than this are not decoded automatically (the user starts it with a button). */
const AUTO_DECODE_LIMIT_MS = 30 * 60 * 1000;
const PEAK_COUNT = 200;
const BARS = 120;

export interface PlayerCardRecording {
    id: string;
    filename: string;
    /** Milliseconds. */
    duration: number;
    waveformPeaks: number[] | null;
    /** ISO time the recording started. Shown in the player header. */
    startTime?: string;
    /** Bytes of the original file. Shown in the player header. */
    filesize?: number;
}

export interface PlayerCardProps {
    recording: PlayerCardRecording;
    /** Called after peaks were saved, so the parent reloads the recording. */
    onChanged(): void;
    /** Ref to the player section, used by the parent for the mini player. */
    sectionRef?: Ref<HTMLDivElement>;
    /** Classes for the outer wrapper (the parent decides whether the player is docked at the bottom). */
    className?: string;
    /** Show the title and recording facts above the waveform (the library pane does; the full page does not). */
    showHeader?: boolean;
}

/** The player: title and recording facts, waveform or slider scrubber, time, transport, volume and speed. */
export function PlayerCard({ recording, onChanged, sectionRef, className, showHeader = true }: PlayerCardProps) {
    const player = usePlayer();
    const load = player?.load;
    const { id, filename } = recording;
    const [localPeaks, setLocalPeaks] = useState<number[] | null>(null);

    useEffect(() => {
        setLocalPeaks(null);
    }, [id]);

    useEffect(() => {
        load?.({ id, title: filename });
    }, [load, id, filename]);

    return (
        <div ref={sectionRef} className={className}>
            <Card data-testid="player" className="grid gap-3 rounded-none bg-transparent p-0 shadow-none">
                {showHeader ? <PlayerHeader recording={recording} /> : null}
                <WaveformStatus recording={recording} localPeaks={localPeaks} onPeaksDecoded={setLocalPeaks} onChanged={onChanged} />
                <Scrubber recordingId={id} peaks={recording.waveformPeaks ?? localPeaks} />
                <Transport />
            </Card>
        </div>
    );
}

/** "Oct 16, 2026 · 11:02 PM–11:02 PM", the start and end of the recording. */
function recordedRange(startIso: string, durationMs: number): string {
    const start = new Date(startIso);
    const end = new Date(start.getTime() + durationMs);
    const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(start);
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
    return `${date} · ${time.format(start)}–${time.format(end)}`;
}

/** Title, recorded range, length and size, with the audio download on the right. */
function PlayerHeader({ recording }: { recording: PlayerCardRecording }) {
    const { id, filename, duration, startTime, filesize } = recording;
    const facts: string[] = [formatClock(duration / 1000)];
    if (filesize) facts.push(formatBytes(filesize));
    return (
        <div className="hidden items-start gap-3 lg:flex">
            <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">{filename}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-muted-foreground">
                    {startTime ? (
                        <span>
                            Recorded <time dateTime={startTime}>{recordedRange(startTime, duration)}</time>
                        </span>
                    ) : null}
                    {facts.map((fact) => (
                        <span key={fact} className="inline-flex items-center gap-2">
                            <span aria-hidden="true" className="opacity-40">
                                ·
                            </span>
                            <span>{fact}</span>
                        </span>
                    ))}
                </p>
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" aria-label="Download audio" title="Download audio">
                        <Download aria-hidden="true" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem asChild>
                        <a href={`/api/recordings/${encodeURIComponent(id)}/audio?download=1`} download>
                            <Download />
                            Download MP3
                        </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                        <a href={originalDownloadUrl(id)} download data-testid="download-original">
                            <Download />
                            Download original
                        </a>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Waveform status and peaks
// ---------------------------------------------------------------------------

function WaveformStatus({
    recording,
    localPeaks,
    onPeaksDecoded,
    onChanged,
}: {
    recording: PlayerCardRecording;
    localPeaks: number[] | null;
    onPeaksDecoded(peaks: number[]): void;
    onChanged(): void;
}) {
    const { id, duration, waveformPeaks } = recording;
    const [decoding, setDecoding] = useState(false);
    const [failed, setFailed] = useState(false);
    const attempted = useRef(false);
    const autoDecode = duration <= AUTO_DECODE_LIMIT_MS;
    const hasPeaks = Boolean(waveformPeaks?.length || localPeaks?.length);

    const decode = useCallback(async () => {
        setDecoding(true);
        setFailed(false);
        let ctx: AudioContext | null = null;
        try {
            const res = await fetch(`/api/recordings/${encodeURIComponent(id)}/audio`, { credentials: "same-origin" });
            if (!res.ok) throw new Error(`audio ${res.status}`);
            const data = await res.arrayBuffer();
            ctx = new AudioContext();
            const buffer = await ctx.decodeAudioData(data);
            const values = computePeaks(buffer.getChannelData(0), PEAK_COUNT);
            onPeaksDecoded(values);
            await api(`/api/recordings/${encodeURIComponent(id)}/peaks`, { method: "POST", json: { peaks: values } });
            onChanged();
        } catch {
            setFailed(true);
        } finally {
            setDecoding(false);
            if (ctx) void ctx.close().catch(() => undefined);
        }
    }, [id, onChanged, onPeaksDecoded]);

    useEffect(() => {
        if (hasPeaks || !autoDecode || attempted.current) return;
        attempted.current = true;
        void decode();
    }, [hasPeaks, autoDecode, decode]);

    if (hasPeaks) return null;
    if (decoding) {
        return (
            <p role="status" className="text-xs text-muted-foreground">
                Analyzing audio…
            </p>
        );
    }
    if (failed) {
        return (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Waveform could not be made.</span>
                <Button variant="link" size="sm" onClick={() => void decode()}>
                    Retry waveform
                </Button>
            </div>
        );
    }
    if (!autoDecode) {
        return (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>This recording is long, so its waveform is not made automatically.</span>
                <Button variant="link" size="sm" onClick={() => void decode()}>
                    Generate waveform
                </Button>
            </div>
        );
    }
    return null;
}

/** Makes display peaks (0 to 1) from PCM samples: the max of each bucket, scaled to the loudest bucket. */
export function computePeaks(samples: Float32Array, count: number): number[] {
    const block = Math.max(1, Math.floor(samples.length / count));
    const raw: number[] = [];
    for (let b = 0; b < count; b++) {
        const start = b * block;
        const end = Math.min(samples.length, start + block);
        let max = 0;
        for (let i = start; i < end; i++) {
            const v = Math.abs(samples[i]);
            if (v > max) max = v;
        }
        raw.push(max);
    }
    const top = Math.max(...raw, 0);
    return raw.map((v) => (top > 0 ? Math.round((v / top) * 1000) / 1000 : 0));
}

function downsample(peaks: number[], bars: number): number[] {
    const out: number[] = [];
    for (let b = 0; b < bars; b++) {
        const start = Math.floor((b * peaks.length) / bars);
        const end = Math.max(start + 1, Math.floor(((b + 1) * peaks.length) / bars));
        let max = 0;
        for (let i = start; i < end && i < peaks.length; i++) max = Math.max(max, peaks[i]);
        out.push(max);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Scrubber: waveform (when peaks exist and the setting says so) or a plain slider
// ---------------------------------------------------------------------------

function Scrubber({ recordingId, peaks }: { recordingId: string; peaks: number[] | null }) {
    const player = usePlayer();
    const ref = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);
    const seek = player?.seek;
    const time = player?.time ?? 0;
    const duration = player?.duration ?? 0;
    const useWaveform = Boolean(peaks?.length) && (player?.scrubber ?? "waveform") === "waveform";
    const bars = useMemo(() => (peaks?.length ? downsample(peaks, BARS) : []), [peaks]);
    const fraction = duration > 0 ? Math.min(1, time / duration) : 0;
    const playedBars = Math.round(fraction * bars.length);
    const label = useWaveform ? "Audio waveform scrubber" : "Seek";

    const seekToPointer = (clientX: number) => {
        const el = ref.current;
        if (!el || !seek || duration <= 0) return;
        const rect = el.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        seek(ratio * duration);
    };

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekToPointer(e.clientX);
    };
    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        if (dragging.current) seekToPointer(e.clientX);
    };
    const onPointerUp = () => {
        dragging.current = false;
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (!seek || duration <= 0) return;
        const step = duration * (e.shiftKey ? 0.05 : 0.01);
        if (e.key === "ArrowLeft") seek(time - step);
        else if (e.key === "ArrowRight") seek(time + step);
        else if (e.key === "Home") seek(0);
        else if (e.key === "End") seek(duration);
        else return;
        e.preventDefault();
    };

    const shared = {
        ref,
        role: "slider" as const,
        tabIndex: 0,
        "aria-label": label,
        "aria-valuemin": 0,
        "aria-valuemax": Math.round(duration),
        "aria-valuenow": Math.round(time),
        "aria-valuetext": `${formatClock(time)} of ${formatClock(duration)}`,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onKeyDown,
    };

    return (
        <div data-testid="player-scrubber" {...shared} className="relative flex h-16 cursor-pointer touch-none items-center rounded-md focus-visible:outline-2 focus-visible:outline-ring">
            {useWaveform ? (
                <div aria-hidden="true" className="flex h-full w-full items-center gap-[2px]">
                    {bars.map((height, i) => (
                        <span
                            key={`${recordingId}-${i}`}
                            className={cn("min-w-0 flex-1 rounded-full", i < playedBars ? "bg-waveform-played" : "bg-waveform-unplayed")}
                            style={{ height: `${Math.max(8, height * 100)}%` }}
                        />
                    ))}
                </div>
            ) : (
                <div aria-hidden="true" className="relative h-1.5 w-full rounded-full bg-secondary">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-waveform-played" style={{ width: `${fraction * 100}%` }} />
                    <div className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background shadow-card" style={{ left: `${fraction * 100}%` }} />
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Transport row
// ---------------------------------------------------------------------------

function Transport() {
    const player = usePlayer();
    if (!player) return null;
    const { playing, ready, time, duration, rate, volume, muted, toggle, skip, setRate, setVolume, toggleMute } = player;

    const cycleRate = () => {
        const index = PLAYBACK_RATES.indexOf(rate as (typeof PLAYBACK_RATES)[number]);
        const next = index === -1 ? (PLAYBACK_RATES.find((r) => r > rate) ?? PLAYBACK_RATES[0]) : PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
        setRate(next);
    };
    const rateLabel = `${rate}x`;

    return (
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <p data-testid="player-time" className="justify-self-start text-xs tabular-nums text-muted-foreground">
                <span className="text-foreground">{formatClock(time)}</span>
                <span className="mx-1 opacity-40">/</span>
                <span>{formatClock(duration)}</span>
            </p>
            <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label="Skip back 15 seconds" disabled={!ready} onClick={() => skip(-15)}>
                    <SkipBack />
                </Button>
                <button
                    type="button"
                    data-testid="player-play"
                    aria-label={playing ? "Pause" : "Play"}
                    onClick={toggle}
                    className="inline-flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
                >
                    {playing ? <Pause className="size-5" aria-hidden="true" /> : <Play className="size-5 translate-x-px" aria-hidden="true" />}
                </button>
                <Button variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label="Skip forward 15 seconds" disabled={!ready} onClick={() => skip(15)}>
                    <SkipForward />
                </Button>
            </div>
            <div className="flex items-center justify-self-end gap-1 sm:gap-2">
                <Button variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
                    {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
                </Button>
                <Slider.Root
                    className="relative hidden w-20 touch-none select-none items-center sm:flex"
                    value={[muted ? 0 : volume]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={([next]) => setVolume(next)}
                >
                    <Slider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-muted">
                        <Slider.Range className="absolute h-full rounded-full bg-primary" />
                    </Slider.Track>
                    <Slider.Thumb
                        aria-label="Volume"
                        className="block size-4 rounded-full border border-border bg-background shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/50"
                    />
                </Slider.Root>
                <button
                    type="button"
                    data-testid="player-speed"
                    aria-label={`Playback speed ${rateLabel}. Click to change.`}
                    title="Click to cycle playback speed"
                    onClick={cycleRate}
                    className="inline-flex h-10 w-12 items-center justify-center rounded-lg bg-secondary px-0 text-sm font-medium tabular-nums text-secondary-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-2 focus-visible:outline-ring sm:h-8"
                >
                    {rateLabel}
                </button>
            </div>
        </div>
    );
}
