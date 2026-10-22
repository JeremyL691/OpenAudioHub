import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ChatErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Ask AI render error:", error, errorInfo);
    }

    reset = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div
                    className="flex h-full flex-col items-center justify-center p-6 text-center"
                    data-testid="chat-error-boundary"
                >
                    <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                        <AlertCircle className="size-6" />
                    </div>
                    <h3 className="text-sm font-medium text-foreground">{t("recording.chat.errorTitle")}</h3>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                        {this.state.error?.message || t("recording.chat.errorBody")}
                    </p>
                    <Button variant="secondary" size="sm" className="mt-4 gap-1.5 text-xs" onClick={this.reset}>
                        <RefreshCw className="size-3.5" />
                        {t("recording.chat.errorRetry")}
                    </Button>
                </div>
            );
        }
        return this.props.children;
    }
}
