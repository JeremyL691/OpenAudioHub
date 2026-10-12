"use client";

import { Bot, CheckCircle2, Mic, Sparkles } from "lucide-react";
import { PlaudConnectTabs } from "@/components/plaud-connect-tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function OnboardingStepWelcome() {
    return (
        <div className="space-y-5">
            <div className="text-center space-y-2">
                <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Mic className="size-7" />
                </div>
                <h3 className="text-[20px] font-bold tracking-tight">
                    Your AI-Powered Recording Hub
                </h3>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                    OpenAudioHub helps you manage, transcribe, and enhance your
                    Plaud recordings with AI. Let's set up your account.
                </p>
            </div>

            <div className="grid gap-3">
                <Card className="gap-0 border-0 bg-muted/60 py-4 shadow-none">
                    <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                            <Mic className="size-4" />
                            Connect Your Account
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            Sign in with your Plaud email to sync recordings
                            automatically
                        </p>
                    </CardContent>
                </Card>

                <Card className="gap-0 border-0 bg-muted/60 py-4 shadow-none">
                    <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                            <Bot className="size-4" />
                            Set Up AI Provider
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            Configure an AI provider for automatic
                            transcriptions
                        </p>
                    </CardContent>
                </Card>

                <Card className="gap-0 border-0 bg-muted/60 py-4 shadow-none">
                    <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                            <Sparkles className="size-4" />
                            Start Recording
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            You're all set! Start recording and let AI do the
                            work
                        </p>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

export function OnboardingStepPlaud({
    hasPlaudConnection,
    onReconnect,
    onConnected,
}: {
    hasPlaudConnection: boolean;
    onReconnect: () => void;
    onConnected: () => void;
}) {
    return (
        <div className="space-y-5">
            <div className="text-center space-y-2">
                <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Mic className="size-7" />
                </div>
                <h3 className="text-[20px] font-bold tracking-tight">
                    Connect Your Plaud Account
                </h3>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                    Sign in with your Plaud email to sync recordings
                    automatically
                </p>
            </div>

            {hasPlaudConnection ? (
                <Card className="border-primary/50 bg-primary/5 py-3">
                    <CardContent className="px-4">
                        <div className="flex items-center gap-3">
                            <CheckCircle2 className="size-5 text-primary" />
                            <div className="flex-1">
                                <p className="font-medium">Device Connected</p>
                                <p className="text-[13px] leading-relaxed text-muted-foreground">
                                    Your Plaud account is connected
                                </p>
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onReconnect}
                            >
                                Reconnect
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            ) : (
                <Card className="gap-0 border-0 bg-muted/60 py-4 shadow-none">
                    <CardContent className="pt-6">
                        <PlaudConnectTabs onConnected={onConnected} />
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

export function OnboardingStepAiProvider({
    hasOwnProvider,
    onGoToSettings,
}: {
    hasOwnProvider: boolean;
    onGoToSettings: () => void;
}) {
    return (
        <div className="space-y-5">
            <div className="text-center space-y-2">
                <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Bot className="size-7" />
                </div>
                <h3 className="text-[20px] font-bold tracking-tight">
                    Set Up AI Provider
                </h3>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                    Configure an AI provider to enable automatic transcriptions
                </p>
            </div>

            {hasOwnProvider ? (
                <Card className="border-primary/50 bg-primary/5 py-3">
                    <CardContent>
                        <div className="flex items-center gap-3">
                            <CheckCircle2 className="size-5 text-primary" />
                            <div className="flex-1">
                                <p className="font-medium">
                                    AI Provider Configured
                                </p>
                                <p className="text-[13px] leading-relaxed text-muted-foreground">
                                    You already have your own AI provider set up
                                </p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            ) : (
                <Card className="gap-0 border-0 bg-muted/60 py-4 shadow-none">
                    <CardContent className="pt-6 space-y-4">
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                            You can set up an AI provider later in Settings.
                            This enables automatic transcription of your
                            recordings.
                        </p>
                        <Button
                            onClick={onGoToSettings}
                            variant="outline"
                            className="w-full"
                        >
                            Go to Settings
                        </Button>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

export function OnboardingStepComplete() {
    return (
        <div className="space-y-5">
            <div className="text-center space-y-2">
                <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <CheckCircle2 className="size-7" />
                </div>
                <h3 className="text-[20px] font-bold tracking-tight">
                    You're All Set!
                </h3>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                    Start recording and let OpenAudioHub handle the rest
                </p>
            </div>

            <Card className="gap-0 border-0 bg-muted/60 py-4 shadow-none">
                <CardContent>
                    <div className="space-y-3">
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="size-5 text-primary mt-0.5" />
                            <div>
                                <p className="font-medium">
                                    Recordings sync automatically
                                </p>
                                <p className="text-[13px] leading-relaxed text-muted-foreground">
                                    Your Plaud device will sync recordings in
                                    the background
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="size-5 text-primary mt-0.5" />
                            <div>
                                <p className="font-medium">
                                    AI-powered transcriptions
                                </p>
                                <p className="text-[13px] leading-relaxed text-muted-foreground">
                                    Set up an AI provider to transcribe
                                    recordings automatically
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <CheckCircle2 className="size-5 text-primary mt-0.5" />
                            <div>
                                <p className="font-medium">
                                    Customize your experience
                                </p>
                                <p className="text-[13px] leading-relaxed text-muted-foreground">
                                    Adjust settings anytime from the Settings
                                    menu
                                </p>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
