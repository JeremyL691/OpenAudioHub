import type { Recording } from "@/lib/recordings";

/** One timed segment, as stored by the audio pipeline (spec/audio-pipeline.md, section 9.5). */
export interface TimelineSegment {
    start_ms: number;
    end_ms: number;
    text: string;
    speaker_id?: string | null;
}

/** A transcript row as GET /api/recordings/{id} returns it (spec/transcription.md). */
export interface TranscriptRecord {
    id?: string;
    text: string;
    detectedLanguage: string | null;
    transcriptionType?: string;
    provider: string | null;
    model: string | null;
    timeline: TimelineSegment[] | null;
    timelineSource: string | null;
    source: string;
    createdAt?: string;
}

/** GET /api/recordings/{id}. `transcriptions` is read only when the server returns several sources. */
export interface RecordingDetailData {
    recording: Recording;
    transcription: TranscriptRecord | null;
    transcriptions?: TranscriptRecord[];
}

export type PipelineJobStatus =
    | "queued"
    | "running"
    | "paused_disk"
    | "completed"
    | "needs_alignment"
    | "failed"
    | "cancelled";

export interface PipelineJob {
    id: string;
    status: PipelineJobStatus;
    phase: string | null;
    progress: number;
    errorType: string | null;
    error: string | null;
    updatedAt: string;
}

/** GET /api/recordings/{id}/audio-pipeline. */
export interface PipelineState {
    job: PipelineJob | null;
    timeline: TimelineSegment[] | null;
    timestampSource: string | null;
    transcription: { text: string; language?: string; source: string } | null;
}

/** GET and POST /api/recordings/{id}/summary (spec/ai.md). */
export interface SummaryData {
    summary: string | null;
    keyPoints?: string[];
    actionItems?: string[];
    provider?: string;
    model?: string;
    promptId?: string;
    language?: string;
    createdAt?: string;
    generating?: boolean;
}

/** One saved AI provider, from GET /api/settings/ai/providers. */
export interface ProviderRow {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
}

export interface CustomSummaryPrompt {
    id: string;
    name: string;
    prompt: string;
    createdAt: string;
}

/** The settings this view reads from GET /api/settings/user. */
export interface UserSummarySettings {
    summaryPrompt?: { selectedPrompt?: string; customPrompts?: CustomSummaryPrompt[] };
    aiOutputLanguage?: string | null;
}
