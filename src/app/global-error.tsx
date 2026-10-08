"use client";

/**
 * Root-layout-level error boundary. It catches errors in `layout.tsx` itself,
 * where the regular `error.tsx` boundary cannot help because it renders inside
 * the layout it would need to replace. It must render its own <html> and <body>,
 * and Next.js swaps the whole document in. Styles are inline because the global
 * stylesheet may not load in this document. Plain language only, as in error.tsx.
 */
export default function GlobalError({ reset }: { reset: () => void }) {
    return (
        <html lang="en">
            <body>
                <main
                    style={{
                        display: "flex",
                        minHeight: "100vh",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "0.75rem",
                        padding: "1rem",
                        textAlign: "center",
                        fontFamily: "system-ui, sans-serif",
                    }}
                >
                    <h1
                        style={{
                            fontSize: "1.125rem",
                            fontWeight: 600,
                            margin: 0,
                        }}
                    >
                        Something went wrong
                    </h1>
                    <p
                        style={{
                            fontSize: "0.875rem",
                            color: "#4b5563",
                            margin: 0,
                        }}
                    >
                        Try again. If the problem continues, reload the page.
                    </p>
                    <button
                        type="button"
                        onClick={() => reset()}
                        style={{
                            marginTop: "0.25rem",
                            padding: "0.5rem 1rem",
                            borderRadius: "0.375rem",
                            border: "1px solid #111827",
                            background: "#111827",
                            color: "#ffffff",
                            font: "inherit",
                            cursor: "pointer",
                        }}
                    >
                        Try again
                    </button>
                </main>
            </body>
        </html>
    );
}
