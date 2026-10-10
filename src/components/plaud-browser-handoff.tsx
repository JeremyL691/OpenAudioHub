"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Logo } from "@/components/icons/logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getApiErrorMessage } from "@/lib/api-errors";
import {
    CONNECTOR_INSTALL_URL,
    readConnectorBridge,
} from "@/lib/plaud/connector-bridge";

type Detection = "checking" | "found" | "missing";
type HandoffPhase = "ready" | "working" | "done";

const DETECT_INTERVAL_MS = 750;
const DETECT_TIMEOUT_MS = 10_000;
const COMPLETE_FALLBACK = "Could not finish connecting Plaud. Try again.";
const EXPIRED_FALLBACK =
    "This sign-in link has expired. Start again from the OpenAudioHub app.";

/** Finishes a Plaud sign-in started in the desktop app, using the connector in this browser. */
export function PlaudBrowserHandoff({ code }: { code: string | null }) {
    const [detection, setDetection] = useState<Detection>("checking");
    const [phase, setPhase] = useState<HandoffPhase>("ready");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const hasBridge = () => (readConnectorBridge()?.version ?? 0) >= 1;
        if (hasBridge()) {
            setDetection("found");
            return;
        }
        const id = window.setInterval(() => {
            if (!hasBridge()) return;
            window.clearInterval(id);
            setDetection("found");
        }, DETECT_INTERVAL_MS);
        const stop = window.setTimeout(() => {
            window.clearInterval(id);
            setDetection((current) =>
                current === "found" ? current : "missing",
            );
        }, DETECT_TIMEOUT_MS);
        return () => {
            window.clearInterval(id);
            window.clearTimeout(stop);
        };
    }, []);

    const handleContinue = useCallback(async () => {
        const bridge = readConnectorBridge();
        if (!bridge || code === null) return;
        setPhase("working");
        setError(null);
        try {
            const payload = await bridge.connect();
            const res = await fetch("/api/plaud/auth/handoff/complete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    code,
                    accessToken: payload.accessToken,
                    apiBase: payload.apiBase,
                }),
            });
            if (!res.ok) {
                const fallback =
                    res.status === 410 ? EXPIRED_FALLBACK : COMPLETE_FALLBACK;
                setError(await getApiErrorMessage(res, fallback));
                setPhase("ready");
                return;
            }
            setPhase("done");
        } catch (err) {
            setError(err instanceof Error ? err.message : COMPLETE_FALLBACK);
            setPhase("ready");
        }
    }, [code]);

    let body: ReactNode;
    if (code === null) {
        body = (
            <p className="text-sm text-muted-foreground leading-relaxed">
                This sign-in link is invalid. Start again from the OpenAudioHub
                app.
            </p>
        );
    } else if (phase === "done") {
        body = (
            <p className="text-sm text-muted-foreground leading-relaxed">
                Plaud is connected. Return to the OpenAudioHub app. You can
                close this tab.
            </p>
        );
    } else if (detection === "checking") {
        body = (
            <p className="text-sm text-muted-foreground leading-relaxed">
                Looking for the OpenAudioHub Connector…
            </p>
        );
    } else if (detection === "missing") {
        body = (
            <div className="space-y-3">
                <p className="text-sm text-muted-foreground leading-relaxed">
                    Install the OpenAudioHub Connector extension in this
                    browser, then reload this page.
                </p>
                <Button asChild className="w-full">
                    <a
                        href={CONNECTOR_INSTALL_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Install the OpenAudioHub Connector
                    </a>
                </Button>
                <Button
                    variant="outline"
                    onClick={() => window.location.reload()}
                    className="w-full"
                >
                    Reload
                </Button>
            </div>
        );
    } else {
        const working = phase === "working";
        body = (
            <div className="space-y-3">
                <p className="text-sm text-muted-foreground leading-relaxed">
                    Sign in to Plaud in this browser. If you are already signed
                    in to Google here, it usually takes one click.
                </p>
                <Button
                    onClick={handleContinue}
                    disabled={working}
                    className="w-full"
                >
                    {working
                        ? "Waiting for Plaud sign-in…"
                        : "Continue with Plaud"}
                </Button>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
            </div>
        );
    }

    return (
        <div className="w-full max-w-md space-y-6">
            <div className="flex justify-center">
                <Logo className="text-xl text-foreground" />
            </div>
            <Card className="space-y-6">
                <h1 className="text-xl font-semibold tracking-tight">
                    Connect Plaud to OpenAudioHub
                </h1>
                {body}
            </Card>
        </div>
    );
}
