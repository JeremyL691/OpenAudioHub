/**
 * Navigation helpers between Library and Full View.
 */

export interface LibraryNavigationState {
    fromLibrary?: boolean;
    librarySearch?: string;
    libraryFilter?: string;
    libraryCollection?: string;
}

/** Builds the URL to open full view for a recording, optionally opening Ask AI. */
export function recordingFullViewPath(id: string, openChat = false): string {
    const encoded = encodeURIComponent(id);
    return openChat ? `/recordings/${encoded}?chat=1` : `/recordings/${encoded}`;
}

/** Builds the URL to return to library view with the recording selected. */
export function libraryRecordingPath(id: string, params?: URLSearchParams): string {
    const search = params ? new URLSearchParams(params) : new URLSearchParams();
    search.set("id", id);
    const qs = search.toString();
    return qs ? `/recordings?${qs}` : `/recordings`;
}
