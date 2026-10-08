import { Button, Heading, Link, Section, Text } from "@react-email/components";
import { EmailLayout } from "./_layout";
import { emailStyles } from "./styles";

interface NewRecordingEmailProps {
    count: number;
    recordingNames?: string[];
    recordingsUrl: string;
    settingsUrl: string;
}

const EMPTY_NAMES: string[] = [];

export function NewRecordingEmail({
    count,
    recordingNames = EMPTY_NAMES,
    recordingsUrl,
    settingsUrl,
}: NewRecordingEmailProps) {
    const previewText =
        count === 1 ? "New recording synced" : `${count} new recordings synced`;

    return (
        <EmailLayout
            previewText={previewText}
            footerLink={{ href: settingsUrl, label: "Manage notifications" }}
        >
            <Heading style={emailStyles.h1}>
                {count === 1
                    ? "New recording synced"
                    : `${count} new recordings synced`}
            </Heading>

            {recordingNames.length > 0 ? (
                <>
                    <Text style={emailStyles.text}>
                        Your Plaud device has synced the following
                        {count === 1 ? " recording" : " recordings"}:
                    </Text>

                    <Section style={emailStyles.recordingList}>
                        {recordingNames.slice(0, 10).map((name, index) => (
                            <Link
                                key={name}
                                href={recordingsUrl}
                                style={{
                                    ...emailStyles.recordingItem,
                                    ...(index ===
                                    Math.min(recordingNames.length, 10) - 1
                                        ? emailStyles.recordingItemLast
                                        : {}),
                                }}
                            >
                                <Text style={emailStyles.recordingName}>
                                    {name}
                                </Text>
                            </Link>
                        ))}
                        {recordingNames.length > 10 && (
                            <Text
                                style={{
                                    ...emailStyles.recordingMeta,
                                    marginTop: "8px",
                                }}
                            >
                                +{recordingNames.length - 10} more
                            </Text>
                        )}
                    </Section>
                </>
            ) : (
                <Text style={emailStyles.text}>
                    Your Plaud device has synced{" "}
                    {count === 1
                        ? "a new recording"
                        : `${count} new recordings`}{" "}
                    to OpenAudioHub.
                </Text>
            )}

            <Section style={emailStyles.buttonSection}>
                <Button style={emailStyles.button} href={recordingsUrl}>
                    View recordings
                </Button>
            </Section>
        </EmailLayout>
    );
}
