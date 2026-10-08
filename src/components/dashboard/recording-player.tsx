"use client";

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { useMiniPlayerSlot } from "@/components/app-shell/mini-player-slot";
import {
    PlayerMiniBar,
    shouldShowMiniPlayer,
} from "@/components/dashboard/player-mini-bar";
import { RecordingPlayerControls } from "@/components/dashboard/recording-player-controls";
import { RecordingPlayerHeader } from "@/components/dashboard/recording-player-header";
import { Card, CardContent } from "@/components/ui/card";
import { usePlaybackEngine } from "@/hooks/use-playback-engine";
import { usePlaybackKeyboard } from "@/hooks/use-playback-keyboard";
import { useWaveform } from "@/hooks/use-waveform";
import type { Recording } from "@/types/recording";

interface RecordingPlayerProps {
    recording: Recording;
    onEnded?: () => void;
    onRenamed?: (filename: string) => void;
    initialPlaybackSpeed?: number;
    initialVolume?: number;
    initialAutoPlayNext?: boolean;
    /**
     * Which scrubber style to render. `"slider"` forces the plain
     * progress bar even when waveform peaks are available; `"waveform"`
     * shows the canvas waveform when peaks exist and falls back to the
     * slider otherwise. Read from userSettings.playerScrubber.
     */
    scrubberStyle?: "waveform" | "slider";
    onRegisterSeek?: (
        seekToMilliseconds: (milliseconds: number) => void,
    ) => void;
    onPlaybackTimeChange?: (milliseconds: number) => void;
}

/**
 * Audio playback card for a single recording. State is owned by
 * usePlaybackEngine (audio element + transport state); keyboard
 * shortcuts by usePlaybackKeyboard; waveform peaks by useWaveform.
 * This component is the composition root, the hidden <audio> element
 * the engine writes to, and the compact bar that appears once the card
 * scrolls out of view. The compact bar reuses the same engine.
 */
export function RecordingPlayer({
    recording,
    onEnded,
    onRenamed,
    initialPlaybackSpeed = 1.0,
    initialVolume = 75,
    initialAutoPlayNext = false,
    scrubberStyle = "waveform",
    onRegisterSeek,
    onPlaybackTimeChange,
}: RecordingPlayerProps) {
    const {
        audioRef,
        isPlaying,
        currentTime,
        duration,
        volume,
        setVolume,
        playbackSpeed,
        togglePlayPause,
        seekToMilliseconds,
        seekToRatio,
        seekRelative,
        cycleSpeed,
        toggleMute,
    } = usePlaybackEngine({
        recording,
        onEnded,
        initialPlaybackSpeed,
        initialVolume,
        initialAutoPlayNext,
    });

    const seekForCurrentRecording = useCallback(
        (milliseconds: number) => {
            if (!recording.id) return;
            seekToMilliseconds(milliseconds);
        },
        [recording.id, seekToMilliseconds],
    );

    useLayoutEffect(() => {
        if (!onRegisterSeek) return;
        onRegisterSeek(seekForCurrentRecording);
    }, [onRegisterSeek, seekForCurrentRecording]);

    useEffect(() => {
        onPlaybackTimeChange?.(currentTime * 1000);
    }, [currentTime, onPlaybackTimeChange]);

    usePlaybackKeyboard({
        onToggle: togglePlayPause,
        onSeekRelative: seekRelative,
        onVolumeDelta: (delta) =>
            setVolume((prev) => Math.max(0, Math.min(100, prev + delta))),
    });

    // Waveform peaks: cached server-side if present, decoded
    // client-side on first listen for recordings under
    // AUTO_DECODE_MAX_MS. Long recordings show a manual "Generate
    // waveform" button instead so we don't surprise the user with a
    // multi-hundred-MB decode.
    const {
        peaks: waveformPeaks,
        status: waveformStatus,
        decode: triggerWaveformDecode,
    } = useWaveform({
        recordingId: recording.id,
        durationMs: recording.duration,
        initialPeaks: recording.waveformPeaks ?? null,
        // Skip auto-decode entirely when the user has opted out of the
        // waveform UI -- there's no point spending CPU on peaks the
        // player will never display.
        autoStart: scrubberStyle === "waveform",
    });

    // The compact bar appears once the card scrolls out of view. The card is
    // also hidden on phones while the list is showing. `offsetParent` is null
    // then, so the bar stays hidden too.
    const cardRef = useRef<HTMLDivElement>(null);
    const [playerInView, setPlayerInView] = useState(true);
    const [playerRendered, setPlayerRendered] = useState(false);
    useEffect(() => {
        const el = cardRef.current;
        if (!el || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                setPlayerInView(entry.isIntersecting);
                setPlayerRendered(el.offsetParent !== null);
            },
            { threshold: 0 },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    const miniPlayerSlot = useMiniPlayerSlot();
    const showMiniPlayer =
        miniPlayerSlot !== null &&
        shouldShowMiniPlayer({
            hasRecording: Boolean(recording.id),
            playerRendered,
            playerInView,
        });

    return (
        <>
            <Card data-testid="player" ref={cardRef}>
                <RecordingPlayerHeader
                    recording={recording}
                    duration={duration}
                    scrubberStyle={scrubberStyle}
                    waveformStatus={waveformStatus}
                    onDecodeWaveform={triggerWaveformDecode}
                    onRenamed={onRenamed}
                />
                <CardContent>
                    <RecordingPlayerControls
                        isPlaying={isPlaying}
                        onTogglePlay={togglePlayPause}
                        currentTime={currentTime}
                        duration={duration}
                        onSeekRatio={seekToRatio}
                        playbackSpeed={playbackSpeed}
                        onCycleSpeed={cycleSpeed}
                        volume={volume}
                        onVolumeChange={setVolume}
                        onToggleMute={toggleMute}
                        scrubberStyle={scrubberStyle}
                        waveformPeaks={waveformPeaks}
                    />

                    <audio
                        ref={audioRef}
                        src={`/api/recordings/${recording.id}/audio`}
                        preload="metadata"
                        className="hidden"
                    >
                        <track kind="captions" />
                    </audio>
                </CardContent>
            </Card>
            {showMiniPlayer && miniPlayerSlot
                ? createPortal(
                      <PlayerMiniBar
                          title={recording.filename}
                          isPlaying={isPlaying}
                          currentTime={currentTime}
                          duration={duration}
                          onToggle={togglePlayPause}
                      />,
                      miniPlayerSlot,
                  )
                : null}
        </>
    );
}
