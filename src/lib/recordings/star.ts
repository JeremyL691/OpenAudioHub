/** Stars or unstars a recording. Throws when the server rejects the change. */
export async function setRecordingStarred(
    id: string,
    starred: boolean,
): Promise<void> {
    const response = await fetch(
        `/api/recordings/${encodeURIComponent(id)}/star`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ starred }),
        },
    );
    if (!response.ok) throw new Error("Could not update the star");
}
