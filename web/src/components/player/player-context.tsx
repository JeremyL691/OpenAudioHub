import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";

export interface PlayerRecording {
    id: string;
    title: string;
}

/** What the shared audio player exposes. One player serves the detail views and the mini player. */
export interface Player {
    /** The recording loaded in the player, or null. */
    current: PlayerRecording | null;
    playing: boolean;
    /** True once the audio metadata (duration) is known. */
    ready: boolean;
    /** Seconds. */
    time: number;
    /** Seconds. 0 until known. */
    duration: number;
    rate: number;
    /** 0 to 100. */
    volume: number;
    muted: boolean;
    /** The scrubber look chosen in the user's settings. */
    scrubber: "waveform" | "slider";
    /** False while the full player is scrolled out of view (the mini player then shows). */
    playerOnScreen: boolean;
    load(recording: PlayerRecording, autoplay?: boolean): void;
    toggle(): void;
    play(): void;
    pause(): void;
    seek(seconds: number): void;
    skip(deltaSeconds: number): void;
    setRate(rate: number): void;
    setVolume(volume: number): void;
    toggleMute(): void;
    /** Called by the full player to report whether it is on screen. */
    setPlayerOnScreen(onScreen: boolean): void;
    /** Registers a listener for the end of a recording. Returns the unsubscribe function. */
    onEnded(listener: () => void): () => void;
}

const PlayerContext = createContext<Player | null>(null);

/** Playback speeds the speed button cycles through. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Owns the one HTMLAudioElement of the signed-in app. The shell wraps every signed-in page in this provider.
 * Default speed, volume and scrubber come from GET /api/settings/user.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const currentRef = useRef<PlayerRecording | null>(null);
    const endedListeners = useRef(new Set<() => void>());
    const touched = useRef({ rate: false, volume: false });

    const [current, setCurrent] = useState<PlayerRecording | null>(null);
    const [playing, setPlaying] = useState(false);
    const [ready, setReady] = useState(false);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [rate, setRateState] = useState<number>(1);
    const [volume, setVolumeState] = useState(75);
    const [muted, setMuted] = useState(false);
    const [scrubber, setScrubber] = useState<"waveform" | "slider">("waveform");
    const [playerOnScreen, setPlayerOnScreen] = useState(true);

    // Defaults from the user's settings. A value the user already changed in this session wins.
    useEffect(() => {
        let alive = true;
        api<Record<string, unknown>>("/api/settings/user")
            .then((s) => {
                if (!alive) return;
                const speed = s.defaultPlaybackSpeed;
                if (!touched.current.rate && typeof speed === "number" && Number.isFinite(speed) && speed > 0) setRateState(speed);
                const vol = s.defaultVolume;
                if (!touched.current.volume && typeof vol === "number" && Number.isFinite(vol)) setVolumeState(clamp(vol, 0, 100));
                setScrubber(s.playerScrubber === "slider" ? "slider" : "waveform");
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, []);

    // Keep the element in step with the state that drives it.
    useEffect(() => {
        const audio = audioRef.current;
        if (audio) audio.playbackRate = rate;
    }, [rate]);

    useEffect(() => {
        const audio = audioRef.current;
        if (audio) audio.volume = muted ? 0 : volume / 100;
    }, [volume, muted]);

    const load = useCallback((recording: PlayerRecording, autoplay = false) => {
        const audio = audioRef.current;
        if (!audio) return;
        const prev = currentRef.current;
        if (prev?.id === recording.id) {
            if (prev.title !== recording.title) {
                currentRef.current = recording;
                setCurrent(recording);
            }
            if (autoplay) void audio.play().catch(() => undefined);
            return;
        }
        currentRef.current = recording;
        setCurrent(recording);
        audio.pause();
        setReady(false);
        setPlaying(false);
        setTime(0);
        setDuration(0);
        audio.src = `/api/recordings/${encodeURIComponent(recording.id)}/audio`;
        audio.load();
        if (autoplay) void audio.play().catch(() => undefined);
    }, []);

    const play = useCallback(() => {
        if (!currentRef.current) return;
        void audioRef.current?.play().catch(() => undefined);
    }, []);

    const pause = useCallback(() => {
        audioRef.current?.pause();
    }, []);

    const toggle = useCallback(() => {
        const audio = audioRef.current;
        if (!audio || !currentRef.current) return;
        if (audio.paused) void audio.play().catch(() => undefined);
        else audio.pause();
    }, []);

    const seek = useCallback((seconds: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        const max = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
        const target = clamp(seconds, 0, max);
        audio.currentTime = target;
        setTime(target);
    }, []);

    const skip = useCallback(
        (deltaSeconds: number) => {
            seek((audioRef.current?.currentTime ?? 0) + deltaSeconds);
        },
        [seek],
    );

    const setRate = useCallback((next: number) => {
        touched.current.rate = true;
        setRateState(next);
    }, []);

    const setVolume = useCallback((next: number) => {
        touched.current.volume = true;
        const value = clamp(Math.round(next), 0, 100);
        setVolumeState(value);
        if (value > 0) setMuted(false);
    }, []);

    const toggleMute = useCallback(() => setMuted((m) => !m), []);

    const onEnded = useCallback((listener: () => void) => {
        endedListeners.current.add(listener);
        return () => {
            endedListeners.current.delete(listener);
        };
    }, []);

    const value = useMemo<Player>(
        () => ({
            current,
            playing,
            ready,
            time,
            duration,
            rate,
            volume,
            muted,
            scrubber,
            playerOnScreen,
            load,
            toggle,
            play,
            pause,
            seek,
            skip,
            setRate,
            setVolume,
            toggleMute,
            setPlayerOnScreen,
            onEnded,
        }),
        [current, playing, ready, time, duration, rate, volume, muted, scrubber, playerOnScreen, load, toggle, play, pause, seek, skip, setRate, setVolume, toggleMute, onEnded],
    );

    return (
        <PlayerContext.Provider value={value}>
            {children}
            <audio
                ref={audioRef}
                preload="metadata"
                className="hidden"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => {
                    setPlaying(false);
                    for (const listener of endedListeners.current) listener();
                }}
                onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration;
                    setDuration(Number.isFinite(d) ? d : 0);
                    setReady(true);
                }}
                onDurationChange={(e) => {
                    const d = e.currentTarget.duration;
                    setDuration(Number.isFinite(d) ? d : 0);
                }}
                onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            />
        </PlayerContext.Provider>
    );
}

/** The shared player, or null outside a PlayerProvider. */
export function usePlayer(): Player | null {
    return useContext(PlayerContext);
}
