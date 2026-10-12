/**
 * An empty strip at the top of pages without the app shell. In the desktop app
 * the window has no title bar, so the strip keeps the traffic lights clear and
 * lets the window be dragged. It renders nothing in the browser.
 */
export function DesktopTitlebar() {
    return (
        <div
            aria-hidden="true"
            className="desktop-only app-drag h-10 w-full shrink-0"
        />
    );
}
