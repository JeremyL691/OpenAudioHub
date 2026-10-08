/** Saves text as a file in the browser through a temporary object URL. */
export function downloadText(
    filename: string,
    content: string,
    mimeType: string,
): void {
    const url = URL.createObjectURL(
        new Blob([content], { type: `${mimeType};charset=utf-8` }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
