import { Pause, Play } from "lucide-react";
import { formatClock } from "@/lib/format";
import { usePlayer } from "./player-context";

/**
 * The compact bar shown under the top bar once the full player has scrolled out of view.
 * It takes no space in the page layout and does nothing when clicked.
 */
export function MiniPlayer() {
    const player = usePlayer();
    if (!player || !player.current || player.playerOnScreen) return null;
    const { current, playing, time, duration, toggle } = player;
    const progress = duration > 0 ? Math.min(100, Math.round((time / duration) * 100)) : 0;

    return (
        <section
            aria-label="Now playing"
            data-testid="mini-player"
            className="pointer-events-auto fixed inset-x-0 top-[52px] z-30 flex items-center gap-3 border-b border-border bg-background/90 px-4 py-2 backdrop-blur-md"
        >
            <button
                type="button"
                aria-label={playing ? "Pause" : "Play"}
                onClick={toggle}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring"
            >
                {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4 translate-x-px" aria-hidden="true" />}
            </button>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{current.title}</p>
                <div
                    role="progressbar"
                    aria-label="Playback progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary"
                >
                    <div className="h-full rounded-full bg-waveform-played" style={{ width: `${progress}%` }} />
                </div>
            </div>
            <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatClock(time)} / {formatClock(duration)}
            </p>
        </section>
    );
}
